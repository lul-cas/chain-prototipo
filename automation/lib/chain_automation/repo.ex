defmodule ChainAutomation.Repo do
  @moduledoc "Ecto repository for the `automation` schema owned by this subsystem (ADR-0005)."
  use Ecto.Repo, otp_app: :chain_automation, adapter: Ecto.Adapters.Postgres
end
