defmodule ChainAutomation.Application do
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    # A malformed KEK configuration raises here and stops the application, as it stops the API (automation-contract.md §5).
    ChainAutomation.Contract.Keks.load!(Application.get_env(:chain_automation, :keks))

    children = [
      ChainAutomation.Repo,
      {Oban, Application.fetch_env!(:chain_automation, Oban)},
      # Moves work requests from .NET's outbox into Oban while this node leads (ADR-0011 §3).
      ChainAutomation.Relay.Poller
    ]

    opts = [strategy: :one_for_one, name: ChainAutomation.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
