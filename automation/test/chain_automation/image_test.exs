defmodule ChainAutomation.ImageTest do
  # What the automation image must set (automation.md §4.1).
  use ExUnit.Case, async: true

  @dockerfile Path.expand("../../Dockerfile", __DIR__)

  # Card #164: the service holds the KEKs in memory, and a crash dump of the Erlang VM would write them to disk.
  test "the image disables Erlang crash dumps" do
    assert File.read!(@dockerfile) =~ ~r/^ENV ERL_CRASH_DUMP_SECONDS=0$/m
  end
end
