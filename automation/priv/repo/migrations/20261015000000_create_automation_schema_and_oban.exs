defmodule ChainAutomation.Repo.Migrations.CreateAutomationSchemaAndOban do
  use Ecto.Migration

  def up do
    execute "CREATE SCHEMA IF NOT EXISTS automation"
    Oban.Migration.up(prefix: "automation")
  end

  def down do
    Oban.Migration.down(prefix: "automation", version: 1)
  end
end
