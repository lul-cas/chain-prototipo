defmodule ChainAutomation.ContractFixture do
  @moduledoc """
  The shared fixtures of automation-contract.md in `specs/testing/automation-contract/`. Both test suites check them
  (ADR-0011 §11): a divergence between .NET and Elixir fails the build.
  """

  @dir Path.expand("../../../specs/testing/automation-contract", __DIR__)

  @spec read!(String.t()) :: map()
  def read!(name), do: @dir |> Path.join(name) |> File.read!() |> Jason.decode!()
end
