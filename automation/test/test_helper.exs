ExUnit.start()

# Elixir reads .NET's views; the test database gets a stand-in of them (automation-contract.md §2).
ChainAutomation.ChainViews.create!()
Ecto.Adapters.SQL.Sandbox.mode(ChainAutomation.Repo, :manual)
