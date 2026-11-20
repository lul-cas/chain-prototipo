defmodule ChainAutomation.Workers.ExecuteAutomationTest do
  # The worker reads the KEK ring and the adapter's options from global state, so these tests do not run alongside others.
  use ExUnit.Case, async: false
  use Oban.Testing, repo: ChainAutomation.Repo, prefix: "automation"

  import ExUnit.CaptureLog

  alias ChainAutomation.{ChainViews, ContractFixture, Repo, StubServer}
  alias ChainAutomation.Contract.Keks
  alias ChainAutomation.Workers.ExecuteAutomation
  alias Ecto.Adapters.SQL.Sandbox

  @canary "canary-S3cret-value-0042"
  @host "stub.internal.test"
  @json [{"content-type", "application/json"}]
  @report "ChainAutomation.Workers.ReportResult"

  setup do
    :ok = Sandbox.checkout(Repo)
    kek = {"test", :crypto.strong_rand_bytes(32)}
    :ok = Keks.load!("test:" <> Base.encode64(elem(kek, 1)))
    on_exit(fn -> Keks.load!(nil) end)
    on_exit(fn -> Application.delete_env(:chain_automation, ExecuteAutomation) end)
    %{kek: kek}
  end

  # The stub listens on a private address: the destination is internal, as a service inside the deployment would be.
  defp target!(handler) do
    server = StubServer.start!(handler)

    resolver = fn host, _timeout ->
      if host == @host, do: {:ok, [server.ip]}, else: {:error, :nxdomain}
    end

    Application.put_env(:chain_automation, ExecuteAutomation, client: [resolver: resolver])
    server
  end

  defp payload(server, changes \\ []) do
    id = Ecto.UUID.generate()

    payload =
      ContractFixture.read!("work-request.json")["expected"]
      |> Map.merge(%{
        "requestId" => id,
        "deadlineAt" =>
          DateTime.utc_now()
          |> DateTime.add(3_600)
          |> DateTime.truncate(:second)
          |> DateTime.to_iso8601(),
        "idempotency" => %{"header" => "Idempotency-Key", "key" => id}
      })
      |> Map.update!("destination", fn destination ->
        %{
          destination
          | "scheme" => "http",
            "host" => @host,
            "port" => server.port,
            "internal" => true,
            "allowSecretsOverHttp" => true
        }
      end)
      |> put_in(
        ["request", "url"],
        "http://#{@host}:#{server.port}/v1/clientes/123.456%2F78%209/consultas?origem=chain&valor=1500"
      )
      |> put_in(["execution", "timeoutMs"], 2_000)
      |> put_in(["execution", "maxAttempts"], 3)
      |> put_in(["execution", "initialDelayMs"], 1_000)

    payload = Enum.reduce(changes, payload, fn change, payload -> change.(payload) end)
    ChainViews.insert!(id, "execute", payload: payload)
    payload
  end

  defp perform(payload, opts \\ []) do
    perform_job(ExecuteAutomation, %{"requestId" => payload["requestId"], "payload" => payload},
      attempt: Keyword.get(opts, :attempt, 1),
      max_attempts: Keyword.get(opts, :max_attempts, 3)
    )
  end

  defp outcome(payload) do
    case Repo.query!(
           "SELECT outcome, activation, output, error FROM automation.outcomes WHERE request_id = $1",
           [
             Ecto.UUID.dump!(payload["requestId"])
           ]
         ).rows do
      [[outcome, activation, output, error]] ->
        %{outcome: outcome, activation: activation, output: output, error: error}

      [] ->
        nil
    end
  end

  defp attempts(payload) do
    Repo.query!(
      "SELECT number, outcome, error_class, status, response_bytes, retry_after_seconds, duration_ms, summary " <>
        "FROM automation.attempts WHERE request_id = $1 ORDER BY number",
      [Ecto.UUID.dump!(payload["requestId"])]
    ).rows
    |> Enum.map(fn [number, outcome, class, status, bytes, retry_after, duration, summary] ->
      %{
        number: number,
        outcome: outcome,
        error_class: class,
        status: status,
        response_bytes: bytes,
        retry_after_seconds: retry_after,
        duration_ms: duration,
        summary: summary
      }
    end)
  end

  defp secret!(context, value \\ @canary, allowed \\ ["erp"]),
    do: ChainViews.put_secret!("erp_api_key", 2, value, allowed, context.kek)

  defp failed(class, message, status \\ nil),
    do: %{"class" => class, "message" => message, "status" => status}

  test "a succeeded call records its attempt and the outcome, and queues ReportResult", context do
    server =
      target!(fn _ -> {200, @json, ~s({"resultado":{"situacao":"regular","score":812}})} end)

    secret!(context)
    payload = payload(server)

    assert perform(payload) == :ok

    assert_received {:stub_request,
                     %{
                       method: "POST",
                       headers: headers,
                       body: ~s({"cpf":"123.456/78 9","valor":1500})
                     }}

    assert {"x-api-key", @canary} in headers
    assert {"idempotency-key", payload["requestId"]} in headers

    assert outcome(payload) == %{
             outcome: "succeeded",
             activation: 1,
             output: %{
               "status" => 200,
               "body" => %{"resultado" => %{"situacao" => "regular", "score" => 812}}
             },
             error: nil
           }

    assert [attempt] = attempts(payload)
    assert %{number: 1, outcome: "succeeded", error_class: nil, status: 200} = attempt

    assert attempt.response_bytes ==
             byte_size(~s({"resultado":{"situacao":"regular","score":812}}))

    assert is_integer(attempt.duration_ms)

    assert attempt.summary == %{
             "method" => "POST",
             "destination" => "erp",
             "host" => @host,
             "path" => "/v1/clientes/123.456%2F78%209/consultas",
             "queryNames" => ["origem", "valor"],
             "headerNames" => ["Accept", "Content-Type", "Idempotency-Key", "X-Api-Key"],
             "secrets" => [%{"name" => "erp_api_key", "version" => 2}]
           }

    assert_enqueued(
      worker: @report,
      queue: :results,
      args: %{"requestId" => payload["requestId"]}
    )
  end

  test "a retryable failure is retried before the last attempt and final on it; Retry-After counts in the backoff",
       context do
    server = target!(fn _ -> {503, [{"retry-after", "7"}], ""} end)
    secret!(context)
    payload = payload(server)
    args = %{"requestId" => payload["requestId"], "payload" => payload}

    assert perform(payload, attempt: 1) == {:error, "http_status: The target answered HTTP 503."}
    assert outcome(payload) == nil
    refute_enqueued(worker: @report)

    assert [
             %{
               number: 1,
               outcome: "retryable_error",
               error_class: "http_status",
               status: 503,
               retry_after_seconds: 7
             }
           ] = attempts(payload)

    assert ExecuteAutomation.backoff(%Oban.Job{attempt: 1, args: args}) == 7

    assert perform(payload, attempt: 3) == :ok
    assert %{outcome: "failed", output: nil} = outcome(payload)
    assert outcome(payload).error == failed("http_status", "The target answered HTTP 503.", 503)
    assert Enum.map(attempts(payload), & &1.number) == [1, 3]
    assert_enqueued(worker: @report, args: %{"requestId" => payload["requestId"]})
  end

  test "a permanent failure is final at once", context do
    server = target!(fn _ -> {404, [], ""} end)
    secret!(context)
    payload = payload(server)

    assert perform(payload, attempt: 1) == :ok
    assert outcome(payload).error == failed("http_status", "The target answered HTTP 404.", 404)
    assert [%{outcome: "permanent_error", error_class: "http_status"}] = attempts(payload)
  end

  # Regression #190: scrubbing rebuilt each object with Map.new, so two keys that scrub to the same text became one, and one of
  # the two values was lost without a word. Such an answer is now refused (automation-contract.md §7, "Redaction").
  test "an answer whose keys would merge once a secret is redacted is invalid_response, and none of it is stored",
       context do
    answer = Jason.encode!(%{@canary => "first", "[REDACTED:erp_api_key]" => "second"})
    server = target!(fn _ -> {200, @json, answer} end)
    secret!(context)
    payload = payload(server)

    assert perform(payload) == :ok

    assert %{outcome: "failed", output: nil, error: error} = outcome(payload)

    assert error ==
             failed(
               "invalid_response",
               "The answer has keys that are the same once secrets are redacted.",
               200
             )

    assert [%{outcome: "permanent_error", error_class: "invalid_response", status: 200}] =
             attempts(payload)
  end

  test "an outcome already recorded goes straight to reporting, with no new attempt", context do
    server = target!(fn _ -> {200, @json, "{}"} end)
    secret!(context)
    payload = payload(server)
    assert perform(payload) == :ok

    assert perform(payload, attempt: 2) == :ok
    assert length(attempts(payload)) == 1
    assert_received {:stub_request, _}
    refute_received {:stub_request, _}
  end

  test "a request that is no longer pending cancels the job, with no attempt and no outcome",
       context do
    server = target!(fn _ -> {200, @json, "{}"} end)
    secret!(context)
    payload = payload(server)
    ChainViews.set_status!(payload["requestId"], "cancelled")

    assert perform(payload) == {:cancel, "The request is no longer pending."}
    assert {outcome(payload), attempts(payload)} == {nil, []}
    refute_received {:stub_request, _}
  end

  test "a payload that breaks the contract, or a passed deadline, ends the request without an attempt",
       context do
    server = target!(fn _ -> {200, @json, "{}"} end)
    secret!(context)

    broken = payload(server, [&Map.put(&1, "contractVersion", 2), &Map.put(&1, "activation", 2)])
    assert perform(broken) == :ok

    assert outcome(broken).error ==
             failed("invalid_request", "The field 'contractVersion' must be 1.")

    assert outcome(broken).activation == 2

    late = payload(server, [&Map.put(&1, "deadlineAt", "2026-01-01T00:00:00Z")])
    assert perform(late) == :ok

    assert outcome(late).error ==
             failed("deadline_passed", "The deadline passed before the attempt started.")

    assert attempts(broken) ++ attempts(late) == []
    refute_received {:stub_request, _}
  end

  test "the URL is checked before the secrets are read", _context do
    server = target!(fn _ -> {200, @json, "{}"} end)

    payload =
      payload(server, [&put_in(&1, ["request", "url"], "http://other.test:#{server.port}/v1/x")])

    assert perform(payload) == :ok

    assert outcome(payload).error ==
             failed(
               "destination_denied",
               "The URL does not match the destination 'erp': the host 'other.test'."
             )

    assert [%{outcome: "permanent_error", error_class: "destination_denied"}] = attempts(payload)
  end

  describe "secrets" do
    test "a missing secret, or one not allowed for the destination, is refused", context do
      server = target!(fn _ -> {200, @json, "{}"} end)

      missing = payload(server)
      assert perform(missing) == :ok

      assert outcome(missing).error ==
               failed("secret_missing", "The secret 'erp_api_key' does not exist.")

      assert [%{summary: %{"secrets" => [%{"name" => "erp_api_key", "version" => nil}]}}] =
               attempts(missing)

      secret!(context, @canary, ["other"])
      not_allowed = payload(server)
      assert perform(not_allowed) == :ok

      assert outcome(not_allowed).error ==
               failed(
                 "secret_not_allowed",
                 "The secret 'erp_api_key' is not allowed for the destination 'erp'."
               )

      refute_received {:stub_request, _}
    end

    test "a secret over http needs the destination's confirmation", context do
      server = target!(fn _ -> {200, @json, "{}"} end)
      secret!(context)
      over_http = payload(server, [&put_in(&1, ["destination", "allowSecretsOverHttp"], false)])

      assert perform(over_http) == :ok

      assert outcome(over_http).error ==
               failed(
                 "secret_not_allowed",
                 "The secret 'erp_api_key' cannot travel over http to 'erp' without allowSecretsOverHttp."
               )

      refute_received {:stub_request, _}
    end

    test "a secret whose KEK is not configured is internal_error, retried", _context do
      server = target!(fn _ -> {200, @json, "{}"} end)

      ChainViews.put_secret!(
        "erp_api_key",
        2,
        @canary,
        ["erp"],
        {"old", :crypto.strong_rand_bytes(32)}
      )

      payload = payload(server)

      assert perform(payload, attempt: 1) ==
               {:error,
                "internal_error: The secret 'erp_api_key' cannot be decrypted: its KEK 'old' is not configured."}

      assert [%{outcome: "retryable_error", error_class: "internal_error"}] = attempts(payload)
    end

    test "a secret moved to another KEK between two attempts still opens (ADR-0017 §5.7)",
         _context do
      server = target!(fn _ -> {200, @json, "{}"} end)
      old = {"k1", :crypto.strong_rand_bytes(32)}
      new = {"k2", :crypto.strong_rand_bytes(32)}

      :ok =
        Keks.load!(
          Enum.map_join([old, new], ",", fn {id, key} -> "#{id}:#{Base.encode64(key)}" end)
        )

      ChainViews.put_secret!("erp_api_key", 2, @canary, ["erp"], old)

      assert perform(payload(server)) == :ok
      assert_received {:stub_request, %{headers: before_move}}

      ChainViews.rewrap!("erp_api_key", old, new)

      assert %{rows: [["k2", 2]]} =
               Repo.query!("SELECT key_id, version FROM chain.automation_secrets")

      assert perform(payload(server)) == :ok
      assert_received {:stub_request, %{headers: after_move}}
      assert {"x-api-key", @canary} in before_move
      assert {"x-api-key", @canary} in after_move
    end

    test "a value with a line break cannot go in a header", context do
      server = target!(fn _ -> {200, @json, "{}"} end)
      secret!(context, "value\r\nX-Injected: 1")
      payload = payload(server)

      assert perform(payload) == :ok

      assert outcome(payload).error ==
               failed(
                 "secret_not_allowed",
                 "The secret 'erp_api_key' has a character a header cannot carry (only visible ASCII, spaces and tabs)."
               )

      refute_received {:stub_request, _}
    end
  end

  test "a secret's value is redacted from a message too, wherever it came from", context do
    server = target!(fn _ -> {200, @json, "{}"} end)
    secret!(context, @host)
    closed = StubServer.closed_port!()

    payload =
      payload(server, [
        &put_in(&1, ["request", "url"], "http://#{@host}:#{closed}/v1/x"),
        &put_in(&1, ["destination", "port"], closed)
      ])

    assert perform(payload, attempt: 3) == :ok

    assert outcome(payload).error ==
             failed(
               "connect_error",
               "The connection to '[REDACTED:erp_api_key]' failed (econnrefused)."
             )
  end

  test "a row left started by a crash becomes abandoned when the next attempt starts", context do
    server = target!(fn _ -> {200, @json, "{}"} end)
    secret!(context)
    payload = payload(server)

    Repo.query!(
      "INSERT INTO automation.attempts (request_id, number, started_at, outcome, summary) VALUES ($1, 1, now(), 'started', '{}')",
      [Ecto.UUID.dump!(payload["requestId"])]
    )

    assert perform(payload, attempt: 2) == :ok

    assert [
             %{number: 1, outcome: "abandoned", duration_ms: nil},
             %{number: 2, outcome: "succeeded"}
           ] = attempts(payload)
  end

  test "the backoff doubles from the initial delay up to 300 s, with a jitter under 10%, and the job has a time limit" do
    job = fn attempt, execution ->
      %Oban.Job{
        attempt: attempt,
        args: %{"requestId" => Ecto.UUID.generate(), "payload" => %{"execution" => execution}}
      }
    end

    for _ <- 1..20 do
      assert ExecuteAutomation.backoff(job.(1, %{"initialDelayMs" => 5_000})) in 5..6
      assert ExecuteAutomation.backoff(job.(3, %{"initialDelayMs" => 5_000})) in 20..22
      assert ExecuteAutomation.backoff(job.(10, %{"initialDelayMs" => 5_000})) in 300..330
    end

    assert ExecuteAutomation.timeout(job.(1, %{"timeoutMs" => 2_000})) == 32_000
    assert ExecuteAutomation.timeout(job.(1, %{"timeoutMs" => "?"})) == 330_000
  end

  test "the outcome and its ReportResult job are written together", context do
    server = target!(fn _ -> {200, @json, "{}"} end)
    secret!(context)
    payload = payload(server)

    Repo.query!("""
    CREATE FUNCTION automation.refuse_report() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.worker = 'ChainAutomation.Workers.ReportResult' THEN RAISE EXCEPTION 'report refused for the test'; END IF; RETURN NEW; END $$
    """)

    Repo.query!(
      "CREATE TRIGGER refuse_report BEFORE INSERT ON automation.oban_jobs FOR EACH ROW EXECUTE FUNCTION automation.refuse_report()"
    )

    # The exception is sanitized like any other (ADR-0012 Part 3 rule 4); the next run makes the attempt again.
    assert perform(payload) ==
             {:error, "internal_error: The attempt failed unexpectedly (Postgrex.Error)."}

    assert outcome(payload) == nil
  end

  # Regression #181: jsonb refuses \u0000, so storing this outcome failed. Each attempt became internal_error and called the
  # target again; after the last one no outcome existed, and the step ended by timing out instead of reaching .NET's output
  # check (automation.md §7.2).
  test "an answer with NUL in a string is stored as it came, once, and queued for reporting",
       context do
    answer = ~S({"resultado":{"situacao":"regu\u0000lar","nota\u0000":1}})
    server = target!(fn _ -> {200, @json, answer} end)
    secret!(context)
    payload = payload(server)

    # Oban runs the job as it would in production, with its retries; the executor shares this test's connection.
    Sandbox.mode(Repo, {:shared, self()})

    Oban.insert!(
      ExecuteAutomation.new(%{"requestId" => payload["requestId"], "payload" => payload},
        max_attempts: 3
      )
    )

    assert %{success: 1, failure: 0, discard: 0} =
             Oban.drain_queue(queue: :automation, with_scheduled: true, with_recursion: true)

    assert_received {:stub_request, _}
    refute_received {:stub_request, _}

    assert outcome(payload).output == %{
             "status" => 200,
             "body" => %{"resultado" => %{"situacao" => "regu\u0000lar", "nota\u0000" => 1}}
           }

    assert [%{number: 1, outcome: "succeeded"}] = attempts(payload)
    assert_enqueued(worker: @report, args: %{"requestId" => payload["requestId"]})
  end

  # Regression #191: PostgreSQL refuses JSON nested this deep ("stack depth limit exceeded"), so storing the outcome failed as
  # in #181: each attempt became internal_error and called the target again, and no outcome was left to report. The answer is
  # now invalid_response, before anything is stored (automation-contract.md §4.2).
  test "an answer nested too deep fails at once as invalid_response, and the failure is stored and queued for reporting",
       context do
    answer = String.duplicate("[", 100_000) <> String.duplicate("]", 100_000)
    server = target!(fn _ -> {200, @json, answer} end)
    secret!(context)
    payload = payload(server)

    # Oban runs the job as it would in production, with its retries; the executor shares this test's connection.
    Sandbox.mode(Repo, {:shared, self()})

    Oban.insert!(
      ExecuteAutomation.new(%{"requestId" => payload["requestId"], "payload" => payload},
        max_attempts: 3
      )
    )

    assert %{success: 1, failure: 0, discard: 0} =
             Oban.drain_queue(queue: :automation, with_scheduled: true, with_recursion: true)

    assert_received {:stub_request, _}
    refute_received {:stub_request, _}

    assert outcome(payload).error ==
             failed("invalid_response", "The answer is nested more than 32 levels deep.", 200)

    assert [%{number: 1, outcome: "permanent_error", error_class: "invalid_response"}] =
             attempts(payload)

    assert_enqueued(worker: @report, args: %{"requestId" => payload["requestId"]})
  end

  test "a secret's value is found nowhere: attempts, outcomes, jobs and logs; an echo in the output is redacted",
       context do
    echo =
      target!(fn %{headers: headers} ->
        key = headers |> List.keyfind("x-api-key", 0, {nil, nil}) |> elem(1)
        authorization = headers |> List.keyfind("authorization", 0, {nil, nil}) |> elem(1)
        body = %{"echo" => key, "list" => ["Bearer #{key}"], "authorization" => authorization}
        {200, @json, Jason.encode!(if key, do: Map.put(body, key, "as a key"), else: body)}
      end)

    secret!(context)
    with_key = payload(echo)

    with_basic =
      payload(echo, [
        &put_in(&1, ["request", "headers"], [["Accept", "application/json"]]),
        &put_in(&1, ["request", "basicAuth"], %{
          "username" => "chain",
          "password" => "{{secret:erp_api_key}}"
        })
      ])

    closed = StubServer.closed_port!()

    failing =
      payload(echo, [
        &put_in(&1, ["request", "url"], "http://#{@host}:#{closed}/v1/x"),
        &put_in(&1, ["destination", "port"], closed)
      ])

    # Oban's executor may run the job in a process of its own; it shares this test's connection. Info lines are captured too.
    Sandbox.mode(Repo, {:shared, self()})
    Logger.configure(level: :debug)
    on_exit(fn -> Logger.configure(level: :warning) end)

    log =
      capture_log([level: :debug], fn ->
        for payload <- [with_key, with_basic, failing] do
          Oban.insert!(
            ExecuteAutomation.new(%{"requestId" => payload["requestId"], "payload" => payload},
              max_attempts: 3
            )
          )
        end

        assert %{success: 2, failure: 1} = Oban.drain_queue(queue: :automation)
      end)

    assert outcome(with_key).output["body"] == %{
             "echo" => "[REDACTED:erp_api_key]",
             "list" => ["Bearer [REDACTED:erp_api_key]"],
             "authorization" => nil,
             "[REDACTED:erp_api_key]" => "as a key"
           }

    assert outcome(with_basic).output["body"]["authorization"] == "Basic [REDACTED:basic-auth]"

    stored =
      for table <- ["automation.attempts", "automation.outcomes", "automation.oban_jobs"],
          into: "" do
        Repo.query!("SELECT coalesce(string_agg(row_to_json(t)::text, ' '), '') FROM #{table} t").rows
        |> hd()
        |> hd()
      end

    assert stored =~ "connect_error"
    refute stored =~ @canary
    refute stored =~ Base.encode64("chain:" <> @canary)
    refute log =~ @canary
  end
end
