defmodule ChainAutomation.ApplicationTest do
  use ExUnit.Case, async: true

  test "supervises the repo and Oban" do
    assert is_pid(Process.whereis(ChainAutomation.Repo))
    assert is_pid(Oban.whereis(Oban))
  end

  test "Oban keeps its tables in the automation schema owned by this subsystem (ADR-0005)" do
    assert Oban.config().prefix == "automation"
  end

  test "Oban runs the automation and results queues, with Lifeline and Pruner (automation-contract.md §7)" do
    config = Application.fetch_env!(:chain_automation, Oban)

    assert config[:queues] == [automation: 10, results: 5]

    # Lifeline rescues a job left executing by a crashed node; it must wait longer than the longest job (5.5 minutes).
    assert {Oban.Plugins.Lifeline, rescue_after: :timer.minutes(10)} in config[:plugins]
    assert {Oban.Plugins.Pruner, max_age: 7 * 24 * 60 * 60} in config[:plugins]
  end

  test "the relay poller is supervised, which starts the pipeline" do
    assert is_pid(Process.whereis(ChainAutomation.Relay.Poller))
  end
end
