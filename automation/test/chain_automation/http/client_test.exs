defmodule ChainAutomation.Http.ClientTest do
  use ExUnit.Case, async: true

  alias ChainAutomation.Http.{Client, Request}
  alias ChainAutomation.StubServer

  @host "stub.internal.test"
  @json [{"content-type", "application/json"}]

  defp settings(server, overrides \\ []) do
    destination = %{
      name: "stub",
      scheme: "http",
      host: @host,
      port: server.port,
      path_prefix: "/v1",
      internal: true,
      max_request_bytes: 1024,
      max_response_bytes: 1024
    }

    Map.merge(
      %{
        destination: destination,
        timeout_ms: 2_000,
        follow_redirects: false,
        max_redirects: 0,
        response_type: :json
      },
      Map.new(overrides)
    )
  end

  defp request(server, overrides \\ []) do
    struct!(
      %Request{
        method: "POST",
        url: "http://#{@host}:#{server.port}/v1/consultas?origem=chain",
        headers: [{"Accept", "application/json"}, {"X-Api-Key", "segredo"}],
        body: ~s({"cpf":"1"}),
        secret_headers: ["x-api-key"]
      },
      overrides
    )
  end

  defp call(server, request, settings, opts \\ []) do
    resolver = fn host, _timeout ->
      if host == @host, do: {:ok, [server.ip]}, else: {:error, :nxdomain}
    end

    Client.call(request, settings, Keyword.put_new(opts, :resolver, resolver))
  end

  defp failure(class, message, extra) do
    Map.merge(
      %{class: class, message: message, status: nil, retry_after: nil, bytes: nil},
      Map.new(extra)
    )
  end

  test "the call goes to the checked address with the original host, and a JSON answer is parsed" do
    server = StubServer.start!(fn _ -> {200, @json, ~s({"situacao":"regular"})} end)

    assert call(server, request(server), settings(server)) ==
             {:ok, %{status: 200, body: %{"situacao" => "regular"}, bytes: 22}}

    assert_received {:stub_request,
                     %{
                       method: "POST",
                       path: "/v1/consultas?origem=chain",
                       headers: headers,
                       body: ~s({"cpf":"1"})
                     }}

    assert {"host", "#{@host}:#{server.port}"} in headers
    assert {"x-api-key", "segredo"} in headers
    refute List.keymember?(headers, "accept-encoding", 0)
  end

  test "an empty JSON answer is null, and the type none discards the body" do
    empty = StubServer.start!(fn _ -> {200, [], ""} end)

    assert call(empty, request(empty), settings(empty)) ==
             {:ok, %{status: 200, body: nil, bytes: 0}}

    text = StubServer.start!(fn _ -> {200, [], "ignored"} end)

    assert call(text, request(text), settings(text, response_type: :none)) ==
             {:ok, %{status: 200, body: nil, bytes: 7}}
  end

  test "a non-JSON answer is invalid_response, which is not retried" do
    server = StubServer.start!(fn _ -> {200, [], "<html>"} end)

    assert call(server, request(server), settings(server)) ==
             {:error,
              failure(:invalid_response, "The answer is not JSON.",
                status: 200,
                bytes: 6,
                retryable: false
              )}
  end

  # Card #181: the answer is stored in PostgreSQL before it reaches .NET. Text that is not Unicode never gets that far, because
  # Jason refuses it. A NUL written \u0000 is valid JSON: it is kept, stored as json, and judged by .NET (automation.md §8.5).
  test "an answer with text that is not Unicode is invalid_response; a NUL written \\u0000 is kept" do
    for answer <- [
          ~S({"situacao":"regu\ud800lar"}),
          ~S({"situacao":"regu\udc00lar"}),
          ~S({"nota\ud800":1}),
          "{\"situacao\":\"regu" <> <<0>> <> "lar\"}",
          "{\"situacao\":\"regu" <> <<0xFF>> <> "lar\"}",
          "{\"situacao\":\"regu" <> <<0xED, 0xA0, 0x80>> <> "lar\"}"
        ] do
      server = StubServer.start!(fn _ -> {200, @json, answer} end)

      assert call(server, request(server), settings(server)) ==
               {:error,
                failure(:invalid_response, "The answer is not JSON.",
                  status: 200,
                  bytes: byte_size(answer),
                  retryable: false
                )},
             inspect(answer, binaries: :as_binaries)
    end

    nul = StubServer.start!(fn _ -> {200, @json, ~S({"situacao":"regu\u0000lar"})} end)

    assert {:ok, %{status: 200, body: %{"situacao" => "regu\u0000lar"}}} =
             call(nul, request(nul), settings(nul))
  end

  # Card #191: PostgreSQL stores, and .NET reads, JSON nested far less deep than Jason decodes, so the answer has one depth
  # limit (automation-contract.md §4.2). Each object or array is one level.
  test "an answer nested more than 32 levels deep is invalid_response; 32 levels are parsed" do
    arrays = fn levels -> String.duplicate("[", levels) <> String.duplicate("]", levels) end

    objects = fn levels ->
      String.duplicate(~s({"a":), levels - 1) <> "{}" <> String.duplicate("}", levels - 1)
    end

    for answer <- [arrays.(32), objects.(32)] do
      server = StubServer.start!(fn _ -> {200, @json, answer} end)

      assert {:ok, %{status: 200, body: body}} = call(server, request(server), settings(server))
      assert Jason.encode!(body) == answer
    end

    for answer <- [arrays.(33), objects.(33), ~s({"a":1,"b":) <> arrays.(32) <> "}"] do
      server = StubServer.start!(fn _ -> {200, @json, answer} end)

      assert call(server, request(server), settings(server)) ==
               {:error,
                failure(:invalid_response, "The answer is nested more than 32 levels deep.",
                  status: 200,
                  bytes: byte_size(answer),
                  retryable: false
                )},
             answer
    end
  end

  test "429 and 5xx are retried; Retry-After counts on 429 and 503, capped at 60 s; other statuses are not retried" do
    for {status, headers, retryable, retry_after} <- [
          {404, [{"retry-after", "5"}], false, nil},
          {400, [], false, nil},
          {429, [{"retry-after", "5"}], true, 5},
          {503, [{"retry-after", "600"}], true, 60},
          {503, [{"retry-after", "soon"}], true, nil},
          {500, [{"retry-after", "5"}], true, nil},
          {502, [], true, nil}
        ] do
      server = StubServer.start!(fn _ -> {status, headers, "x"} end)

      assert call(server, request(server), settings(server)) ==
               {:error,
                failure(:http_status, "The target answered HTTP #{status}.",
                  status: status,
                  bytes: 1,
                  retryable: retryable,
                  retry_after: retry_after
                )},
             "#{status}"
    end
  end

  test "Retry-After may be an HTTP date" do
    at = DateTime.utc_now() |> DateTime.add(30) |> Calendar.strftime("%a, %d %b %Y %H:%M:%S GMT")
    server = StubServer.start!(fn _ -> {429, [{"retry-after", at}], ""} end)

    assert {:error, %{retry_after: seconds}} = call(server, request(server), settings(server))
    assert seconds in 27..30
  end

  test "the answer is read up to maxResponseBytes; one more byte is response_too_large" do
    at_limit = StubServer.start!(fn _ -> {200, [], String.duplicate("a", 1024)} end)

    assert call(at_limit, request(at_limit), settings(at_limit, response_type: :none)) ==
             {:ok, %{status: 200, body: nil, bytes: 1024}}

    over = StubServer.start!(fn _ -> {200, [], String.duplicate("a", 1025)} end)

    assert call(over, request(over), settings(over, response_type: :none)) ==
             {:error,
              failure(:response_too_large, "The answer is larger than 1024 bytes.",
                status: 200,
                retryable: false
              )}
  end

  test "a body over maxRequestBytes is not sent" do
    server = StubServer.start!(fn _ -> {200, [], ""} end)
    request = request(server, body: String.duplicate("a", 1025))

    assert call(server, request, settings(server)) ==
             {:error,
              failure(:request_too_large, "The request body is larger than 1024 bytes.",
                retryable: false
              )}

    refute_receive {:stub_request, _}, 100
  end

  test "the attempt has one time limit" do
    server = StubServer.start!(fn _ -> {:delay, 1_000, {200, [], "{}"}} end)

    assert call(server, request(server), settings(server, timeout_ms: 300)) ==
             {:error,
              failure(:timeout, "The attempt did not finish within 300 ms.", retryable: true)}
  end

  test "a refused connection, a connection closed before the answer and a host that does not resolve are connect_error" do
    refused = %{ip: StubServer.private_address!(), port: StubServer.closed_port!()}

    assert call(refused, request(refused), settings(refused)) ==
             {:error,
              failure(:connect_error, "The connection to '#{@host}' failed (econnrefused).",
                retryable: true
              )}

    closing = StubServer.start!(fn _ -> :close end)

    assert call(closing, request(closing), settings(closing)) ==
             {:error,
              failure(:connect_error, "The connection to '#{@host}' closed before the answer.",
                retryable: true
              )}

    assert call(closing, request(closing), settings(closing),
             resolver: fn _, _ -> {:error, :nxdomain} end
           ) ==
             {:error,
              failure(:connect_error, "The host '#{@host}' could not be resolved.",
                retryable: true
              )}
  end

  test "every resolved address must pass the policy, or the attempt is ssrf_blocked before any connection" do
    server = StubServer.start!(fn _ -> {200, [], "{}"} end)
    private = server.ip |> :inet.ntoa() |> to_string()

    for {addresses, internal, said} <- [
          {[{127, 0, 0, 1}], true, "127.0.0.1, a loopback address"},
          {[{169, 254, 169, 254}], true, "169.254.169.254, a link-local address"},
          {[server.ip], false, "#{private}, a private address"},
          {[server.ip, {0, 0, 0, 0, 0, 0xFFFF, 0x7F00, 1}], true,
           "::ffff:127.0.0.1, a loopback address"}
        ] do
      settings = put_in(settings(server), [:destination, :internal], internal)

      assert call(server, request(server), settings, resolver: fn _, _ -> {:ok, addresses} end) ==
               {:error,
                failure(:ssrf_blocked, "The host '#{@host}' resolves to #{said}.",
                  retryable: false
                )}
    end

    refute_receive {:stub_request, _}, 100
  end

  test "the host is resolved once per hop, and the connection goes to the checked address (DNS rebinding)" do
    server = StubServer.start!(fn _ -> {200, @json, "{}"} end)
    test = self()
    {:ok, answers} = Agent.start_link(fn -> [[server.ip], [{127, 0, 0, 1}]] end)

    resolver = fn host, _timeout ->
      send(test, {:resolved, host})
      {:ok, Agent.get_and_update(answers, fn [first | rest] -> {first, rest} end)}
    end

    assert {:ok, %{status: 200}} =
             call(server, request(server), settings(server), resolver: resolver)

    assert_received {:resolved, @host}
    refute_received {:resolved, _}
  end

  test "a URL outside the destination is destination_denied, before anything is resolved" do
    server = StubServer.start!(fn _ -> {200, [], "{}"} end)
    test = self()
    resolver = fn host, _timeout -> send(test, {:resolved, host}) && {:ok, [server.ip]} end

    assert call(
             server,
             request(server, url: "http://other.test:#{server.port}/v1/x"),
             settings(server),
             resolver: resolver
           ) ==
             {:error,
              failure(
                :destination_denied,
                "The URL does not match the destination 'stub': the host 'other.test'.",
                retryable: false
              )}

    refute_received {:resolved, _}
  end

  describe "redirects" do
    defp wildcard(server, overrides) do
      settings = settings(server, [follow_redirects: true, max_redirects: 3] ++ overrides)
      put_in(settings, [:destination, :host], "*.stub.test")
    end

    defp hosts(server, forbidden \\ %{}) do
      fn host, _timeout -> {:ok, [Map.get(forbidden, host, server.ip)]} end
    end

    defp url(server, host, path), do: "http://#{host}:#{server.port}#{path}"

    test "without followRedirects, a 3xx is redirect_not_allowed" do
      server = StubServer.start!(fn _ -> {302, [{"location", "/v1/next"}], ""} end)

      assert call(server, request(server), settings(server)) ==
               {:error,
                failure(
                  :redirect_not_allowed,
                  "The target answered HTTP 302, and redirects are not allowed.",
                  status: 302,
                  retryable: false
                )}
    end

    test "a followed redirect keeps the secrets on the same host; a 303 becomes a GET without a body, a 307 keeps the method" do
      server =
        StubServer.start!(fn
          %{path: "/v1/see-other"} -> {303, [{"location", "/v1/final"}], ""}
          %{path: "/v1/temporary"} -> {307, [{"location", "/v1/final"}], ""}
          %{path: "/v1/final"} -> {200, @json, ~s({"ok":true})}
        end)

      settings = settings(server, follow_redirects: true, max_redirects: 3)
      see_other = request(server, url: "http://#{@host}:#{server.port}/v1/see-other")

      assert {:ok, %{status: 200, body: %{"ok" => true}}} = call(server, see_other, settings)
      assert_received {:stub_request, %{method: "POST", path: "/v1/see-other"}}

      assert_received {:stub_request,
                       %{method: "GET", path: "/v1/final", body: "", headers: headers}}

      assert {"x-api-key", "segredo"} in headers

      temporary = request(server, url: "http://#{@host}:#{server.port}/v1/temporary")
      assert {:ok, %{status: 200}} = call(server, temporary, settings)
      assert_received {:stub_request, %{method: "POST", path: "/v1/temporary"}}
      assert_received {:stub_request, %{method: "POST", path: "/v1/final", body: ~s({"cpf":"1"})}}
    end

    test "a redirect to another host drops the headers that carry a secret, and Authorization" do
      server =
        StubServer.start!(fn
          %{path: "/v1/start", headers: headers} ->
            [_, port] = headers |> List.keyfind("host", 0) |> elem(1) |> String.split(":")
            {302, [{"location", "http://b.stub.test:#{port}/v1/final"}], ""}

          %{path: "/v1/final"} ->
            {200, @json, "{}"}
        end)

      request =
        request(server,
          url: url(server, "a.stub.test", "/v1/start"),
          headers: [
            {"Accept", "application/json"},
            {"X-Api-Key", "segredo"},
            {"Authorization", "Basic eHl6"}
          ],
          secret_headers: ["x-api-key"]
        )

      assert {:ok, %{status: 200}} =
               call(server, request, wildcard(server, []), resolver: hosts(server))

      assert_received {:stub_request, %{path: "/v1/start", headers: first}}
      assert {"x-api-key", "segredo"} in first
      assert_received {:stub_request, %{path: "/v1/final", headers: second}}
      assert {"accept", "application/json"} in second
      refute List.keymember?(second, "x-api-key", 0)
      refute List.keymember?(second, "authorization", 0)
    end

    test "every hop is checked again: a redirect outside the destination, or to a forbidden address, is refused" do
      server =
        StubServer.start!(fn
          %{path: "/v1/away"} ->
            {302, [{"location", "http://evil.test/v1/x"}], ""}

          %{path: "/v1/metadata", headers: headers} ->
            [_, port] = headers |> List.keyfind("host", 0) |> elem(1) |> String.split(":")
            {302, [{"location", "http://c.stub.test:#{port}/latest/meta-data"}], ""}
        end)

      settings = wildcard(server, [])
      resolver = hosts(server, %{"c.stub.test" => {169, 254, 169, 254}})

      assert {:error, %{class: :destination_denied, message: message}} =
               call(
                 server,
                 request(server, url: url(server, "a.stub.test", "/v1/away")),
                 settings,
                 resolver: resolver
               )

      assert message == "The URL does not match the destination 'stub': the host 'evil.test'."

      assert {:error, %{class: :destination_denied}} =
               call(
                 server,
                 request(server, url: url(server, "a.stub.test", "/v1/metadata")),
                 settings,
                 resolver: resolver
               )

      metadata_in_prefix = fn %{headers: headers} ->
        [_, port] = headers |> List.keyfind("host", 0) |> elem(1) |> String.split(":")
        {302, [{"location", "http://c.stub.test:#{port}/v1/latest"}], ""}
      end

      server = StubServer.start!(metadata_in_prefix)

      assert call(
               server,
               request(server, url: url(server, "a.stub.test", "/v1/x")),
               wildcard(server, []),
               resolver: hosts(server, %{"c.stub.test" => {169, 254, 169, 254}})
             ) ==
               {:error,
                failure(
                  :ssrf_blocked,
                  "The host 'c.stub.test' resolves to 169.254.169.254, a link-local address.",
                  retryable: false
                )}
    end

    # Card #181: a redirect's scheme and host are the only text from a target that can reach a message, which is stored as
    # jsonb. Mint refuses NUL in any header, so it never gets there (automation-contract.md §7, "The outcome").
    test "a Location with NUL is not valid HTTP, so the NUL reaches no message" do
      server =
        StubServer.start!(fn _ ->
          {:raw,
           "HTTP/1.1 302 Found\r\nlocation: http://a" <>
             <<0>> <> "b.stub.test/v1/x\r\ncontent-length: 0\r\n\r\n"}
        end)

      assert call(
               server,
               request(server, url: url(server, "a.stub.test", "/v1/start")),
               wildcard(server, []),
               resolver: hosts(server)
             ) ==
               {:error,
                failure(:invalid_response, "The answer from 'a.stub.test' is not valid HTTP.",
                  retryable: false
                )}
    end

    # Regression #190: URI.new raises on bytes that are not UTF-8, so such a Location became internal_error, which is retried:
    # the target was called again. It is now refused before it is parsed, like any Location that is not a URI reference.
    test "a Location whose bytes are not UTF-8, or that is not a URI reference, is redirect_not_allowed and is not followed" do
      for location <- [<<"/v1/next", 0xFF>>, <<"http://a.stub.test/v1/", 0xC3>>, "/v1/aç"] do
        server = StubServer.start!(fn _ -> {302, [{"location", location}], ""} end)

        assert call(
                 server,
                 request(server),
                 settings(server, follow_redirects: true, max_redirects: 2)
               ) ==
                 {:error,
                  failure(
                    :redirect_not_allowed,
                    "The target answered HTTP 302 with an invalid Location.",
                    status: 302,
                    retryable: false
                  )},
               inspect(location, binaries: :as_binaries)

        assert_received {:stub_request, _}
        refute_received {:stub_request, _}
      end
    end

    test "one hop too many, or a 3xx without Location, is redirect_not_allowed" do
      looping = StubServer.start!(fn _ -> {302, [{"location", "/v1/again"}], ""} end)

      assert call(
               looping,
               request(looping),
               settings(looping, follow_redirects: true, max_redirects: 2)
             ) ==
               {:error,
                failure(:redirect_not_allowed, "The target redirected more than 2 times.",
                  status: 302,
                  retryable: false
                )}

      # The first request and two followed hops reach the server; a third hop is not made.
      for _ <- 1..3, do: assert_received({:stub_request, _})
      refute_received {:stub_request, _}

      chain =
        StubServer.start!(fn
          %{path: "/v1/consultas" <> _} -> {302, [{"location", "/v1/b"}], ""}
          %{path: "/v1/b"} -> {302, [{"location", "/v1/c"}], ""}
          %{path: "/v1/c"} -> {200, @json, "{}"}
        end)

      assert {:ok, %{status: 200}} =
               call(
                 chain,
                 request(chain),
                 settings(chain, follow_redirects: true, max_redirects: 2)
               )

      nowhere = StubServer.start!(fn _ -> {301, [], ""} end)

      assert call(
               nowhere,
               request(nowhere),
               settings(nowhere, follow_redirects: true, max_redirects: 2)
             ) ==
               {:error,
                failure(:redirect_not_allowed, "The target answered HTTP 301 without a Location.",
                  status: 301,
                  retryable: false
                )}
    end
  end

  describe "TLS" do
    defp tls(hostname) do
      # SHA-256 signatures: TLS 1.3 refuses the SHA-1 that pkix_test_data/1 uses by default.
      peer = [
        digest: :sha256,
        key: {:namedCurve, :secp256r1},
        extensions: [{:Extension, {2, 5, 29, 17}, false, [dNSName: String.to_charlist(hostname)]}]
      ]

      :public_key.pkix_test_data(%{
        server_chain: %{
          root: [digest: :sha256, key: {:namedCurve, :secp256r1}],
          intermediates: [],
          peer: peer
        },
        client_chain: %{
          root: [key: {:namedCurve, :secp256r1}],
          intermediates: [],
          peer: [key: {:namedCurve, :secp256r1}]
        }
      })
    end

    defp https(server) do
      settings =
        settings(server)
        |> put_in([:destination, :scheme], "https")
        |> put_in([:destination, :host], "stub.example.test")

      {request(server, url: "https://stub.example.test:#{server.port}/v1/x"), settings}
    end

    defp resolve_to(server), do: fn "stub.example.test", _ -> {:ok, [server.ip]} end

    test "is verified against the original host, while connecting to the checked address" do
      certificates = tls("stub.example.test")
      server = StubServer.start!(fn _ -> {200, @json, "{}"} end, tls: certificates.server_config)
      {request, settings} = https(server)

      assert {:ok, %{status: 200, body: %{}}} =
               Client.call(request, settings,
                 resolver: resolve_to(server),
                 cacerts: certificates.client_config[:cacerts]
               )

      assert_received {:stub_request, %{headers: headers}}
      assert {"host", "stub.example.test:#{server.port}"} in headers
    end

    test "a certificate for another host, or from an unknown authority, is tls_error, which is not retried" do
      other_host = tls("other.example.test")
      server = StubServer.start!(fn _ -> {200, [], "{}"} end, tls: other_host.server_config)
      {request, settings} = https(server)

      assert {:error,
              %{
                class: :tls_error,
                retryable: false,
                message: "The TLS connection to 'stub.example.test' failed (bad_certificate)."
              }} =
               Client.call(request, settings,
                 resolver: resolve_to(server),
                 cacerts: other_host.client_config[:cacerts]
               )

      certificates = tls("stub.example.test")
      server = StubServer.start!(fn _ -> {200, [], "{}"} end, tls: certificates.server_config)
      {request, settings} = https(server)

      assert {:error,
              %{
                class: :tls_error,
                retryable: false,
                message: "The TLS connection to 'stub.example.test' failed (unknown_ca)."
              }} =
               Client.call(request, settings,
                 resolver: resolve_to(server),
                 cacerts: tls("stub.example.test").client_config[:cacerts]
               )

      refute_receive {:stub_request, _}, 100
    end
  end

  test "a request the client refuses to send is invalid_request, naming the header but never its value" do
    server = StubServer.start!(fn _ -> {200, [], "{}"} end)
    request = request(server, headers: [{"X-Nome", "João"}])

    assert call(server, request, settings(server)) ==
             {:error,
              failure(
                :invalid_request,
                "The request could not be sent: the header 'x-nome' has a character a header cannot carry.",
                retryable: false
              )}

    refute_receive {:stub_request, _}, 100
  end

  test "no exception leaves the adapter: an unexpected failure is internal_error, and its message has no details" do
    server = StubServer.start!(fn _ -> {200, [], "{}"} end)

    assert call(server, request(server), settings(server),
             resolver: fn _, _ -> raise "boom with segredo" end
           ) ==
             {:error,
              failure(:internal_error, "The HTTP call failed unexpectedly (RuntimeError).",
                retryable: true
              )}
  end
end
