defmodule ChainAutomation.Http.Request do
  @moduledoc """
  The HTTP request of one attempt (automation-contract.md §3, "Building the request"): the payload's request with each
  `{{secret:name}}` placeholder replaced by the secret's value, `basicAuth` as an `Authorization` header, and the
  idempotency key last. The values live in memory for this attempt only, and `inspect/1` never shows them.
  """

  alias ChainAutomation.Contract.WorkRequest

  @derive {Inspect, only: [:method, :url]}
  @enforce_keys [:method, :url, :headers, :body]
  defstruct @enforce_keys ++ [secret_headers: []]

  @type t :: %__MODULE__{
          method: String.t(),
          url: String.t(),
          headers: [{String.t(), String.t()}],
          body: String.t() | nil,
          secret_headers: [String.t()]
        }
  @type error :: {:error, :secret_missing | :secret_not_allowed | :invalid_request, String.t()}

  @doc "Builds the request from a parsed payload and the decrypted values of its `secrets`, by name."
  @spec build(WorkRequest.t(), %{String.t() => String.t()}) :: {:ok, t()} | error()
  def build(%WorkRequest{} = work, secrets) do
    with {:ok, headers} <- substitute_headers(work.headers, secrets),
         {:ok, authorization} <- authorization(work.basic_auth, secrets) do
      idempotency = if work.idempotency, do: [work.idempotency], else: []

      {:ok,
       %__MODULE__{
         method: work.method,
         url: work.url,
         headers: headers ++ authorization ++ idempotency,
         body: work.body,
         secret_headers: secret_headers(work)
       }}
    end
  end

  # The headers a redirect to another host must drop (automation.md §8.5): those with a placeholder, and Authorization.
  defp secret_headers(work) do
    with_secrets =
      for {name, value} <- work.headers,
          String.contains?(value, "{{secret:"),
          do: String.downcase(name)

    if work.basic_auth, do: with_secrets ++ ["authorization"], else: with_secrets
  end

  defp substitute_headers(headers, secrets) do
    Enum.reduce_while(headers, {:ok, []}, fn {name, value}, {:ok, built} ->
      case substitute(value, secrets, &header_safe/2) do
        {:ok, value} -> {:cont, {:ok, built ++ [{name, value}]}}
        error -> {:halt, error}
      end
    end)
  end

  defp authorization(nil, _secrets), do: {:ok, []}

  defp authorization({username, password}, secrets) do
    with {:ok, username} <- substitute(username, secrets, &credential_safe/2),
         {:ok, password} <- substitute(password, secrets, &credential_safe/2) do
      if String.contains?(username, ":"),
        do: {:error, :invalid_request, "The basic-auth username cannot contain ':' (RFC 7617)."},
        else: {:ok, [{"Authorization", "Basic " <> Base.encode64(username <> ":" <> password)}]}
    end
  end

  # Base64 carries any text, but RFC 7617 forbids control characters in the user-id and the password: C0, DEL and C1, as
  # AU008 reads them at publish (card #128). Without the u flag the regex reads bytes, and in UTF-8 a C1 control is C2 80–9F.
  defp credential_safe(name, value) do
    if Regex.match?(~r/[\x00-\x1F\x7F]|\xC2[\x80-\x9F]/, value),
      do:
        {:error, :secret_not_allowed,
         "The secret '#{name}' has a control character, which basic authentication cannot carry (RFC 7617)."},
      else: :ok
  end

  # A header carries only visible ASCII, spaces and tabs: a CR or LF could add a header of its own.
  defp header_safe(name, value) do
    if WorkRequest.header_value?(value),
      do: :ok,
      else:
        {:error, :secret_not_allowed,
         "The secret '#{name}' has a character a header cannot carry (only visible ASCII, spaces and tabs)."}
  end

  # WorkRequest.parse/1 already refused malformed placeholders, so every one here is complete.
  defp substitute(text, secrets, check) do
    {:ok, names} = WorkRequest.scan_placeholders(text)

    names
    |> Enum.uniq()
    |> Enum.reduce_while({:ok, %{}}, fn name, {:ok, values} ->
      with {:ok, value} <- fetch(secrets, name),
           :ok <- check.(name, value) do
        {:cont, {:ok, Map.put(values, name, value)}}
      else
        error -> {:halt, error}
      end
    end)
    |> case do
      {:ok, values} -> {:ok, WorkRequest.replace_placeholders(text, &Map.fetch!(values, &1))}
      error -> error
    end
  end

  defp fetch(secrets, name) do
    case Map.fetch(secrets, name) do
      {:ok, value} -> {:ok, value}
      :error -> {:error, :secret_missing, "The secret '#{name}' does not exist."}
    end
  end
end
