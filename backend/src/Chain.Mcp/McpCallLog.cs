namespace Chain.Mcp;

/// <summary>One tool call for the call log (mcp.md §6.1): who called what, and how it ended. The arguments are only hashed.</summary>
public sealed record McpCall(
    Guid BotId, string Tool, string Outcome, int DurationMs, string? CorrelationId, string? IdempotencyKey,
    string? ClientName, string? ClientVersion, string ArgumentsSha256, DateTimeOffset CalledAt);

/// <summary>Writes the MCP call log (mcp.md §6.1; card #83, N9b-2), in a transaction of its own.</summary>
public interface IMcpCallLog
{
    Task RecordAsync(McpCall entry, CancellationToken cancellationToken);
}
