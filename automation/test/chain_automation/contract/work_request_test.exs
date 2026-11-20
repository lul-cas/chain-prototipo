defmodule ChainAutomation.Contract.WorkRequestTest do
  use ExUnit.Case, async: true

  alias ChainAutomation.Contract.WorkRequest
  alias ChainAutomation.ContractFixture

  setup_all do
    %{payload: ContractFixture.read!("work-request.json")["expected"]}
  end

  test "the shared work request is a valid payload", %{payload: payload} do
    assert {:ok, %WorkRequest{} = work} = WorkRequest.parse(payload)

    assert {work.request_id, work.instance_id, work.node_id, work.activation} ==
             {"0199f000-0000-7000-8000-000000000001", "0199f000-0000-7000-8000-000000000002",
              "task_cpf", 1}

    assert work.automation == %{
             id: "0199f000-0000-7000-8000-000000000003",
             version: 1,
             name: "Consultar CPF"
           }

    assert work.destination == %{
             name: "erp",
             scheme: "https",
             host: "api.erp.example",
             port: nil,
             path_prefix: "/v1",
             internal: false,
             allow_secrets_over_http: false,
             max_request_bytes: 1_048_576,
             max_response_bytes: 1_048_576
           }

    assert {work.method, work.url} ==
             {"POST",
              "https://api.erp.example/v1/clientes/123.456%2F78%209/consultas?origem=chain&valor=1500"}

    assert work.headers == [
             {"Accept", "application/json"},
             {"Content-Type", "application/json"},
             {"X-Api-Key", "{{secret:erp_api_key}}"}
           ]

    assert {work.basic_auth, work.body} == {nil, ~s({"cpf":"123.456/78 9","valor":1500})}
    assert {work.secrets, work.response_type} == {["erp_api_key"], :json}

    assert work.execution == %{
             timeout_ms: 30_000,
             max_attempts: 5,
             initial_delay_ms: 5_000,
             follow_redirects: false,
             max_redirects: 0
           }

    assert work.idempotency == {"Idempotency-Key", "0199f000-0000-7000-8000-000000000001"}
    assert work.deadline_at == ~U[2026-10-16 12:16:30Z]
    assert {work.correlation_id, work.traceparent} == {"4bf92f3577b34da6a3ce929d0e0e4736", nil}

    # Header values may be literal credentials and the body holds business data: neither shows when it is inspected.
    refute inspect(work) =~ "application/json"
    refute inspect(work) =~ "123.456/78 9"
  end

  test "the optional parts may be filled: basic auth, a port, a traceparent, redirects, no idempotency",
       %{payload: payload} do
    payload =
      payload
      |> put_in(["request", "headers"], [["Accept", "application/json"]])
      |> put_in(["request", "basicAuth"], %{
        "username" => "chain",
        "password" => "{{secret:erp_api_key}}"
      })
      |> put_in(["destination", "port"], 8443)
      |> put_in(["execution", "followRedirects"], true)
      |> put_in(["execution", "maxRedirects"], 3)
      |> Map.put("idempotency", nil)
      |> Map.put("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")

    assert {:ok, work} = WorkRequest.parse(payload)
    assert work.basic_auth == {"chain", "{{secret:erp_api_key}}"}

    assert {work.destination.port, work.execution.max_redirects, work.idempotency} ==
             {8443, 3, nil}
  end

  test "an http destination is allowed when it is internal", %{payload: payload} do
    payload =
      payload
      |> put_in(["destination", "scheme"], "http")
      |> put_in(["destination", "internal"], true)

    assert {:ok, _} = WorkRequest.parse(payload)
  end

  describe "a payload that breaks the contract is invalid_request" do
    for {name, change, message} <- [
          {"not an object", quote(do: fn _ -> [] end), "The payload must be a JSON object."},
          {"another version", quote(do: &Map.put(&1, "contractVersion", 2)),
           "The field 'contractVersion' must be 1."},
          {"a missing field", quote(do: &Map.delete(&1, "deadlineAt")),
           "The field 'deadlineAt' is missing."},
          {"a missing nested field", quote(do: &(pop_in(&1, ["request", "url"]) |> elem(1))),
           "The field 'request.url' is missing."},
          {"an unknown field", quote(do: &put_in(&1, ["request", "timeout"], 5)),
           "The field 'request.timeout' is not part of contract version 1."},
          {"a request id that is not a UUID", quote(do: &Map.put(&1, "requestId", "12345")),
           "The field 'requestId' must be a UUID."},
          {"an activation of 0", quote(do: &Map.put(&1, "activation", 0)),
           "The field 'activation' must be an integer of at least 1."},
          {"a node id that is empty", quote(do: &Map.put(&1, "nodeId", "")),
           "The field 'nodeId' must be non-empty text."},
          {"another method", quote(do: &put_in(&1, ["request", "method"], "TRACE")),
           "The field 'request.method' must be one of GET, POST, PUT, PATCH, DELETE."},
          {"a float where an integer goes",
           quote(do: &put_in(&1, ["execution", "maxAttempts"], 5.0)),
           "The field 'execution.maxAttempts' must be an integer from 1 to 10."},
          {"too many attempts", quote(do: &put_in(&1, ["execution", "maxAttempts"], 11)),
           "The field 'execution.maxAttempts' must be an integer from 1 to 10."},
          {"a timeout over five minutes",
           quote(do: &put_in(&1, ["execution", "timeoutMs"], 300_001)),
           "The field 'execution.timeoutMs' must be an integer from 1000 to 300000."},
          {"a delay under a second", quote(do: &put_in(&1, ["execution", "initialDelayMs"], 999)),
           "The field 'execution.initialDelayMs' must be an integer from 1000 to 60000."},
          {"redirects without following them",
           quote(do: &put_in(&1, ["execution", "maxRedirects"], 1)),
           "The field 'execution.maxRedirects' must be 0 without followRedirects, and 1 to 3 with it."},
          {"a response limit over 10 MiB",
           quote(do: &put_in(&1, ["destination", "maxResponseBytes"], 10_485_761)),
           "The field 'destination.maxResponseBytes' must be an integer from 1024 to 10485760."},
          {"port 0", quote(do: &put_in(&1, ["destination", "port"], 0)),
           "The field 'destination.port' must be an integer from 1 to 65535, or null."},
          {"a string where a boolean goes",
           quote(do: &put_in(&1, ["destination", "internal"], "false")),
           "The field 'destination.internal' must be true or false."},
          {"http to a destination that is not internal",
           quote(do: &put_in(&1, ["destination", "scheme"], "http")),
           "The field 'destination.scheme' may be 'http' only for an internal destination."},
          {"another response type", quote(do: &put_in(&1, ["response", "type"], "xml")),
           "The field 'response.type' must be one of json, none."},
          {"a deadline with an offset",
           quote(do: &Map.put(&1, "deadlineAt", "2026-10-16T09:16:30-03:00")),
           "The field 'deadlineAt' must be an ISO 8601 instant in UTC."},
          {"a correlation id in upper case",
           quote(do: &Map.put(&1, "correlationId", "4BF92F3577B34DA6A3CE929D0E0E4736")),
           "The field 'correlationId' must be 32 lowercase hex digits."},
          {"a traceparent followed by a line break",
           quote(
             do:
               &Map.put(
                 &1,
                 "traceparent",
                 "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01\n"
               )
           ), "The field 'traceparent' must be a W3C traceparent, or null."},
          {"a correlation id followed by a line break",
           quote(do: &Map.put(&1, "correlationId", "4bf92f3577b34da6a3ce929d0e0e4736\n")),
           "The field 'correlationId' must be 32 lowercase hex digits."},
          {"a request id followed by a line break",
           quote(do: &Map.put(&1, "requestId", "0199f000-0000-7000-8000-000000000001\n")),
           "The field 'requestId' must be a UUID."},
          {"an idempotency key that is not a UUID",
           quote(do: &put_in(&1, ["idempotency", "key"], "abc")),
           "The field 'idempotency.key' must be a UUID."},
          {"a header that is not a pair",
           quote(do: &put_in(&1, ["request", "headers"], [["Accept"]])),
           "The field 'request.headers' must be a list of [name, value] pairs of text."},
          {"a header name that is not a token",
           quote(do: &put_in(&1, ["request", "headers"], [["X Api", "1"]])),
           "A header name is not an HTTP token."},
          {"a forbidden idempotency header",
           quote(do: &put_in(&1, ["idempotency", "header"], "Host")),
           "The header 'Host' cannot be set by an automation."},
          {"an idempotency header that is not a token",
           quote(do: &put_in(&1, ["idempotency", "header"], "Idempotency Key")),
           "The field 'idempotency.header' must be an HTTP token of at most 100 characters."},
          {"a forbidden header",
           quote(do: &put_in(&1, ["request", "headers"], [["Host", "evil.example"]])),
           "The header 'Host' cannot be set by an automation."},
          {"a proxy header",
           quote(do: &put_in(&1, ["request", "headers"], [["proxy-authorization", "x"]])),
           "The header 'proxy-authorization' cannot be set by an automation."},
          {"a header twice, ignoring case",
           quote(do: &put_in(&1, ["request", "headers"], [["Accept", "a"], ["accept", "b"]])),
           "The header 'accept' appears twice."},
          {"CR and LF in a header value",
           quote(do: &put_in(&1, ["request", "headers"], [["Accept", "a\r\nX-Injected: 1"]])),
           "The value of the header 'Accept' has a character a header cannot carry."},
          {"LF in a header value",
           quote(do: &put_in(&1, ["request", "headers"], [["Accept", "a\nb"]])),
           "The value of the header 'Accept' has a character a header cannot carry."},
          {"CR in a header value",
           quote(do: &put_in(&1, ["request", "headers"], [["Accept", "a\rb"]])),
           "The value of the header 'Accept' has a character a header cannot carry."},
          {"NUL in a header value",
           quote(do: &put_in(&1, ["request", "headers"], [["Accept", "a\0b"]])),
           "The value of the header 'Accept' has a character a header cannot carry."},
          {"non-ASCII text in a header value",
           quote(do: &put_in(&1, ["request", "headers"], [["Accept", "Olá"]])),
           "The value of the header 'Accept' has a character a header cannot carry."},
          {"a control character in a header value",
           quote(do: &put_in(&1, ["request", "headers"], [["Accept", "a\x01b"]])),
           "The value of the header 'Accept' has a character a header cannot carry."},
          {"DEL in a header value",
           quote(do: &put_in(&1, ["request", "headers"], [["Accept", "a\x7Fb"]])),
           "The value of the header 'Accept' has a character a header cannot carry."},
          {"the idempotency header set by hand",
           quote(do: &put_in(&1, ["request", "headers"], [["idempotency-key", "x"]])),
           "The header 'idempotency-key' is the idempotency header, which is added from 'idempotency'."},
          {"Authorization with basic auth",
           quote(
             do:
               &(&1
                 |> put_in(["request", "headers"], [["Authorization", "Bearer x"]])
                 |> put_in(["request", "basicAuth"], %{"username" => "a", "password" => "b"})
                 |> Map.put("secrets", []))
           ), "The header 'Authorization' cannot be set together with basicAuth."},
          {"a malformed placeholder",
           quote(
             do: &put_in(&1, ["request", "headers"], [["X-Api-Key", "{{secret:erp_api_key}"]])
           ), "The value of the header 'X-Api-Key' has a malformed secret placeholder."},
          {"a placeholder with an invalid name",
           quote(do: &put_in(&1, ["request", "headers"], [["X-Api-Key", "{{secret:Erp}}"]])),
           "The value of the header 'X-Api-Key' has a malformed secret placeholder."},
          {"a placeholder in basic auth that is malformed",
           quote(
             do:
               &(&1
                 |> put_in(["request", "headers"], [])
                 |> put_in(["request", "basicAuth"], %{
                   "username" => "a",
                   "password" => "{{secret:"
                 }))
           ), "The basic-auth password has a malformed secret placeholder."},
          {"a secret used but not listed", quote(do: &Map.put(&1, "secrets", [])),
           "The field 'secrets' must list exactly the secrets the placeholders use, in ordinal order, once each."},
          {"a secret listed but not used",
           quote(do: &Map.put(&1, "secrets", ["erp_api_key", "outro"])),
           "The field 'secrets' must list exactly the secrets the placeholders use, in ordinal order, once each."},
          {"a secret name followed by a line break",
           quote(do: &Map.put(&1, "secrets", ["erp_api_key\n"])),
           "The field 'secrets' must be a list of secret names."},
          {"a secret name that is not valid", quote(do: &Map.put(&1, "secrets", ["ERP"])),
           "The field 'secrets' must be a list of secret names."}
        ] do
      test name, %{payload: payload} do
        assert WorkRequest.parse(unquote(change).(payload)) ==
                 {:error, :invalid_request, unquote(message)}
      end
    end
  end
end
