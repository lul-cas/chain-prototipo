using Chain.Workflows.Runtime;

namespace Chain.Workflows.Tests.Runtime;

/// <summary>The outbox row's transitions (automation.md §6.2, §6.5, §6.7) and the retry key rule (§8.3).</summary>
public sealed class AutomationWorkRequestTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 16, 12, 0, 0, TimeSpan.Zero);
    private static readonly Guid Next = Guid.Parse("0199f000-0000-7000-8000-0000000000ff");

    private static AutomationWorkRequest Pending() =>
        AutomationWorkRequest.ForExecution(Guid.CreateVersion7(Now), Guid.CreateVersion7(Now), "task_cpf", 1, "{}", "original-key", Now, Now.AddSeconds(990));

    [Fact]
    public void A_retry_after_a_timeout_reuses_the_timed_out_key()
    {
        var timedOut = Pending();
        timedOut.TimeOut(Now.AddSeconds(991));

        Assert.Equal("original-key", AutomationWorkRequest.KeyAfter(timedOut, Next));
    }

    [Fact]
    public void Any_other_dispatch_gets_its_own_id_as_key()
    {
        var cancelled = Pending();
        cancelled.CancelExecution(Now);

        Assert.Equal(Next.ToString(), AutomationWorkRequest.KeyAfter(null, Next));
        Assert.Equal(Next.ToString(), AutomationWorkRequest.KeyAfter(cancelled, Next));
        Assert.Equal(Next.ToString(), AutomationWorkRequest.KeyAfter(Pending(), Next));
    }

    [Fact]
    public void Closing_an_execution_returns_a_cancel_request_for_the_same_activation()
    {
        var request = Pending();

        var cancel = request.TimeOut(Now.AddSeconds(991));

        Assert.Equal("timed_out|cancel|pending", $"{request.Status}|{cancel.Kind}|{cancel.Status}");
        Assert.Equal((request.Id, request.NodeId, request.Activation), (cancel.CancelsRequestId!.Value, cancel.NodeId, cancel.Activation));
        Assert.Equal(Now.AddSeconds(991) + AutomationWorkRequest.CancelWindow, cancel.DeadlineAt);
        Assert.Throws<InvalidOperationException>(() => request.CancelExecution(Now.AddSeconds(992))); // closed only once
    }

    [Fact]
    public void Only_a_pending_cancel_request_expires()
    {
        var cancel = Pending().CancelExecution(Now);

        cancel.Expire(Now.AddHours(25));

        Assert.Equal("completed", cancel.Status);
        Assert.Throws<InvalidOperationException>(() => cancel.Expire(Now.AddHours(26)));
        Assert.Throws<InvalidOperationException>(() => Pending().Expire(Now));
    }
}
