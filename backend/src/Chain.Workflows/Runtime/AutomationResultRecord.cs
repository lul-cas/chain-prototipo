namespace Chain.Workflows.Runtime;

/// <summary>
/// The result inbox (automation-contract.md §4.3, ADR-0011 §6): the first result for a request, by its payload hash, and the response
/// it got. The same body replays the response; a different one is a conflict. Rows are never changed.
/// </summary>
public sealed class AutomationResultRecord
{
    private AutomationResultRecord()
    {
    }

    public Guid RequestId { get; private set; }

    /// <summary>SHA-256 of the body's canonical JSON, as <c>sha256:</c> plus hex.</summary>
    public string PayloadHash { get; private set; } = string.Empty;

    /// <summary>The JSON answered with 200: <c>{"applied":true}</c> or <c>{"applied":false,"reason":…}</c>.</summary>
    public string Response { get; private set; } = string.Empty;

    public DateTimeOffset ReceivedAt { get; private set; }

    public static AutomationResultRecord Create(Guid requestId, string payloadHash, string response, DateTimeOffset now) => new()
    {
        RequestId = requestId,
        PayloadHash = payloadHash,
        Response = response,
        ReceivedAt = now,
    };
}
