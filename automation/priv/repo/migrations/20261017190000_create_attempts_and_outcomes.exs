defmodule ChainAutomation.Repo.Migrations.CreateAttemptsAndOutcomes do
  use Ecto.Migration

  # Elixir's bookkeeping of execution (ADR-0011 §4; automation-contract.md §7): one row per attempt, metadata only
  # (ADR-0012 decision 8), and one final outcome per request, whose primary key makes it unique even if an attempt is
  # replayed after a crash.
  def change do
    create table(:attempts, primary_key: false) do
      add :request_id, :uuid, primary_key: true
      add :number, :integer, primary_key: true
      add :started_at, :timestamptz, null: false
      add :finished_at, :timestamptz
      add :duration_ms, :integer
      add :outcome, :text, null: false
      add :error_class, :text
      add :status, :integer
      add :response_bytes, :integer
      add :retry_after_seconds, :integer
      add :summary, :map, null: false
    end

    create constraint(:attempts, :attempts_outcome,
             check: "outcome IN ('started', 'succeeded', 'retryable_error', 'permanent_error', 'abandoned')"
           )

    create table(:outcomes, primary_key: false) do
      add :request_id, :uuid, primary_key: true
      add :activation, :integer, null: false
      add :outcome, :text, null: false
      add :output, :map
      add :error, :map
      add :recorded_at, :timestamptz, null: false, default: fragment("now()")
      add :reported_at, :timestamptz
    end

    create constraint(:outcomes, :outcomes_outcome, check: "outcome IN ('succeeded', 'failed')")
  end
end
