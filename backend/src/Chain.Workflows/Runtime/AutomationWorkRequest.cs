namespace Chain.Workflows.Runtime;

/// <summary>
/// A row of the automation outbox (automation.md §6.2, automation-contract.md §2.1). The engine writes it in the command that moves
/// the instance; Elixir reads the pending rows through <c>chain.automation_dispatch_v1</c>. Only .NET changes the status, always
/// together with the instance.
/// </summary>
public sealed class AutomationWorkRequest
{
    public const string Execute = "execute";
    public const string Cancel = "cancel";

    public const string Pending = "pending";
    public const string Completed = "completed";
    public const string Failed = "failed";
    public const string Cancelled = "cancelled";
    public const string TimedOut = "timed_out";

    /// <summary>How long a cancel request stays visible to Elixir (AU-7).</summary>
    public static readonly TimeSpan CancelWindow = TimeSpan.FromHours(24);

    private AutomationWorkRequest()
    {
    }

    public Guid Id { get; private set; }

    /// <summary><see cref="Execute"/> or <see cref="Cancel"/>.</summary>
    public string Kind { get; private set; } = Execute;

    public string Status { get; private set; } = Pending;
    public Guid InstanceId { get; private set; }
    public string NodeId { get; private set; } = string.Empty;

    /// <summary>The step activation: a counter per (instance, node), so a back-flow or a retry is a new request (ADR-0011 §4).</summary>
    public int Activation { get; private set; }

    /// <summary>For a cancel request: the execute request it cancels.</summary>
    public Guid? CancelsRequestId { get; private set; }

    /// <summary>For an execute request: the payload of automation-contract.md §3.</summary>
    public string? Payload { get; private set; }

    public string? IdempotencyKey { get; private set; }
    public DateTimeOffset CreatedAt { get; private set; }
    public DateTimeOffset DeadlineAt { get; private set; }
    public DateTimeOffset? ClosedAt { get; private set; }

    public bool IsPending => Status == Pending;

    /// <summary>An execute request whose <paramref name="payload"/> already carries its id, key and deadline.</summary>
    public static AutomationWorkRequest ForExecution(
        Guid id, Guid instanceId, string nodeId, int activation, string payload, string idempotencyKey, DateTimeOffset now, DateTimeOffset deadlineAt) => new()
    {
        Id = id,
        Kind = Execute,
        InstanceId = instanceId,
        NodeId = nodeId,
        Activation = activation,
        Payload = payload,
        IdempotencyKey = idempotencyKey,
        CreatedAt = now,
        DeadlineAt = deadlineAt,
    };

    /// <summary>
    /// The idempotency key of a step's next execute request (automation.md §8.3). After a timeout the call may have succeeded, so the
    /// retry keeps the timed-out request's key and the target can de-duplicate it (ADR-0011 decision 5); otherwise the new request's id.
    /// </summary>
    public static string KeyAfter(AutomationWorkRequest? previous, Guid nextRequestId) =>
        previous is { Status: TimedOut, IdempotencyKey: { } reused } ? reused : nextRequestId.ToString();

    /// <summary>Cancels this pending execute request and returns the cancel request that tells Elixir (automation.md §6.5).</summary>
    public AutomationWorkRequest CancelExecution(DateTimeOffset now) => CloseExecution(Cancelled, now);

    /// <summary>Times out this pending execute request and returns the cancel request that tells Elixir (automation.md §6.7).</summary>
    public AutomationWorkRequest TimeOut(DateTimeOffset now) => CloseExecution(TimedOut, now);

    /// <summary>The result was applied: the outputs were merged (automation.md §6.3).</summary>
    public void Complete(DateTimeOffset now) => Close(Execute, Completed, now);

    /// <summary>Elixir reported a final failure, or the output broke the contract (automation.md §6.3).</summary>
    public void Fail(DateTimeOffset now) => Close(Execute, Failed, now);

    /// <summary>Completes a cancel request whose window has passed (automation.md §6.7).</summary>
    public void Expire(DateTimeOffset now) => Close(Cancel, Completed, now);

    private void Close(string kind, string status, DateTimeOffset now)
    {
        if (Kind != kind || !IsPending)
        {
            throw new InvalidOperationException($"Only a pending {kind} request can become {status}.");
        }

        Status = status;
        ClosedAt = now;
    }

    private AutomationWorkRequest CloseExecution(string status, DateTimeOffset now)
    {
        if (Kind != Execute || !IsPending)
        {
            throw new InvalidOperationException("Only a pending execute request can be closed this way.");
        }

        Status = status;
        ClosedAt = now;
        return new AutomationWorkRequest
        {
            Id = Guid.CreateVersion7(now),
            Kind = Cancel,
            InstanceId = InstanceId,
            NodeId = NodeId,
            Activation = Activation,
            CancelsRequestId = Id,
            CreatedAt = now,
            DeadlineAt = now + CancelWindow,
        };
    }
}
