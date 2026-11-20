using Chain.Infrastructure;
using Chain.Mcp;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Chain.Api;

/// <summary>
/// The MCP rate count in PostgreSQL, shared by every API process (mcp.md §5; card #83, N9b-3). One statement deletes the bot's older
/// windows and adds the call to this minute's row, but only while the row is under the bot's rate, so concurrent calls never pass
/// it and a refused call does not count.
/// </summary>
internal sealed class McpRateLimiterStore(IServiceScopeFactory scopes, TimeProvider time, int defaultCallsPerMinute) : IMcpRateLimiter
{
    private const string Count = """
        WITH bot AS (
            SELECT coalesce(mcp_calls_per_minute, @default) AS max_calls FROM chain.users WHERE id = @bot
        ), stale AS (
            DELETE FROM chain.mcp_rate_windows WHERE bot_id = @bot AND window_start < @window
        )
        INSERT INTO chain.mcp_rate_windows AS w (bot_id, window_start, calls)
        SELECT @bot, @window, 1 FROM bot
        ON CONFLICT (bot_id, window_start) DO UPDATE SET calls = w.calls + 1 WHERE w.calls < (SELECT max_calls FROM bot)
        RETURNING w.calls
        """;

    public async Task<RateDecision> TryAcquireAsync(Guid bot, CancellationToken cancellationToken)
    {
        var seconds = time.GetUtcNow().ToUnixTimeSeconds();
        var window = DateTimeOffset.FromUnixTimeSeconds(seconds - (seconds % 60));
        await using var scope = scopes.CreateAsyncScope();
        var connection = (NpgsqlConnection)scope.ServiceProvider.GetRequiredService<ChainDbContext>().Database.GetDbConnection();
        await connection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand(Count, connection);
        command.Parameters.AddWithValue("bot", bot);
        command.Parameters.AddWithValue("window", window);
        command.Parameters.AddWithValue("default", defaultCallsPerMinute);
        var counted = await command.ExecuteScalarAsync(cancellationToken) is not null;
        return new RateDecision(counted, counted ? 0 : (int)(60 - (seconds % 60)));
    }
}
