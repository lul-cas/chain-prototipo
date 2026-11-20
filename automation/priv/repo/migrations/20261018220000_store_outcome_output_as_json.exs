defmodule ChainAutomation.Repo.Migrations.StoreOutcomeOutputAsJson do
  use Ecto.Migration

  # A target may answer a string with NUL, written \u0000. jsonb refuses it, so such an outcome could not be stored: every
  # attempt called the target again, and the step ended by timing out. json keeps the text as written, so the output reaches
  # .NET as it came, and .NET's output check judges it (automation-contract.md §7, "The outcome"; card #181). Going back
  # fails while a stored output holds NUL.
  def up do
    execute "ALTER TABLE automation.outcomes ALTER COLUMN output TYPE json USING output::json"
  end

  def down do
    execute "ALTER TABLE automation.outcomes ALTER COLUMN output TYPE jsonb USING output::jsonb"
  end
end
