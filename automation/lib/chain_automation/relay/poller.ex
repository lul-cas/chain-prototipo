defmodule ChainAutomation.Relay.Poller do
  @moduledoc """
  Runs the relay every second while this node leads the Oban cluster (ADR-0011 §3 and decision 3). Correctness does not
  depend on leadership: it only keeps the other nodes from polling. A failed poll is logged, and the next one runs as usual.
  """

  use GenServer

  require Logger

  @doc """
  Options: `:interval` in milliseconds (1 000), `:leader?` (asks `Oban.Peer`), `:run` (`ChainAutomation.Relay.run_once/0`)
  and `:name`.
  """
  def start_link(opts),
    do: GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))

  @impl true
  def init(opts) do
    state = %{
      interval: Keyword.get(opts, :interval, 1_000),
      leader?: Keyword.get(opts, :leader?, fn -> Oban.Peer.leader?(Oban) end),
      run: Keyword.get(opts, :run, &ChainAutomation.Relay.run_once/0)
    }

    {:ok, schedule(state)}
  end

  @impl true
  def handle_info(:poll, state) do
    if state.leader?.() do
      try do
        state.run.()
      rescue
        exception ->
          Logger.error("The automation relay could not poll: " <> Exception.message(exception))
      end
    end

    {:noreply, schedule(state)}
  end

  defp schedule(state) do
    Process.send_after(self(), :poll, state.interval)
    state
  end
end
