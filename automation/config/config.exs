import Config

config :chain_automation, ecto_repos: [ChainAutomation.Repo]

# Unqualified names resolve to public only. In development both apps connect as `chain`, and PostgreSQL's default
# search_path ("$user", public) would otherwise resolve them into .NET's `chain` schema, which Elixir does not own (ADR-0005):
# Ecto's schema_migrations would land there on a second run. Every query of this app names its schema.
config :chain_automation, ChainAutomation.Repo,
  migration_default_prefix: "automation",
  parameters: [search_path: "public"]

# The queues and plugins of automation-contract.md §7: Lifeline rescues a job left executing by a crashed node, after longer
# than the longest job (an attempt's 5 minutes plus 30 s); Pruner removes finished jobs after 7 days.
config :chain_automation, Oban,
  repo: ChainAutomation.Repo,
  prefix: "automation",
  queues: [automation: 10, results: 5],
  plugins: [
    {Oban.Plugins.Lifeline, rescue_after: :timer.minutes(10)},
    {Oban.Plugins.Pruner, max_age: 7 * 24 * 60 * 60}
  ]

import_config "#{config_env()}.exs"
