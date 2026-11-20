defmodule ChainAutomation.Http.Client do
  @moduledoc """
  The hardened HTTP adapter of one attempt (automation.md §8.5; ADR-0012 Part 2). For each hop it checks the URL against the
  destination snapshot, resolves the host once, refuses the attempt if any address is forbidden, and connects to a checked
  address with Mint. TLS is verified against the original host. One time limit covers the attempt; the request and the
  answer have size limits; redirects are followed only when allowed, and each hop is checked again.

  The answer is `{:ok, %{status, body, bytes}}`, or `{:error, failure}` with an error class of automation-contract.md §6,
  whether it is retried, and a fixed message that names no header or body. No exception leaves `call/3`.
  """

  alias ChainAutomation.Contract.WorkRequest
  alias ChainAutomation.Http.{AddressPolicy, Destination, Request}

  @type settings :: %{
          destination: Destination.destination(),
          timeout_ms: pos_integer(),
          follow_redirects: boolean(),
          max_redirects: non_neg_integer(),
          response_type: :json | :none
        }
  @type success :: %{status: pos_integer(), body: term(), bytes: non_neg_integer()}
  @type failure :: %{
          class: atom(),
          message: String.t(),
          status: pos_integer() | nil,
          retryable: boolean(),
          retry_after: non_neg_integer() | nil,
          bytes: non_neg_integer() | nil
        }

  @retry_after_cap 60

  # An answer nested deeper could be neither stored by PostgreSQL nor read by .NET (automation-contract.md §4.2, card #191).
  @max_depth 32

  @doc "The adapter's settings for a parsed payload."
  @spec settings(WorkRequest.t()) :: settings()
  def settings(%WorkRequest{} = work) do
    %{
      destination: work.destination,
      timeout_ms: work.execution.timeout_ms,
      follow_redirects: work.execution.follow_redirects,
      max_redirects: work.execution.max_redirects,
      response_type: work.response_type
    }
  end

  @doc """
  Makes the call. Options: `:resolver`, a function of the host and a timeout in milliseconds that answers
  `{:ok, addresses}` (the system resolver by default), and `:cacerts` (the operating system's by default).
  """
  @spec call(Request.t(), settings(), keyword()) :: {:ok, success()} | {:error, failure()}
  def call(%Request{} = request, settings, opts \\ []) do
    context = %{
      settings: settings,
      deadline: now() + settings.timeout_ms,
      resolver: Keyword.get(opts, :resolver, &resolve/2),
      cacerts: opts[:cacerts]
    }

    limit = settings.destination.max_request_bytes

    if byte_size(request.body || "") > limit,
      do: failure(:request_too_large, "The request body is larger than #{limit} bytes."),
      else: hop(request, context, 0)
  rescue
    exception ->
      failure(
        :internal_error,
        "The HTTP call failed unexpectedly (#{inspect(exception.__struct__)})."
      )
  catch
    :exit, _reason -> failure(:internal_error, "The HTTP call failed unexpectedly (exit).")
  end

  @doc "Every IPv4 and IPv6 address of a host, from the system resolver."
  @spec resolve(String.t(), timeout()) :: {:ok, [:inet.ip_address()]} | {:error, :nxdomain}
  def resolve(host, timeout) do
    name = String.to_charlist(host)

    addresses =
      for family <- [:inet, :inet6],
          {:ok, found} <- [:inet.getaddrs(name, family, timeout)],
          do: found

    case List.flatten(addresses) do
      [] -> {:error, :nxdomain}
      found -> {:ok, found}
    end
  end

  defp hop(request, context, hops) do
    uri = URI.parse(request.url)

    with :ok <- check_url(request.url, context),
         {:ok, addresses} <- resolve_host(uri.host, context),
         :ok <- check_addresses(addresses, uri.host, context),
         {:ok, response} <- exchange(request, uri, addresses, context) do
      respond(response, request, uri, context, hops)
    end
  end

  defp check_url(url, context) do
    case Destination.check_url(url, context.settings.destination) do
      :ok -> :ok
      {:error, class, message} -> failure(class, message)
    end
  end

  defp resolve_host(host, context) do
    with {:ok, remaining} <- remaining(context) do
      case context.resolver.(host, remaining) do
        {:ok, [_ | _] = addresses} -> {:ok, addresses}
        _ -> failure(:connect_error, "The host '#{host}' could not be resolved.")
      end
    end
  end

  # Every address must pass: connecting to the first allowed one would leave the others to a later resolution.
  defp check_addresses(addresses, host, context) do
    Enum.find_value(addresses, :ok, fn address ->
      case AddressPolicy.check(address, context.settings.destination.internal) do
        :ok ->
          nil

        {:forbidden, category} ->
          failure(
            :ssrf_blocked,
            "The host '#{host}' resolves to #{:inet.ntoa(address)}, #{AddressPolicy.describe(category)}."
          )
      end
    end)
  end

  # The connection goes to a checked address, never to the name, so a second DNS answer cannot change it.
  defp exchange(request, uri, addresses, context) do
    {ipv4, ipv6} = Enum.split_with(addresses, &(tuple_size(&1) == 4))
    connect_any(ipv4 ++ ipv6, request, uri, context, nil)
  end

  defp connect_any([], _request, _uri, _context, last_failure), do: last_failure

  defp connect_any([address | others], request, uri, context, _last_failure) do
    case connect(address, uri, context) do
      {:ok, conn} ->
        send_request(conn, request, uri, context)

      {:error, %{class: :connect_error}} = failure ->
        connect_any(others, request, uri, context, failure)

      failure ->
        failure
    end
  end

  defp connect(address, uri, context) do
    with {:ok, remaining} <- remaining(context) do
      scheme = if uri.scheme == "https", do: :https, else: :http

      options = [
        hostname: uri.host,
        mode: :passive,
        protocols: [:http1],
        transport_opts: transport_options(scheme, remaining, context.cacerts)
      ]

      case Mint.HTTP.connect(scheme, address, uri.port, options) do
        {:ok, conn} -> {:ok, conn}
        {:error, error} -> transport_failure(error, uri.host, context)
      end
    end
  end

  defp transport_options(:https, remaining, cacerts) when is_list(cacerts),
    do: [timeout: remaining, cacerts: cacerts]

  defp transport_options(_scheme, remaining, _cacerts), do: [timeout: remaining]

  defp send_request(conn, request, uri, context) do
    headers = [{"host", host_header(uri)} | request.headers]

    case Mint.HTTP.request(conn, request.method, path_and_query(uri), headers, request.body) do
      {:ok, conn, ref} ->
        receive_response(conn, ref, uri.host, context, %{
          status: nil,
          headers: [],
          body: [],
          bytes: 0
        })

      {:error, conn, %Mint.HTTPError{reason: reason}} ->
        close(conn, unsendable(reason))

      {:error, conn, error} ->
        close(conn, transport_failure(error, uri.host, context))
    end
  end

  defp receive_response(conn, ref, host, context, acc) do
    case remaining(context) do
      {:ok, remaining} ->
        case Mint.HTTP.recv(conn, 0, remaining) do
          {:ok, conn, responses} ->
            case collect(responses, ref, host, context, acc) do
              {:more, acc} -> receive_response(conn, ref, host, context, acc)
              outcome -> close(conn, outcome)
            end

          {:error, conn, error, _responses} ->
            close(conn, transport_failure(error, host, context))
        end

      timed_out ->
        close(conn, timed_out)
    end
  end

  defp close(conn, outcome) do
    Mint.HTTP.close(conn)
    outcome
  end

  defp collect(responses, ref, host, context, acc) do
    limit = context.settings.destination.max_response_bytes

    Enum.reduce_while(responses, {:more, acc}, fn
      {:status, ^ref, status}, {:more, acc} ->
        {:cont, {:more, %{acc | status: status}}}

      {:headers, ^ref, headers}, {:more, acc} ->
        {:cont, {:more, %{acc | headers: acc.headers ++ headers}}}

      {:data, ^ref, data}, {:more, acc} ->
        bytes = acc.bytes + byte_size(data)

        if bytes > limit,
          do:
            {:halt,
             failure(:response_too_large, "The answer is larger than #{limit} bytes.",
               status: acc.status
             )},
          else: {:cont, {:more, %{acc | body: [acc.body, data], bytes: bytes}}}

      {:done, ^ref}, {:more, acc} ->
        {:halt, {:ok, %{acc | body: IO.iodata_to_binary(acc.body)}}}

      {:error, ^ref, error}, _state ->
        {:halt, transport_failure(error, host, context)}

      _other, state ->
        {:cont, state}
    end)
  end

  ## Classification (automation.md §8.2) and redirects.

  defp respond(%{status: status} = response, request, uri, context, hops)
       when status in 300..399 do
    settings = context.settings
    location = header(response.headers, "location")

    cond do
      not settings.follow_redirects ->
        failure(
          :redirect_not_allowed,
          "The target answered HTTP #{status}, and redirects are not allowed.",
          status: status
        )

      location == nil ->
        failure(:redirect_not_allowed, "The target answered HTTP #{status} without a Location.",
          status: status
        )

      hops >= settings.max_redirects ->
        failure(
          :redirect_not_allowed,
          "The target redirected more than #{settings.max_redirects} times.",
          status: status
        )

      true ->
        case location_uri(location) do
          {:ok, _} ->
            hop(redirected(request, uri, status, location), context, hops + 1)

          :error ->
            failure(
              :redirect_not_allowed,
              "The target answered HTTP #{status} with an invalid Location.",
              status: status
            )
        end
    end
  end

  defp respond(%{status: status} = response, _request, _uri, context, _hops)
       when status in 200..299 do
    case {context.settings.response_type, response.body} do
      {:none, _body} ->
        {:ok, %{status: status, body: nil, bytes: response.bytes}}

      {:json, ""} ->
        {:ok, %{status: status, body: nil, bytes: 0}}

      {:json, body} ->
        case Jason.decode(body) do
          {:ok, value} ->
            if deeper?(value, @max_depth) do
              failure(
                :invalid_response,
                "The answer is nested more than #{@max_depth} levels deep.",
                status: status,
                bytes: response.bytes
              )
            else
              {:ok, %{status: status, body: value, bytes: response.bytes}}
            end

          {:error, _} ->
            failure(:invalid_response, "The answer is not JSON.",
              status: status,
              bytes: response.bytes
            )
        end
    end
  end

  defp respond(%{status: status} = response, _request, _uri, _context, _hops) do
    retryable = status == 429 or status in 500..599

    retry_after =
      if status in [429, 503], do: retry_after(header(response.headers, "retry-after"))

    failure(:http_status, "The target answered HTTP #{status}.",
      status: status,
      retryable: retryable,
      retry_after: retry_after,
      bytes: response.bytes
    )
  end

  # Whether a decoded answer nests more than `levels` objects and arrays; each one is a level. It looks one level past the
  # limit at most.
  defp deeper?(value, levels) when is_map(value) or is_list(value),
    do: levels == 0 or Enum.any?(children(value), &deeper?(&1, levels - 1))

  defp deeper?(_scalar, _levels), do: false

  defp children(map) when is_map(map), do: Map.values(map)
  defp children(list), do: list

  # A 303, and a 301 or 302 answering a POST, become a GET without a body. On a change of host, the headers that carry a
  # secret are dropped, and so is Authorization (ADR-0012 Part 2 rule 5).
  defp redirected(request, uri, status, location) do
    target = uri |> URI.merge(location) |> URI.to_string()
    to_get? = status == 303 or (status in [301, 302] and request.method == "POST")

    {method, body, headers} =
      if to_get?,
        do: {"GET", nil, drop(request.headers, ["content-type"])},
        else: {request.method, request.body, request.headers}

    headers =
      if String.downcase(URI.parse(target).host || "") == String.downcase(uri.host),
        do: headers,
        else: drop(headers, ["authorization" | request.secret_headers])

    %{request | method: method, url: target, body: body, headers: headers}
  end

  defp drop(headers, names),
    do: Enum.reject(headers, fn {name, _} -> String.downcase(name) in names end)

  # A Location is a URI reference (RFC 9110 §10.2.2). URI.new raises on bytes that are not UTF-8, so they are refused before it
  # parses them (card #190).
  defp location_uri(location) do
    with true <- String.valid?(location),
         {:ok, uri} <- URI.new(location) do
      {:ok, uri}
    else
      _ -> :error
    end
  end

  # Seconds, or an IMF-fixdate (RFC 9110 §10.2.3, §5.6.7); capped at #{@retry_after_cap} s.
  defp retry_after(nil), do: nil

  defp retry_after(value) do
    value = String.trim(value)

    seconds =
      case Integer.parse(value) do
        {seconds, ""} when seconds >= 0 -> seconds
        _ -> seconds_until(value)
      end

    seconds && min(seconds, @retry_after_cap)
  end

  @months ~w(Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec)

  defp seconds_until(date) do
    with [_, day, month, year, hour, minute, second] <-
           Regex.run(
             ~r/\A[A-Z][a-z]{2}, (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT\z/,
             date
           ),
         month when is_integer(month) <- Enum.find_index(@months, &(&1 == month)),
         {:ok, at} <-
           NaiveDateTime.new(
             String.to_integer(year),
             month + 1,
             String.to_integer(day),
             String.to_integer(hour),
             String.to_integer(minute),
             String.to_integer(second)
           ) do
      max(NaiveDateTime.diff(at, NaiveDateTime.utc_now()), 0)
    else
      _ -> nil
    end
  end

  ## Failures. Messages are fixed sentences: a host, an address, a status or a limit, never a header or a body.

  defp transport_failure(%Mint.TransportError{reason: :timeout}, _host, context),
    do: timeout(context)

  defp transport_failure(%Mint.TransportError{reason: :closed}, host, _context),
    do: failure(:connect_error, "The connection to '#{host}' closed before the answer.")

  defp transport_failure(
         %Mint.TransportError{reason: {:tls_alert, {alert, _description}}},
         host,
         _context
       ),
       do: failure(:tls_error, "The TLS connection to '#{host}' failed (#{alert}).")

  defp transport_failure(%Mint.TransportError{reason: reason}, host, _context)
       when is_atom(reason),
       do: failure(:connect_error, "The connection to '#{host}' failed (#{reason}).")

  defp transport_failure(%Mint.TransportError{}, host, _context),
    do: failure(:connect_error, "The connection to '#{host}' failed.")

  defp transport_failure(%Mint.HTTPError{}, host, _context),
    do: failure(:invalid_response, "The answer from '#{host}' is not valid HTTP.")

  # Mint refuses some requests before sending them; the reason may hold a header's value, so only its name is kept.
  defp unsendable({:invalid_header_value, name, _value}),
    do:
      failure(
        :invalid_request,
        "The request could not be sent: the header '#{name}' has a character a header cannot carry."
      )

  defp unsendable(_reason), do: failure(:invalid_request, "The request could not be sent.")

  defp remaining(context) do
    case context.deadline - now() do
      remaining when remaining > 0 -> {:ok, remaining}
      _ -> timeout(context)
    end
  end

  defp timeout(context),
    do: failure(:timeout, "The attempt did not finish within #{context.settings.timeout_ms} ms.")

  defp failure(class, message, details \\ []) do
    {:error,
     %{
       class: class,
       message: message,
       status: details[:status],
       retryable:
         Keyword.get(details, :retryable, class in [:timeout, :connect_error, :internal_error]),
       retry_after: details[:retry_after],
       bytes: details[:bytes]
     }}
  end

  defp header(headers, name),
    do: Enum.find_value(headers, fn {key, value} -> if key == name, do: value end)

  defp host_header(%URI{host: host, port: port, scheme: scheme}),
    do: if(port == Destination.default_port(scheme), do: host, else: "#{host}:#{port}")

  defp path_and_query(%URI{path: path, query: nil}), do: path || "/"
  defp path_and_query(%URI{path: path, query: query}), do: "#{path || "/"}?#{query}"

  defp now, do: System.monotonic_time(:millisecond)
end
