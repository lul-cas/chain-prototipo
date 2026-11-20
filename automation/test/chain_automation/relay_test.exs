defmodule ChainAutomation.RelayTest do
  # The relay's guarantees are about concurrent transactions, so these tests commit for real instead of inside the sandbox's
  # wrapping transaction, and clean the tables they use.
  use ExUnit.Case, async: false

  import Ecto.Query
  import ExUnit.CaptureLog

  alias ChainAutomation.{ChainViews, ContractFixture, Relay, Repo}
  alias Ecto.Adapters.SQL.Sandbox

  @worker "ChainAutomation.Workers.ExecuteAutomation"

  setup do
    connect!()
    clean!()

    on_exit(fn ->
      connect!()
      clean!()
    end)

    %{payload: ContractFixture.read!("work-request.json")["expected"]}
  end

  # A connection that commits; the on_exit callbacks share one process, so the second finds it already checked out.
  defp connect! do
    case Sandbox.checkout(Repo, sandbox: false) do
      :ok -> :ok
      {:already, :owner} -> :ok
    end
  end

  defp clean!,
    do:
      Repo.query!(
        "TRUNCATE chain.automation_work_requests, automation.accepted_requests, automation.oban_jobs"
      )

  defp execute!(payload, opts \\ []) do
    id = Ecto.UUID.generate()

    ChainViews.insert!(
      id,
      "execute",
      Keyword.put(opts, :payload, Map.put(payload, "requestId", id))
    )
  end

  defp cancel!(request_id) do
    ChainViews.set_status!(request_id, "cancelled")
    ChainViews.insert!(Ecto.UUID.generate(), "cancel", cancels: request_id)
  end

  defp jobs do
    from(j in Oban.Job,
      order_by: j.id,
      select: map(j, [:id, :worker, :queue, :state, :args, :max_attempts, :meta])
    )
    |> Repo.all(prefix: "automation")
  end

  defp markers do
    Repo.query!(
      "SELECT request_id, kind, job_id FROM automation.accepted_requests ORDER BY job_id NULLS LAST"
    ).rows
    |> Enum.map(fn [id, kind, job_id] -> {Ecto.UUID.load!(id), kind, job_id} end)
  end

  test "each pending execute request becomes one ExecuteAutomation job, oldest first, recorded in its marker",
       %{payload: payload} do
    first = execute!(payload, created_at: ~U[2026-10-17 12:00:00Z])
    second = execute!(payload, created_at: ~U[2026-10-17 12:00:01Z])

    assert Relay.run_once() == 2

    assert [job, later] = jobs()

    assert {job.worker, job.queue, job.state, job.max_attempts} ==
             {@worker, "automation", "available", 5}

    assert job.args == %{"requestId" => first, "payload" => Map.put(payload, "requestId", first)}

    assert job.meta == %{
             "correlationId" => "4bf92f3577b34da6a3ce929d0e0e4736",
             "traceparent" => nil
           }

    assert later.args["requestId"] == second
    assert markers() == [{first, "execute", job.id}, {second, "execute", later.id}]
  end

  test "a request is relayed once: a later poll and a relay working from a stale batch accept nothing",
       %{payload: payload} do
    execute!(payload)
    execute!(payload)
    stale = Relay.pending()

    assert Relay.run_once() == 2
    assert Relay.run_once() == 0
    assert Relay.accept(stale) == 0
    assert length(jobs()) == 2
  end

  test "the marker and the job are written together: when the job fails, the next poll tries again",
       %{payload: payload} do
    execute!(payload)

    Repo.query!("""
    CREATE FUNCTION automation.refuse_job() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'job refused for the test'; END $$
    """)

    Repo.query!(
      "CREATE TRIGGER refuse_job BEFORE INSERT ON automation.oban_jobs FOR EACH ROW EXECUTE FUNCTION automation.refuse_job()"
    )

    on_exit(fn ->
      connect!()
      Repo.query!("DROP TRIGGER IF EXISTS refuse_job ON automation.oban_jobs")
      Repo.query!("DROP FUNCTION IF EXISTS automation.refuse_job()")
    end)

    assert_raise Postgrex.Error, ~r/job refused for the test/, fn -> Relay.run_once() end
    assert markers() == []

    Repo.query!("DROP TRIGGER refuse_job ON automation.oban_jobs")
    assert Relay.run_once() == 1
    assert length(jobs()) == 1
  end

  test "concurrent relays relay each request once", %{payload: payload} do
    ids = for _ <- 1..30, do: execute!(payload)

    accepted =
      1..4
      |> Enum.map(fn _ ->
        Task.async(fn ->
          :ok = Sandbox.checkout(Repo, sandbox: false)
          Relay.run_once()
        end)
      end)
      |> Task.await_many(30_000)

    assert Enum.sum(accepted) == 30
    assert jobs() |> Enum.map(& &1.args["requestId"]) |> Enum.sort() == Enum.sort(ids)
    assert markers() |> Enum.map(&elem(&1, 2)) |> Enum.sort() == jobs() |> Enum.map(& &1.id)
  end

  test "rows that are no longer pending are not relayed", %{payload: payload} do
    for status <- ["completed", "failed", "cancelled", "timed_out"],
        do: execute!(payload, status: status)

    assert Relay.run_once() == 0
    assert jobs() == []
  end

  test "a cancel stops a job still waiting for an attempt; an executing attempt goes on", %{
    payload: payload
  } do
    waiting = execute!(payload)
    retrying = execute!(payload)
    running = execute!(payload)
    assert Relay.run_once() == 3

    [_, retry_job, run_job] = jobs()

    Repo.query!(
      "UPDATE automation.oban_jobs SET state = 'retryable', attempt = 1 WHERE id = $1",
      [retry_job.id]
    )

    Repo.query!(
      "UPDATE automation.oban_jobs SET state = 'executing', attempt = 1, attempted_at = now() WHERE id = $1",
      [run_job.id]
    )

    cancels = Enum.map([waiting, retrying, running], &cancel!/1)

    assert Relay.run_once() == 3
    assert Enum.map(jobs(), & &1.state) == ["cancelled", "cancelled", "executing"]

    assert markers()
           |> Enum.filter(&(elem(&1, 1) == "cancel"))
           |> Enum.map(&elem(&1, 0))
           |> Enum.sort() == Enum.sort(cancels)
  end

  test "a cancel for a request that was never relayed has nothing to cancel", %{payload: _payload} do
    cancel = ChainViews.insert!(Ecto.UUID.generate(), "cancel", cancels: Ecto.UUID.generate())

    assert Relay.run_once() == 1
    assert jobs() == []
    assert markers() == [{cancel, "cancel", nil}]
  end

  test "a payload without a valid maxAttempts gets one attempt", %{payload: payload} do
    execute!(put_in(payload, ["execution", "maxAttempts"], 50))
    execute!(Map.delete(payload, "execution"))
    execute!(put_in(payload, ["execution", "maxAttempts"], "5"))

    assert Relay.run_once() == 3
    assert Enum.map(jobs(), & &1.max_attempts) == [1, 1, 1]
  end

  test "a poll takes at most 100 rows, oldest first", %{payload: payload} do
    ids =
      for n <- 1..101,
          do: execute!(payload, created_at: DateTime.add(~U[2026-10-17 12:00:00Z], n))

    assert Relay.run_once() == 100
    assert Enum.map(Relay.pending(), & &1.request_id) == [List.last(ids)]
    assert Relay.run_once() == 1
  end

  describe "the poller" do
    test "runs the relay every interval, but only while this node leads" do
      test = self()

      start_supervised!(
        {Relay.Poller,
         name: :follower,
         interval: 5,
         leader?: fn -> false end,
         run: fn -> send(test, :follower_ran) end},
        id: :follower
      )

      start_supervised!(
        {Relay.Poller,
         name: :leader,
         interval: 5,
         leader?: fn -> true end,
         run: fn -> send(test, :leader_ran) end},
        id: :leader
      )

      assert_receive :leader_ran, 1_000
      assert_receive :leader_ran, 1_000
      refute_received :follower_ran
    end

    test "logs a failed poll and keeps polling" do
      test = self()

      log =
        capture_log(fn ->
          poller =
            start_supervised!(
              {Relay.Poller,
               name: :failing,
               interval: 5,
               leader?: fn -> true end,
               run: fn ->
                 send(test, :ran)
                 raise DBConnection.ConnectionError, "connection refused"
               end}
            )

          assert_receive :ran, 1_000
          assert_receive :ran, 1_000
          assert Process.alive?(poller)
        end)

      assert log =~ "The automation relay could not poll: connection refused"
    end
  end
end
