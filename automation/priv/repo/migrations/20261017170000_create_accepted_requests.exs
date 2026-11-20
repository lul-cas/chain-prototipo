defmodule ChainAutomation.Repo.Migrations.CreateAcceptedRequests do
  use Ecto.Migration

  # The relay's marker (ADR-0011 §3; automation-contract.md §7): one row per work request accepted from .NET's outbox,
  # inserted in the same transaction as its Oban job. The primary key makes concurrent relays relay a request once.
  def change do
    create table(:accepted_requests, primary_key: false) do
      add :request_id, :uuid, primary_key: true
      add :kind, :text, null: false
      add :job_id, :bigint
      add :accepted_at, :timestamptz, null: false, default: fragment("now()")
    end

    create constraint(:accepted_requests, :accepted_requests_kind, check: "kind IN ('execute', 'cancel')")
  end
end
