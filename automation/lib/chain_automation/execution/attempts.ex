defmodule ChainAutomation.Execution.Attempts do
  @moduledoc """
  `automation.attempts` (automation-contract.md §7): one row per attempt, inserted as `started` before any network
  traffic and updated when the attempt ends. A row still `started` when the next attempt begins was left by a crash and
  becomes `abandoned`. The summary is the request as built (ADR-0012 Part 3 §2): names only, never values.
  """

  alias ChainAutomation.Contract.WorkRequest
  alias ChainAutomation.Repo

  @spec abandon_started!(String.t()) :: :ok
  def abandon_started!(request_id) do
    Repo.query!(
      "UPDATE automation.attempts SET outcome = 'abandoned' WHERE request_id = $1 AND outcome = 'started'",
      [
        Ecto.UUID.dump!(request_id)
      ]
    )

    :ok
  end

  @spec start!(String.t(), pos_integer(), DateTime.t(), map()) :: :ok
  def start!(request_id, number, started_at, summary) do
    Repo.query!(
      "INSERT INTO automation.attempts (request_id, number, started_at, outcome, summary) VALUES ($1, $2, $3, 'started', $4) " <>
        "ON CONFLICT (request_id, number) DO UPDATE SET started_at = EXCLUDED.started_at, outcome = 'started', " <>
        "summary = EXCLUDED.summary, finished_at = NULL, duration_ms = NULL, error_class = NULL, status = NULL, " <>
        "response_bytes = NULL, retry_after_seconds = NULL",
      [Ecto.UUID.dump!(request_id), number, started_at, summary]
    )

    :ok
  end

  @spec finish!(String.t(), pos_integer(), map()) :: :ok
  def finish!(request_id, number, ended) do
    Repo.query!(
      "UPDATE automation.attempts SET finished_at = now(), duration_ms = $3, outcome = $4, error_class = $5, status = $6, " <>
        "response_bytes = $7, retry_after_seconds = $8 WHERE request_id = $1 AND number = $2",
      [
        Ecto.UUID.dump!(request_id),
        number,
        ended.duration_ms,
        ended.outcome,
        ended.error_class,
        ended.status,
        ended.response_bytes,
        ended.retry_after_seconds
      ]
    )

    :ok
  end

  @doc "The `Retry-After` of the request's latest attempt, in seconds, if it had one."
  @spec last_retry_after(String.t()) :: non_neg_integer() | nil
  def last_retry_after(request_id) do
    case Repo.query!(
           "SELECT retry_after_seconds FROM automation.attempts WHERE request_id = $1 ORDER BY number DESC LIMIT 1",
           [Ecto.UUID.dump!(request_id)]
         ).rows do
      [[seconds]] -> seconds
      [] -> nil
    end
  end

  @doc "The request summary of automation-contract.md §4.2, with the versions of the secrets that were read."
  @spec summary(WorkRequest.t(), %{String.t() => pos_integer()}) :: map()
  def summary(%WorkRequest{} = work, versions) do
    uri = URI.parse(work.url)

    added =
      if(work.basic_auth, do: ["Authorization"], else: []) ++
        if work.idempotency, do: [elem(work.idempotency, 0)], else: []

    %{
      "method" => work.method,
      "destination" => work.destination.name,
      "host" => uri.host,
      "path" => uri.path,
      "queryNames" =>
        if(uri.query,
          do: uri.query |> URI.query_decoder(:rfc3986) |> Enum.map(&elem(&1, 0)),
          else: []
        ),
      "headerNames" => Enum.sort(Enum.map(work.headers, &elem(&1, 0)) ++ added),
      "secrets" => Enum.map(work.secrets, &%{"name" => &1, "version" => versions[&1]})
    }
  end
end
