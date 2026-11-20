defmodule ChainAutomation.Workers.ReportResultTest do
  # The results configuration is global, so these tests do not run alongside others.
  use ExUnit.Case, async: false
  use Oban.Testing, repo: ChainAutomation.Repo, prefix: "automation"

  import ExUnit.CaptureLog

  alias ChainAutomation.{ContractFixture, Repo, StoredResults, StubServer}
  alias ChainAutomation.Execution.Report
  alias ChainAutomation.Workers.ReportResult
  alias Ecto.Adapters.SQL.Sandbox

  @token "test-only-result-token"

  setup do
    :ok = Sandbox.checkout(Repo)
    on_exit(fn -> Application.delete_env(:chain_automation, :results) end)
    request_id = Ecto.UUID.generate()
    fixture = Map.put(ContractFixture.read!("result-failed.json"), "requestId", request_id)
    StoredResults.store!(fixture, request_id)
    %{request_id: request_id, fixture: fixture}
  end

  # The API's internal listener, played by the stub on a private address.
  defp api!(handler) do
    server = StubServer.start!(handler)
    url = "http://#{:inet.ntoa(server.ip)}:#{server.port}/internal/automation/results"
    Application.put_env(:chain_automation, :results, url: url, token: @token)
    server
  end

  defp perform(request_id), do: perform_job(ReportResult, %{"requestId" => request_id})

  test "the result goes to the internal endpoint with the token; a 2xx marks it reported and ends the job",
       context do
    api!(fn _ -> {200, [{"content-type", "application/json"}], ~s({"applied":true})} end)

    assert perform(context.request_id) == :ok

    assert_received {:stub_request,
                     %{
                       method: "POST",
                       path: "/internal/automation/results",
                       headers: headers,
                       body: body
                     }}

    assert {"authorization", "Bearer #{@token}"} in headers
    assert {"content-type", "application/json"} in headers
    assert Jason.decode!(body) == context.fixture
    assert Report.body(context.request_id) == :reported

    assert perform(context.request_id) == :ok
    refute_received {:stub_request, _}
  end

  # Regression #181: an output with NUL could not be stored (jsonb refuses \u0000), so it never reached .NET, whose output
  # check makes a declared output that holds it automation_output_invalid and ignores it elsewhere (automation.md §7.2).
  test "an output with NUL reaches the API as it came" do
    api!(fn _ -> {200, [{"content-type", "application/json"}], ~s({"applied":true})} end)
    request_id = Ecto.UUID.generate()

    fixture =
      ContractFixture.read!("result-succeeded.json")
      |> Map.put("requestId", request_id)
      |> put_in(["output", "body"], %{
        "resultado" => %{"situacao" => "regu\u0000lar", "nota\u0000" => 1}
      })

    StoredResults.store!(fixture, request_id)

    assert perform(request_id) == :ok
    assert_received {:stub_request, %{body: body}}
    assert body =~ ~S("situacao":"regu\u0000lar")
    assert Jason.decode!(body) == fixture
  end

  test "400, 404, 409 and 413 cancel the job; 400 and 409 are logged as errors", context do
    for {status, logged} <- [{400, true}, {404, false}, {409, true}, {413, false}] do
      api!(fn _ -> {status, [], ""} end)

      log =
        capture_log(fn ->
          assert perform(context.request_id) ==
                   {:cancel, "The API refused the result with HTTP #{status}."}
        end)

      assert log =~
               "The API refused the result for request #{context.request_id} with HTTP #{status}." ==
               logged,
             "#{status}"
    end

    refute Report.body(context.request_id) == :reported
  end

  test "401, 5xx and connection errors are retried; a refused token is logged as an error",
       context do
    api!(fn _ -> {401, [], ""} end)

    log =
      capture_log(fn ->
        assert perform(context.request_id) ==
                 {:error, "The API refused the result token (HTTP 401)."}
      end)

    assert log =~ "The API refused the result token for request #{context.request_id}."

    api!(fn _ -> {503, [], ""} end)
    assert perform(context.request_id) == {:error, "The API answered HTTP 503."}

    url =
      "http://#{:inet.ntoa(StubServer.private_address!())}:#{StubServer.closed_port!()}/internal/automation/results"

    Application.put_env(:chain_automation, :results, url: url, token: @token)
    assert perform(context.request_id) == {:error, "The result could not be sent (econnrefused)."}

    refute Report.body(context.request_id) == :reported
  end

  test "without the URL or the token, the report fails, is retried and logged", context do
    for config <- [nil, [url: "http://api:8081/internal/automation/results"], [token: @token]] do
      if config,
        do: Application.put_env(:chain_automation, :results, config),
        else: Application.delete_env(:chain_automation, :results)

      log =
        capture_log(fn ->
          assert perform(context.request_id) ==
                   {:error, "The result URL or token is not configured."}
        end)

      assert log =~ "The result URL or token is not configured."
    end
  end

  test "a request with no outcome has nothing to report" do
    assert perform(Ecto.UUID.generate()) == {:cancel, "No outcome is recorded for this request."}
  end

  test "the backoff doubles from 5 s up to 300 s, and the job has a time limit" do
    assert Enum.map([1, 2, 3, 6, 7, 50, 100_000], &ReportResult.backoff(%Oban.Job{attempt: &1})) ==
             [5, 10, 20, 160, 300, 300, 300]

    assert ReportResult.timeout(%Oban.Job{}) == 60_000
  end
end
