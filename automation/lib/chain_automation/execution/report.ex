defmodule ChainAutomation.Execution.Report do
  @moduledoc """
  The result body of automation-contract.md §4.2, built from `automation.outcomes` and `automation.attempts` ("ReportResult
  and wiring choices"). Attempts appear in order, with `startedAt` in UTC to the millisecond; a row still `started` at
  report time was left by a crash and is reported as `abandoned`. Its duration was never recorded, so it is null.
  """

  alias ChainAutomation.Repo

  @doc "The body to send, `:reported` when .NET already accepted it, or `:none` before an outcome is recorded."
  @spec body(String.t()) :: {:ok, map()} | :reported | :none
  def body(request_id) do
    id = Ecto.UUID.dump!(request_id)

    case Repo.query!(
           "SELECT activation, outcome, output, error, reported_at FROM automation.outcomes WHERE request_id = $1",
           [id]
         ).rows do
      [] ->
        :none

      [[_activation, _outcome, _output, _error, %DateTime{}]] ->
        :reported

      [[activation, outcome, output, error, nil]] ->
        {:ok,
         %{
           "contractVersion" => 1,
           "requestId" => request_id,
           "activation" => activation,
           "outcome" => outcome,
           "output" => output,
           "error" => error,
           "attempts" => attempts(id)
         }}
    end
  end

  @doc "Records that .NET accepted the result, so it is not sent again."
  @spec reported!(String.t()) :: :ok
  def reported!(request_id) do
    Repo.query!("UPDATE automation.outcomes SET reported_at = now() WHERE request_id = $1", [
      Ecto.UUID.dump!(request_id)
    ])

    :ok
  end

  defp attempts(id) do
    ("SELECT number, started_at, duration_ms, outcome, error_class, status, response_bytes, summary " <>
       "FROM automation.attempts WHERE request_id = $1 ORDER BY number")
    |> Repo.query!([id])
    |> Map.fetch!(:rows)
    |> Enum.map(fn [number, started_at, duration_ms, outcome, error_class, status, bytes, summary] ->
      outcome = if outcome == "started", do: "abandoned", else: outcome

      %{
        "number" => number,
        "startedAt" => started_at |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601(),
        "durationMs" => duration_ms,
        "outcome" => outcome,
        "errorClass" => error_class,
        "status" => status,
        "responseBytes" => bytes,
        "request" => summary
      }
    end)
  end
end
