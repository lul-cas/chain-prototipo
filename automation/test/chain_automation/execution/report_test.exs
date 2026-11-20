defmodule ChainAutomation.Execution.ReportTest do
  use ExUnit.Case, async: true

  alias ChainAutomation.{ContractFixture, Repo, StoredResults}
  alias ChainAutomation.Execution.Report
  alias Ecto.Adapters.SQL.Sandbox

  setup do
    :ok = Sandbox.checkout(Repo)
  end

  for name <- ["result-succeeded.json", "result-failed.json"] do
    test "the shared #{name} is reproduced exactly from the stored outcome and attempts" do
      request_id = Ecto.UUID.generate()
      fixture = Map.put(ContractFixture.read!(unquote(name)), "requestId", request_id)
      StoredResults.store!(fixture, request_id)

      assert Report.body(request_id) == {:ok, fixture}
    end
  end

  test "a row still started at report time is reported as abandoned, with no duration" do
    request_id = Ecto.UUID.generate()
    fixture = ContractFixture.read!("result-failed.json")
    StoredResults.store!(fixture, request_id)

    Repo.query!(
      "INSERT INTO automation.attempts (request_id, number, started_at, outcome, summary) " <>
        "VALUES ($1, 2, '2026-10-16T12:00:09.5Z', 'started', $2)",
      [Ecto.UUID.dump!(request_id), hd(fixture["attempts"])["request"]]
    )

    assert {:ok, %{"attempts" => [_, abandoned]}} = Report.body(request_id)

    assert Map.take(abandoned, ["number", "startedAt", "durationMs", "outcome", "errorClass"]) ==
             %{
               "number" => 2,
               "startedAt" => "2026-10-16T12:00:09.500Z",
               "durationMs" => nil,
               "outcome" => "abandoned",
               "errorClass" => nil
             }
  end

  test "a request that ended without an attempt reports an empty list; nothing is reported before an outcome" do
    request_id = Ecto.UUID.generate()
    assert Report.body(request_id) == :none

    Repo.query!(
      "INSERT INTO automation.outcomes (request_id, activation, outcome, error) VALUES ($1, 3, 'failed', $2)",
      [
        Ecto.UUID.dump!(request_id),
        %{"class" => "deadline_passed", "message" => "The deadline passed.", "status" => nil}
      ]
    )

    assert {:ok, %{"attempts" => [], "activation" => 3, "output" => nil}} =
             Report.body(request_id)
  end

  test "an outcome already reported is not reported again" do
    request_id = Ecto.UUID.generate()
    StoredResults.store!(ContractFixture.read!("result-failed.json"), request_id)

    assert :ok = Report.reported!(request_id)
    assert Report.body(request_id) == :reported
  end
end
