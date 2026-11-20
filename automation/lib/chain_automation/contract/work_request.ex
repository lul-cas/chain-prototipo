defmodule ChainAutomation.Contract.WorkRequest do
  @moduledoc """
  The work-request payload of automation-contract.md §3, with the checks Elixir makes before each attempt ("Elixir's
  checks"). `parse/1` takes the decoded JSON, with string keys. A payload that breaks the contract is `invalid_request`,
  which is permanent. Messages name fields and headers, never values: a literal header value may be a credential.
  """

  @derive {Inspect, except: [:headers, :basic_auth, :body]}
  @enforce_keys [
    :request_id,
    :instance_id,
    :node_id,
    :activation,
    :automation,
    :destination,
    :method,
    :url,
    :headers,
    :basic_auth,
    :body,
    :secrets,
    :response_type,
    :execution,
    :idempotency,
    :deadline_at,
    :correlation_id,
    :traceparent
  ]
  defstruct @enforce_keys

  @type t :: %__MODULE__{}
  @type error :: {:error, :invalid_request, String.t()}

  @forbidden_headers ~w(host content-length transfer-encoding connection upgrade te trailer)

  @fields [
    {"contractVersion", {:const, 1}},
    {"requestId", :uuid},
    {"instanceId", :uuid},
    {"nodeId", :text},
    {"activation", {:int, 1, nil}},
    {"automation", {:object, [{"id", :uuid}, {"version", {:int, 1, nil}}, {"name", :text}]}},
    {"destination",
     {:object,
      [
        {"name", :text},
        {"scheme", {:enum, ["https", "http"]}},
        {"host", :text},
        {"port", {:nullable, {:int, 1, 65_535}}},
        {"pathPrefix", {:nullable, :text}},
        {"internal", :boolean},
        {"allowSecretsOverHttp", :boolean},
        {"maxRequestBytes", {:int, 1024, 10_485_760}},
        {"maxResponseBytes", {:int, 1024, 10_485_760}}
      ]}},
    {"request",
     {:object,
      [
        {"method", {:enum, ["GET", "POST", "PUT", "PATCH", "DELETE"]}},
        {"url", :text},
        {"headers", :headers},
        {"basicAuth", {:nullable, {:object, [{"username", :text}, {"password", :text}]}}},
        {"body", {:nullable, :string}}
      ]}},
    {"secrets", :secret_names},
    {"response", {:object, [{"type", {:enum, ["json", "none"]}}]}},
    {"execution",
     {:object,
      [
        {"timeoutMs", {:int, 1_000, 300_000}},
        {"maxAttempts", {:int, 1, 10}},
        {"initialDelayMs", {:int, 1_000, 60_000}},
        {"followRedirects", :boolean},
        {"maxRedirects", {:int, 0, 3}}
      ]}},
    {"idempotency", {:nullable, {:object, [{"header", :token}, {"key", :uuid}]}}},
    {"deadlineAt", :utc_instant},
    {"correlationId", :trace_id},
    {"traceparent", {:nullable, :traceparent}}
  ]

  @spec parse(term()) :: {:ok, t()} | error()
  def parse(payload) when is_map(payload) do
    with :ok <- check_object(payload, @fields, []),
         :ok <- check_destination(payload["destination"]),
         :ok <- check_redirects(payload["execution"]),
         :ok <- check_headers(payload["request"], payload["idempotency"]),
         {:ok, used} <- placeholders(payload["request"]),
         :ok <- check_secrets(used, payload["secrets"]) do
      {:ok, build(payload)}
    end
  end

  def parse(_payload), do: invalid("The payload must be a JSON object.")

  @doc "The names of the complete placeholders in a value, or `:malformed` when anything else in it starts like one (§3)."
  @spec scan_placeholders(String.t()) :: {:ok, [String.t()]} | :malformed
  def scan_placeholders(value) do
    if value |> String.replace(placeholder(), "") |> String.contains?("{{secret:"),
      do: :malformed,
      else: {:ok, placeholder() |> Regex.scan(value, capture: :all_but_first) |> List.flatten()}
  end

  @doc "Replaces every complete placeholder in one pass, so text that a replacement brings in is never expanded again."
  @spec replace_placeholders(String.t(), (String.t() -> String.t())) :: String.t()
  def replace_placeholders(value, replacement),
    do: Regex.replace(placeholder(), value, fn _, name -> replacement.(name) end)

  defp placeholder, do: ~r/\{\{secret:([a-z0-9][a-z0-9_.-]{0,63})\}\}/

  ## The shape: every field present with its type, nothing else.

  defp check_object(object, fields, path) do
    known = Enum.map(fields, &elem(&1, 0))

    Enum.find_value(fields, fn {key, type} ->
      field = path ++ [key]

      cond do
        not Map.has_key?(object, key) ->
          invalid("The field '#{Enum.join(field, ".")}' is missing.")

        true ->
          problem(check(object[key], type, field))
      end
    end) ||
      case Enum.find(Map.keys(object) |> Enum.sort(), &(&1 not in known)) do
        nil ->
          :ok

        key ->
          invalid(
            "The field '#{Enum.join(path ++ [key], ".")}' is not part of contract version 1."
          )
      end
  end

  defp problem(:ok), do: nil
  defp problem(error), do: error

  defp check(nil, {:nullable, _type}, _field), do: :ok

  defp check(value, {:nullable, {:object, _fields} = type}, field) when is_map(value),
    do: check(value, type, field)

  defp check(value, {:object, fields}, field) when is_map(value),
    do: check_object(value, fields, field)

  defp check(value, type, field),
    do: if(valid?(value, type), do: :ok, else: invalid(field_message(field, type)))

  defp valid?(value, {:nullable, type}), do: valid?(value, type)
  defp valid?(value, {:const, expected}), do: value === expected

  defp valid?(value, :uuid),
    do:
      is_binary(value) and Regex.match?(~r/\A[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\z/i, value)

  defp valid?(value, :text), do: is_binary(value) and value != ""
  defp valid?(value, :string), do: is_binary(value)

  defp valid?(value, {:int, min, max}),
    do: is_integer(value) and value >= min and (max == nil or value <= max)

  defp valid?(value, :boolean), do: is_boolean(value)
  defp valid?(value, {:enum, values}), do: value in values
  defp valid?(_value, {:object, _fields}), do: false
  defp valid?(value, :token), do: token?(value) and byte_size(value) <= 100

  defp valid?(value, :trace_id),
    do: is_binary(value) and Regex.match?(~r/\A[0-9a-f]{32}\z/, value)

  defp valid?(value, :traceparent),
    do:
      is_binary(value) and
        Regex.match?(~r/\A[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}\z/, value)

  defp valid?(value, :headers),
    do:
      is_list(value) and
        Enum.all?(value, &match?([name, text] when is_binary(name) and is_binary(text), &1))

  defp valid?(value, :secret_names),
    do:
      is_list(value) and
        Enum.all?(value, &(is_binary(&1) and Regex.match?(~r/\A[a-z0-9][a-z0-9_.-]{0,63}\z/, &1)))

  defp valid?(value, :utc_instant),
    do: is_binary(value) and match?({:ok, _, 0}, DateTime.from_iso8601(value))

  defp field_message(field, type),
    do: "The field '#{Enum.join(field, ".")}' #{expectation(type)}."

  defp expectation({:nullable, type}), do: expectation(type) <> ", or null"
  defp expectation({:const, expected}), do: "must be #{expected}"
  defp expectation(:uuid), do: "must be a UUID"
  defp expectation(:text), do: "must be non-empty text"
  defp expectation(:string), do: "must be text"
  defp expectation({:int, min, nil}), do: "must be an integer of at least #{min}"
  defp expectation({:int, min, max}), do: "must be an integer from #{min} to #{max}"
  defp expectation(:boolean), do: "must be true or false"
  defp expectation({:enum, values}), do: "must be one of #{Enum.join(values, ", ")}"
  defp expectation({:object, _fields}), do: "must be an object"
  defp expectation(:token), do: "must be an HTTP token of at most 100 characters"
  defp expectation(:trace_id), do: "must be 32 lowercase hex digits"
  defp expectation(:traceparent), do: "must be a W3C traceparent"
  defp expectation(:headers), do: "must be a list of [name, value] pairs of text"
  defp expectation(:secret_names), do: "must be a list of secret names"
  defp expectation(:utc_instant), do: "must be an ISO 8601 instant in UTC"

  ## The rules that span fields.

  defp check_destination(%{"scheme" => "http", "internal" => false}),
    do: invalid("The field 'destination.scheme' may be 'http' only for an internal destination.")

  defp check_destination(_destination), do: :ok

  defp check_redirects(%{"followRedirects" => follow, "maxRedirects" => max})
       when (follow and max >= 1) or (not follow and max == 0),
       do: :ok

  defp check_redirects(_execution),
    do:
      invalid(
        "The field 'execution.maxRedirects' must be 0 without followRedirects, and 1 to 3 with it."
      )

  # The names Elixir sends (automation.md AU006): tokens, none forbidden, unique ignoring case, and values a header can
  # carry. Authorization and the idempotency header are added by Elixir, so the payload may not set them as well.
  defp check_headers(request, idempotency) do
    added =
      [
        if(request["basicAuth"], do: {"Authorization", :basic_auth}),
        if(idempotency, do: {idempotency["header"], :idempotency})
      ]
      |> Enum.reject(&is_nil/1)

    # The added names come first, so a payload header that repeats one is reported with the payload's spelling.
    Enum.reduce_while(
      Enum.map(added, fn {name, _} -> [name, ""] end) ++ request["headers"],
      MapSet.new(),
      fn [name, value], seen ->
        lower = String.downcase(name)

        cond do
          not token?(name) ->
            {:halt, invalid("A header name is not an HTTP token.")}

          lower in @forbidden_headers or String.starts_with?(lower, "proxy-") ->
            {:halt, invalid("The header '#{name}' cannot be set by an automation.")}

          MapSet.member?(seen, lower) ->
            {:halt, invalid(duplicate_message(name, lower, added))}

          not header_value?(value) ->
            {:halt,
             invalid("The value of the header '#{name}' has a character a header cannot carry.")}

          true ->
            {:cont, MapSet.put(seen, lower)}
        end
      end
    )
    |> case do
      %MapSet{} -> :ok
      error -> error
    end
  end

  defp duplicate_message(name, lower, added) do
    case Enum.find(added, fn {added_name, _} -> String.downcase(added_name) == lower end) do
      {_, :idempotency} ->
        "The header '#{name}' is the idempotency header, which is added from 'idempotency'."

      {_, :basic_auth} ->
        "The header '#{name}' cannot be set together with basicAuth."

      nil ->
        "The header '#{name}' appears twice."
    end
  end

  @doc "Whether a header can carry the text: visible ASCII, spaces and tabs (RFC 9110 field values without obs-text)."
  @spec header_value?(String.t()) :: boolean()
  def header_value?(value), do: Regex.match?(~r/\A[\t\x20-\x7E]*\z/, value)

  defp token?(value),
    do: is_binary(value) and Regex.match?(~r/\A[!#$%&'*+\-.^_`|~0-9A-Za-z]+\z/, value)

  defp placeholders(request) do
    values =
      Enum.map(request["headers"], fn [name, value] -> {"the header '#{name}'", value} end) ++
        case request["basicAuth"] do
          nil ->
            []

          auth ->
            [{"basic-auth username", auth["username"]}, {"basic-auth password", auth["password"]}]
        end

    Enum.reduce_while(values, {:ok, []}, fn {where, value}, {:ok, used} ->
      case scan_placeholders(value) do
        {:ok, names} -> {:cont, {:ok, used ++ names}}
        :malformed -> {:halt, invalid(malformed_message(where))}
      end
    end)
  end

  defp malformed_message("the header" <> _ = where),
    do: "The value of #{where} has a malformed secret placeholder."

  defp malformed_message(where), do: "The #{where} has a malformed secret placeholder."

  defp check_secrets(used, secrets) do
    if used |> Enum.uniq() |> Enum.sort() == secrets,
      do: :ok,
      else:
        invalid(
          "The field 'secrets' must list exactly the secrets the placeholders use, in ordinal order, once each."
        )
  end

  defp invalid(message), do: {:error, :invalid_request, message}

  defp build(payload) do
    %{
      "automation" => automation,
      "destination" => destination,
      "request" => request,
      "execution" => execution
    } = payload

    {:ok, deadline_at, 0} = DateTime.from_iso8601(payload["deadlineAt"])

    %__MODULE__{
      request_id: payload["requestId"],
      instance_id: payload["instanceId"],
      node_id: payload["nodeId"],
      activation: payload["activation"],
      automation: %{
        id: automation["id"],
        version: automation["version"],
        name: automation["name"]
      },
      destination: %{
        name: destination["name"],
        scheme: destination["scheme"],
        host: destination["host"],
        port: destination["port"],
        path_prefix: destination["pathPrefix"],
        internal: destination["internal"],
        allow_secrets_over_http: destination["allowSecretsOverHttp"],
        max_request_bytes: destination["maxRequestBytes"],
        max_response_bytes: destination["maxResponseBytes"]
      },
      method: request["method"],
      url: request["url"],
      headers: Enum.map(request["headers"], fn [name, value] -> {name, value} end),
      basic_auth:
        request["basicAuth"] &&
          {request["basicAuth"]["username"], request["basicAuth"]["password"]},
      body: request["body"],
      secrets: payload["secrets"],
      response_type: if(payload["response"]["type"] == "json", do: :json, else: :none),
      execution: %{
        timeout_ms: execution["timeoutMs"],
        max_attempts: execution["maxAttempts"],
        initial_delay_ms: execution["initialDelayMs"],
        follow_redirects: execution["followRedirects"],
        max_redirects: execution["maxRedirects"]
      },
      idempotency:
        payload["idempotency"] &&
          {payload["idempotency"]["header"], payload["idempotency"]["key"]},
      deadline_at: deadline_at,
      correlation_id: payload["correlationId"],
      traceparent: payload["traceparent"]
    }
  end
end
