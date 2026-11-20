defmodule ChainAutomation.Http.RequestTest do
  use ExUnit.Case, async: true

  alias ChainAutomation.Contract.WorkRequest
  alias ChainAutomation.ContractFixture
  alias ChainAutomation.Http.Request

  @canary "canary-S3cret-value-0042"
  @unicode "canary-Sécret-🔑-value"
  @key "0199f000-0000-7000-8000-000000000001"

  setup_all do
    %{payload: ContractFixture.read!("work-request.json")["expected"]}
  end

  defp build(payload, secrets) do
    {:ok, work} = WorkRequest.parse(payload)
    Request.build(work, secrets)
  end

  defp with_basic_auth(payload, username, password) do
    payload
    |> put_in(["request", "headers"], [["Accept", "application/json"]])
    |> put_in(["request", "basicAuth"], %{"username" => username, "password" => password})
  end

  test "the shared work request becomes this HTTP request: the secret substituted, the idempotency key added last",
       %{payload: payload} do
    assert {:ok, request} = build(payload, %{"erp_api_key" => @canary})

    assert {request.method, request.url, request.body} ==
             {"POST",
              "https://api.erp.example/v1/clientes/123.456%2F78%209/consultas?origem=chain&valor=1500",
              ~s({"cpf":"123.456/78 9","valor":1500})}

    assert request.headers == [
             {"Accept", "application/json"},
             {"Content-Type", "application/json"},
             {"X-Api-Key", @canary},
             {"Idempotency-Key", @key}
           ]
  end

  test "basic auth becomes an Authorization header after substitution, before the idempotency header",
       %{payload: payload} do
    assert {:ok, request} =
             build(with_basic_auth(payload, "chain", "{{secret:erp_api_key}}"), %{
               "erp_api_key" => @canary
             })

    assert request.headers == [
             {"Accept", "application/json"},
             {"Authorization", "Basic " <> Base.encode64("chain:" <> @canary)},
             {"Idempotency-Key", @key}
           ]
  end

  test "placeholders inside longer text, and several in one value, are all replaced", %{
    payload: payload
  } do
    payload =
      payload
      |> put_in(["request", "headers"], [["X-Api-Key", "Token {{secret:a}}.{{secret:b}}"]])
      |> Map.put("secrets", ["a", "b"])

    assert {:ok, request} = build(payload, %{"a" => "um", "b" => "dois"})
    assert {"X-Api-Key", "Token um.dois"} in request.headers
  end

  test "a value that looks like a placeholder is sent as it is, never expanded", %{
    payload: payload
  } do
    payload =
      payload
      |> put_in(["request", "headers"], [["X-Api-Key", "{{secret:a}}|{{secret:b}}"]])
      |> Map.put("secrets", ["a", "b"])

    assert {:ok, request} = build(payload, %{"a" => "{{secret:b}}", "b" => "dois"})
    assert {"X-Api-Key", "{{secret:b}}|dois"} in request.headers

    assert {:ok, request} = build(payload, %{"a" => ~S(\1\0&), "b" => "dois"})
    assert {"X-Api-Key", ~S(\1\0&|dois)} in request.headers
  end

  test "the request names the headers that carry a secret, so a redirect to another host can drop them",
       %{payload: payload} do
    assert {:ok, request} = build(payload, %{"erp_api_key" => @canary})
    assert request.secret_headers == ["x-api-key"]

    assert {:ok, request} =
             build(Map.put(with_basic_auth(payload, "chain", "literal"), "secrets", []), %{})

    assert request.secret_headers == ["authorization"]
  end

  test "without idempotency, no key is sent", %{payload: payload} do
    assert {:ok, request} =
             build(Map.put(payload, "idempotency", nil), %{"erp_api_key" => @canary})

    refute Enum.any?(request.headers, fn {name, _} -> name == "Idempotency-Key" end)
  end

  test "a header carries only visible ASCII, spaces and tabs: any other character in a secret is refused, by name only",
       %{payload: payload} do
    for value <- ["a\r\nX-Injected: 1", "a\nb", "a\rb", <<"a", 0, "b">>, "a\x01b", @unicode] do
      assert {:error, :secret_not_allowed, message} = build(payload, %{"erp_api_key" => value})

      assert message ==
               "The secret 'erp_api_key' has a character a header cannot carry (only visible ASCII, spaces and tabs)."
    end

    assert {:ok, request} = build(payload, %{"erp_api_key" => "a b\tc"})
    assert {"X-Api-Key", "a b\tc"} in request.headers
  end

  test "in basic auth text beyond ASCII can be used, because it is encoded", %{payload: payload} do
    payload = with_basic_auth(payload, "chain", "{{secret:erp_api_key}}")

    assert {:ok, request} = build(payload, %{"erp_api_key" => @unicode})
    assert {"Authorization", "Basic " <> Base.encode64("chain:" <> @unicode)} in request.headers
  end

  test "in basic auth a secret with a control character is refused, by name only (RFC 7617, card #128)",
       %{
         payload: payload
       } do
    message =
      "The secret 'erp_api_key' has a control character, which basic authentication cannot carry (RFC 7617)."

    for value <- [
          "a\nb",
          "a\r\nb",
          "a\tb",
          <<"a", 0, "b">>,
          "a\x1Bb",
          "a\x7Fb",
          "a\u0085b",
          "a\u009Fb"
        ] do
      for {username, password} <- [
            {"chain", "{{secret:erp_api_key}}"},
            {"{{secret:erp_api_key}}", "senha"}
          ] do
        assert build(with_basic_auth(payload, username, password), %{"erp_api_key" => value}) ==
                 {:error, :secret_not_allowed, message}
      end
    end

    # The nearest characters that aren't controls pass: a space, a tilde, U+00A0
    payload = with_basic_auth(payload, "chain", "{{secret:erp_api_key}}")
    assert {:ok, _} = build(payload, %{"erp_api_key" => " ~\u00A0"})
  end

  test "a username with ':' is ambiguous (RFC 7617), whether literal or from a secret", %{
    payload: payload
  } do
    message = "The basic-auth username cannot contain ':' (RFC 7617)."

    assert build(with_basic_auth(payload, "us:er", "{{secret:erp_api_key}}"), %{
             "erp_api_key" => "x"
           }) ==
             {:error, :invalid_request, message}

    payload = with_basic_auth(payload, "{{secret:erp_api_key}}", "senha")
    assert build(payload, %{"erp_api_key" => "us:er"}) == {:error, :invalid_request, message}
  end

  test "a secret that was not read is secret_missing", %{payload: payload} do
    assert build(payload, %{}) ==
             {:error, :secret_missing, "The secret 'erp_api_key' does not exist."}
  end

  test "inspecting a built request shows no header value", %{payload: payload} do
    {:ok, request} =
      build(with_basic_auth(payload, "chain", "{{secret:erp_api_key}}"), %{
        "erp_api_key" => @canary
      })

    for shown <- [
          inspect(request),
          inspect({:error, [request]}, limit: :infinity, printable_limit: :infinity)
        ] do
      refute shown =~ @canary
      refute shown =~ Base.encode64("chain:" <> @canary)
    end
  end
end
