defmodule ChainAutomation.Http.Internal do
  @moduledoc """
  A JSON `POST` to an address the operator configured, the API's internal listener, rather than one a modeler chose: the
  address policy of automation.md §8.5 does not apply. TLS is verified when the URL is `https`. Errors name a reason,
  never a header, so the token stays out of them.
  """

  @spec post_json(String.t(), String.t(), iodata(), pos_integer()) ::
          {:ok, pos_integer()} | {:error, String.t()}
  def post_json(url, token, body, timeout_ms) do
    uri = URI.parse(url)
    scheme = if uri.scheme == "https", do: :https, else: :http
    deadline = System.monotonic_time(:millisecond) + timeout_ms
    headers = [{"content-type", "application/json"}, {"authorization", "Bearer " <> token}]
    path = if uri.query, do: "#{uri.path}?#{uri.query}", else: uri.path || "/"

    with {:ok, conn} <-
           Mint.HTTP.connect(scheme, uri.host, uri.port,
             mode: :passive,
             protocols: [:http1],
             transport_opts: [timeout: timeout_ms]
           ) do
      case Mint.HTTP.request(conn, "POST", path, headers, body) do
        {:ok, conn, ref} -> status(conn, ref, deadline, nil)
        {:error, conn, error} -> close(conn, {:error, reason(error)})
      end
    else
      {:error, error} -> {:error, reason(error)}
    end
  end

  defp status(conn, ref, deadline, status) do
    remaining = deadline - System.monotonic_time(:millisecond)

    if remaining <= 0 do
      close(conn, {:error, "timeout"})
    else
      case Mint.HTTP.recv(conn, 0, remaining) do
        {:ok, conn, responses} ->
          status =
            Enum.find_value(responses, status, fn
              {:status, ^ref, code} -> code
              _ -> nil
            end)

          if Enum.any?(responses, &match?({:done, ^ref}, &1)),
            do: close(conn, {:ok, status}),
            else: status(conn, ref, deadline, status)

        {:error, conn, error, _responses} ->
          close(conn, {:error, reason(error)})
      end
    end
  end

  defp close(conn, result) do
    Mint.HTTP.close(conn)
    result
  end

  defp reason(%Mint.TransportError{reason: {:tls_alert, {alert, _}}}), do: "TLS #{alert}"

  defp reason(%Mint.TransportError{reason: reason}) when is_atom(reason),
    do: Atom.to_string(reason)

  defp reason(_error), do: "the request failed"
end
