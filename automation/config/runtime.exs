import Config

if config_env() in [:dev, :prod] do
  config :chain_automation, ChainAutomation.Repo,
    url: System.get_env("DATABASE_URL") || raise("DATABASE_URL is not set"),
    pool_size: String.to_integer(System.get_env("POOL_SIZE", "10"))

  # The key-encryption keys that open secrets (automation-contract.md §5). Elixir only decrypts, so it reads no active KEK.
  config :chain_automation, keks: System.get_env("CHAIN_AUTOMATION_KEKS")

  # Where results are reported: the API's internal listener, with the result token (automation-contract.md §4.1).
  config :chain_automation, :results,
    url: System.get_env("CHAIN_AUTOMATION_RESULT_URL"),
    token: System.get_env("CHAIN_AUTOMATION_RESULT_TOKEN")
end

if config_env() == :prod do
  for name <- ["CHAIN_AUTOMATION_RESULT_URL", "CHAIN_AUTOMATION_RESULT_TOKEN"],
      System.get_env(name) in [nil, ""] do
    raise "#{name} is not set"
  end

  # docker-compose.yml's development KEK and result token are published: refused outside development (automation.md §4.1).
  ChainAutomation.Contract.DevelopmentValues.refuse!(
    System.get_env("CHAIN_AUTOMATION_KEKS"),
    System.get_env("CHAIN_AUTOMATION_RESULT_TOKEN")
  )
end
