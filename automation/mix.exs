defmodule ChainAutomation.MixProject do
  use Mix.Project

  def project do
    [
      app: :chain_automation,
      version: "0.1.0",
      elixir: "~> 1.20",
      elixirc_paths: elixirc_paths(Mix.env()),
      start_permanent: Mix.env() == :prod,
      aliases: aliases(),
      deps: deps()
    ]
  end

  # Run "mix help compile.app" to learn about applications.
  def application do
    [
      extra_applications: [:logger],
      mod: {ChainAutomation.Application, []}
    ]
  end

  # The shared contract fixtures are read through test/support (automation-contract.md, ADR-0011 §11).
  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  # Run "mix help deps" to learn about dependencies.
  defp deps do
    [
      {:oban, "~> 2.24"},
      {:ecto_sql, "~> 3.14"},
      {:postgrex, "~> 0.22.4"},
      {:jason, "~> 1.4"},
      # The HTTP client of automation calls: it connects to a checked address (ADR-0012 Part 2 rule 8).
      {:mint, "~> 1.11"}
    ]
  end

  defp aliases do
    [
      "ecto.setup": ["ecto.create", "ecto.migrate"],
      test: ["ecto.create --quiet", "ecto.migrate --quiet", "test"]
    ]
  end
end
