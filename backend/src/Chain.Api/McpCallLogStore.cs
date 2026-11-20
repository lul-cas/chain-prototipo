using Chain.Infrastructure;
using Chain.Mcp;

namespace Chain.Api;

/// <summary>The MCP call log in PostgreSQL (mcp.md §6.1): each row in a scope and a transaction of its own, after the call.</summary>
internal sealed class McpCallLogStore(IServiceScopeFactory scopes) : IMcpCallLog
{
    public async Task RecordAsync(McpCall entry, CancellationToken cancellationToken)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ChainDbContext>();
        db.McpCalls.Add(new McpCallRow
        {
            Id = Guid.CreateVersion7(entry.CalledAt),
            BotId = entry.BotId,
            Tool = entry.Tool,
            Outcome = entry.Outcome,
            DurationMs = entry.DurationMs,
            CorrelationId = entry.CorrelationId,
            IdempotencyKey = entry.IdempotencyKey,
            ClientName = entry.ClientName,
            ClientVersion = entry.ClientVersion,
            ArgumentsSha256 = entry.ArgumentsSha256,
            CalledAt = entry.CalledAt,
        });
        await db.SaveChangesAsync(cancellationToken);
    }
}
