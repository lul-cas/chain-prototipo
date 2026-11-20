defmodule ChainAutomation.RepoTest do
  use ExUnit.Case, async: true

  alias ChainAutomation.Repo
  alias Ecto.Adapters.SQL.Sandbox

  setup do
    :ok = Sandbox.checkout(Repo)
  end

  # In development both apps connect as `chain`, whose "$user" schema is .NET's `chain` (the test database has a stand-in
  # of it). An unqualified name, such as Ecto's own schema_migrations, would then resolve into a schema Elixir does not own
  # (ADR-0005), and a second `mix ecto.migrate` would find no versions there and run every migration again.
  test "unqualified names resolve to public only, never into .NET's chain schema" do
    assert Repo.query!("SELECT current_schemas(false)").rows == [[["public"]]]
  end
end
