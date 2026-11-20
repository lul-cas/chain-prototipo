import Config

config :chain_automation, ChainAutomation.Repo,
  url: System.get_env("DATABASE_URL", "ecto://chain:chain@localhost:5432/chain_test"),
  pool: Ecto.Adapters.SQL.Sandbox

# Jobs are not executed automatically in tests; use Oban.Testing helpers.
config :chain_automation, Oban, testing: :manual

config :logger, level: :warning
