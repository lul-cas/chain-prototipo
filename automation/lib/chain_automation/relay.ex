defmodule ChainAutomation.Relay do
  @moduledoc """
  Moves work requests from .NET's outbox view, `chain.automation_dispatch_v1`, into Oban (ADR-0011 §3; automation-contract.md
  §7, "Relay choices"). Each row is accepted in its own transaction: the marker in `automation.accepted_requests` first, and
  only when it was inserted, the `ExecuteAutomation` job, or for a `cancel`, the cancellation of a job still waiting. A
  relay working from a stale batch therefore finds the marker taken and relays nothing twice.
  """

  import Ecto.Query

  alias ChainAutomation.Repo

  @batch 100
  @worker "ChainAutomation.Workers.ExecuteAutomation"

  @type row :: %{
          request_id: String.t(),
          kind: String.t(),
          cancels_request_id: String.t() | nil,
          payload: map() | nil
        }

  @doc "Relays one batch of pending requests, oldest first; returns how many were accepted."
  @spec run_once() :: non_neg_integer()
  def run_once, do: accept(pending())

  @doc "Up to #{@batch} pending requests that no relay has accepted yet, oldest first."
  @spec pending() :: [row()]
  def pending do
    """
    SELECT v.request_id, v.kind, v.cancels_request_id, v.payload
    FROM chain.automation_dispatch_v1 v
    WHERE NOT EXISTS (SELECT 1 FROM automation.accepted_requests a WHERE a.request_id = v.request_id)
    ORDER BY v.created_at, v.request_id
    LIMIT $1
    """
    |> Repo.query!([@batch])
    |> Map.fetch!(:rows)
    |> Enum.map(fn [id, kind, cancels, payload] ->
      %{
        request_id: Ecto.UUID.load!(id),
        kind: kind,
        cancels_request_id: cancels && Ecto.UUID.load!(cancels),
        payload: payload
      }
    end)
  end

  @doc "Accepts each row in its own transaction; returns how many this call accepted."
  @spec accept([row()]) :: non_neg_integer()
  def accept(rows), do: Enum.count(rows, &accept_row/1)

  defp accept_row(row) do
    {:ok, accepted?} =
      Repo.transaction(fn ->
        if mark(row.request_id, row.kind) do
          act(row)
          true
        else
          false
        end
      end)

    accepted?
  end

  # The marker's primary key decides: a relay that loses the race waits for the winner's commit and inserts nothing.
  defp mark(request_id, kind) do
    %{num_rows: inserted} =
      Repo.query!(
        "INSERT INTO automation.accepted_requests (request_id, kind) VALUES ($1, $2) ON CONFLICT (request_id) DO NOTHING",
        [Ecto.UUID.dump!(request_id), kind]
      )

    inserted == 1
  end

  defp act(%{kind: "execute", request_id: request_id, payload: payload}) do
    job =
      Oban.insert!(
        Oban.Job.new(%{"requestId" => request_id, "payload" => payload},
          worker: @worker,
          queue: :automation,
          max_attempts: max_attempts(payload),
          meta: %{
            "correlationId" => field(payload, "correlationId"),
            "traceparent" => field(payload, "traceparent")
          }
        )
      )

    Repo.query!("UPDATE automation.accepted_requests SET job_id = $2 WHERE request_id = $1", [
      Ecto.UUID.dump!(request_id),
      job.id
    ])
  end

  # An executing attempt is not interrupted: the call may already be under way, and .NET ignores its result.
  defp act(%{kind: "cancel", cancels_request_id: cancels}) do
    %{rows: rows} =
      Repo.query!(
        "SELECT job_id FROM automation.accepted_requests WHERE request_id = $1 AND kind = 'execute'",
        [
          Ecto.UUID.dump!(cancels)
        ]
      )

    with [[job_id]] when is_integer(job_id) <- rows do
      Oban.cancel_all_jobs(
        where(
          Oban.Job,
          [j],
          j.id == ^job_id and j.state in ["available", "scheduled", "retryable"]
        )
      )
    end
  end

  defp max_attempts(%{"execution" => %{"maxAttempts" => attempts}})
       when is_integer(attempts) and attempts in 1..10,
       do: attempts

  defp max_attempts(_payload), do: 1

  defp field(payload, key) when is_map(payload), do: payload[key]
  defp field(_payload, _key), do: nil
end
