defmodule ChainAutomation.Workers.ReportResult do
  @moduledoc """
  Sends a request's final outcome to .NET (ADR-0011 §4; automation-contract.md §4 and §7, "ReportResult and wiring
  choices"). Its retries call only .NET, never the target. A 2xx marks the outcome reported. 401, 5xx and connection
  errors are retried, with a backoff capped at five minutes and no practical limit. 400, 404, 409 and 413 are definitive
  (§4.3) and cancel the job.
  """

  use Oban.Worker, queue: :results, max_attempts: 100_000

  require Logger

  alias ChainAutomation.Execution.Report
  alias ChainAutomation.Http.Internal

  @call_timeout_ms 30_000

  @impl Oban.Worker
  def timeout(_job), do: 60_000

  # 5 s, 10 s, 20 s… up to 300 s; the exponent is bounded so the number stays small.
  @impl Oban.Worker
  def backoff(%Oban.Job{attempt: attempt}), do: min(5 * Integer.pow(2, min(attempt - 1, 6)), 300)

  @impl Oban.Worker
  def perform(%Oban.Job{args: %{"requestId" => request_id}}) do
    case Report.body(request_id) do
      :none -> {:cancel, "No outcome is recorded for this request."}
      :reported -> :ok
      {:ok, body} -> send_result(request_id, body)
    end
  end

  defp send_result(request_id, body) do
    with {:ok, url, token} <- configuration() do
      case Internal.post_json(url, token, Jason.encode!(body), @call_timeout_ms) do
        {:ok, status} when status in 200..299 ->
          Report.reported!(request_id)

        {:ok, 401} ->
          Logger.error("The API refused the result token for request #{request_id}.")
          {:error, "The API refused the result token (HTTP 401)."}

        {:ok, status} when status in [400, 404, 409, 413] ->
          if status in [400, 409],
            do:
              Logger.error(
                "The API refused the result for request #{request_id} with HTTP #{status}."
              )

          {:cancel, "The API refused the result with HTTP #{status}."}

        {:ok, status} ->
          {:error, "The API answered HTTP #{status}."}

        {:error, reason} ->
          {:error, "The result could not be sent (#{reason})."}
      end
    end
  end

  defp configuration do
    config = Application.get_env(:chain_automation, :results) || []

    case {config[:url], config[:token]} do
      {url, token} when is_binary(url) and url != "" and is_binary(token) and token != "" ->
        {:ok, url, token}

      _ ->
        Logger.error("The result URL or token is not configured.")
        {:error, "The result URL or token is not configured."}
    end
  end
end
