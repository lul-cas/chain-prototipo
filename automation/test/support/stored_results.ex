defmodule ChainAutomation.StoredResults do
  @moduledoc "Rows of `automation.outcomes` and `automation.attempts` for the result fixtures of automation-contract.md §4.2."

  alias ChainAutomation.Repo

  @doc "Stores what ExecuteAutomation would have stored for a result fixture: its outcome and its attempts."
  def store!(fixture, request_id) do
    Repo.query!(
      "INSERT INTO automation.outcomes (request_id, activation, outcome, output, error) VALUES ($1, $2, $3, $4, $5)",
      [
        Ecto.UUID.dump!(request_id),
        fixture["activation"],
        fixture["outcome"],
        fixture["output"],
        fixture["error"]
      ]
    )

    for attempt <- fixture["attempts"] do
      {:ok, started_at, 0} = DateTime.from_iso8601(attempt["startedAt"])

      Repo.query!(
        "INSERT INTO automation.attempts (request_id, number, started_at, finished_at, duration_ms, outcome, error_class, status, " <>
          "response_bytes, summary) VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9)",
        [
          Ecto.UUID.dump!(request_id),
          attempt["number"],
          started_at,
          attempt["durationMs"],
          attempt["outcome"],
          attempt["errorClass"],
          attempt["status"],
          attempt["responseBytes"],
          attempt["request"]
        ]
      )
    end
  end
end
