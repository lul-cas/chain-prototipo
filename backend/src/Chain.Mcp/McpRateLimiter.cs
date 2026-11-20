namespace Chain.Mcp;

/// <summary>Whether a call may run, and when not, the seconds until the bot's next window (1 to 60).</summary>
public readonly record struct RateDecision(bool Allowed, int RetryAfterSeconds);

/// <summary>
/// Counts a bot's tool calls in fixed windows of the clock minute, against its own rate or the default, for every API process
/// (mcp.md §5, Q-M9; card #83, N9b-3). A refused call does not count.
/// </summary>
public interface IMcpRateLimiter
{
    Task<RateDecision> TryAcquireAsync(Guid bot, CancellationToken cancellationToken);
}
