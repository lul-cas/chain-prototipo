defmodule ChainAutomation.Workers.ExecuteAutomation do
  @moduledoc """
  One attempt of an automation request (ADR-0011 §4; automation-contract.md §7, "ExecuteAutomation choices").

  Before the attempt: an outcome already recorded goes straight to reporting; a request no longer pending cancels the job;
  then the payload, the deadline, the URL and the size, and the secrets are checked, in that order. The attempt is
  recorded, the adapter makes the call, and the result is scrubbed of secret values. A success, a permanent failure, or a
  retryable failure on the last attempt is the final outcome, recorded with its `ReportResult` job; a retryable failure
  before that returns an error, and Oban schedules the next attempt with the backoff of automation.md §8.2.
  """

  use Oban.Worker, queue: :automation

  require Logger

  alias ChainAutomation.Contract.{Keks, WorkRequest}
  alias ChainAutomation.Execution.{Attempts, Outcomes, Redaction, Secrets}
  alias ChainAutomation.Http.{Client, Destination, Request}
  alias ChainAutomation.Repo

  @max_timeout_ms 300_000
  @max_delay_ms 300_000

  @impl Oban.Worker
  def timeout(%Oban.Job{args: args}),
    do: execution(args, "timeoutMs", 1_000..@max_timeout_ms, @max_timeout_ms) + 30_000

  # Before attempt n + 1: d(n) = min(initialDelay × 2^(n−1), 300 s), with a jitter in [1, 1.1); a longer Retry-After wins.
  @impl Oban.Worker
  def backoff(%Oban.Job{attempt: attempt, args: %{"requestId" => request_id} = args}) do
    initial = execution(args, "initialDelayMs", 1_000..60_000, 5_000)

    delay_ms =
      min(initial * Integer.pow(2, attempt - 1), @max_delay_ms) * (1 + :rand.uniform() * 0.1)

    max(ceil(delay_ms / 1_000), Attempts.last_retry_after(request_id) || 0)
  end

  @impl Oban.Worker
  def perform(%Oban.Job{args: %{"requestId" => request_id, "payload" => payload}} = job) do
    cond do
      Outcomes.recorded?(request_id) -> :ok
      not pending?(request_id) -> {:cancel, "The request is no longer pending."}
      true -> attempt(job, request_id, payload)
    end
  rescue
    # Sanitized like the adapter's (ADR-0012 Part 3 rule 4): the module only. A started row becomes abandoned next time.
    exception ->
      Logger.error(
        "An automation attempt failed unexpectedly (#{inspect(exception.__struct__)}).",
        request_id: request_id
      )

      {:error,
       "internal_error: The attempt failed unexpectedly (#{inspect(exception.__struct__)})."}
  end

  defp pending?(request_id) do
    Repo.query!("SELECT 1 FROM chain.automation_dispatch_v1 WHERE request_id = $1", [
      Ecto.UUID.dump!(request_id)
    ]).num_rows ==
      1
  end

  defp attempt(job, request_id, payload) do
    with {:ok, work} <- WorkRequest.parse(payload),
         :ok <- deadline(work) do
      run(job, work)
    else
      {:error, class, message} ->
        finish(request_id, activation(payload), {:error, failure(class, message)})
    end
  end

  defp deadline(work) do
    if DateTime.compare(DateTime.utc_now(), work.deadline_at) == :lt,
      do: :ok,
      else: {:error, :deadline_passed, "The deadline passed before the attempt started."}
  end

  defp run(job, work) do
    Attempts.abandon_started!(work.request_id)
    started = System.monotonic_time(:millisecond)

    {secrets, versions} =
      case precheck(work) do
        :ok -> Secrets.read(work, Keks.current())
        refusal -> {refusal, %{}}
      end

    Attempts.start!(
      work.request_id,
      job.attempt,
      DateTime.utc_now(),
      Attempts.summary(work, versions)
    )

    {result, redactions} = call(work, secrets)
    result = scrub(result, redactions)
    ended = ended(result, System.monotonic_time(:millisecond) - started)
    Attempts.finish!(work.request_id, job.attempt, ended)

    Logger.info("An automation attempt ended.",
      request_id: work.request_id,
      attempt: job.attempt,
      outcome: ended.outcome,
      error_class: ended.error_class,
      status: ended.status,
      duration_ms: ended.duration_ms
    )

    decide(job, work, result)
  end

  # automation.md §8.1 step 2, before the secrets are read.
  defp precheck(work) do
    limit = work.destination.max_request_bytes

    with :ok <- Destination.check_url(work.url, work.destination) do
      if byte_size(work.body || "") > limit,
        do: {:error, :request_too_large, "The request body is larger than #{limit} bytes."},
        else: :ok
    end
  end

  defp call(work, {:ok, values}) do
    case Request.build(work, values) do
      {:ok, request} ->
        {Client.call(request, Client.settings(work), client_options()),
         Redaction.values(values, request)}

      {:error, class, message} ->
        {{:error, failure(class, message)}, Redaction.values(values, nil)}
    end
  end

  defp call(_work, {:error, class, message}), do: {{:error, failure(class, message)}, []}

  # An answer whose keys scrubbing would merge is refused rather than stored with a value lost (card #190).
  defp scrub({:ok, response}, values) do
    case Redaction.scrub_answer(response.body, values) do
      {:ok, body} ->
        {:ok, %{response | body: body}}

      :keys_merged ->
        failure =
          failure(
            :invalid_response,
            "The answer has keys that are the same once secrets are redacted."
          )

        {:error, %{failure | status: response.status, bytes: response.bytes}}
    end
  end

  defp scrub({:error, failure}, values),
    do: {:error, %{failure | message: Redaction.scrub(failure.message, values)}}

  defp ended({:ok, response}, duration_ms) do
    %{
      outcome: "succeeded",
      error_class: nil,
      status: response.status,
      response_bytes: response.bytes,
      retry_after_seconds: nil,
      duration_ms: duration_ms
    }
  end

  defp ended({:error, failure}, duration_ms) do
    %{
      outcome: if(failure.retryable, do: "retryable_error", else: "permanent_error"),
      error_class: Atom.to_string(failure.class),
      status: failure.status,
      response_bytes: failure.bytes,
      retry_after_seconds: failure.retry_after,
      duration_ms: duration_ms
    }
  end

  defp decide(job, _work, {:error, %{retryable: true} = failure})
       when job.attempt < job.max_attempts,
       do: {:error, "#{failure.class}: #{failure.message}"}

  defp decide(_job, work, result), do: finish(work.request_id, work.activation, result)

  defp finish(request_id, activation, {:ok, response}) do
    Outcomes.record!(
      request_id,
      activation,
      "succeeded",
      %{"status" => response.status, "body" => response.body},
      nil
    )
  end

  defp finish(request_id, activation, {:error, failure}),
    do: Outcomes.record!(request_id, activation, "failed", nil, Outcomes.error(failure))

  defp failure(class, message) do
    %{
      class: class,
      message: message,
      status: nil,
      retryable: class in [:timeout, :connect_error, :internal_error],
      retry_after: nil,
      bytes: nil
    }
  end

  # A broken payload is reported with its own activation when that is valid, and 1 otherwise.
  defp activation(%{"activation" => activation}) when is_integer(activation) and activation >= 1,
    do: activation

  defp activation(_payload), do: 1

  defp execution(%{"payload" => %{"execution" => %{} = execution}}, key, range, default) do
    case execution[key] do
      value when is_integer(value) -> if value in range, do: value, else: default
      _ -> default
    end
  end

  defp execution(_args, _key, _range, default), do: default

  defp client_options,
    do: :chain_automation |> Application.get_env(__MODULE__, []) |> Keyword.get(:client, [])
end
