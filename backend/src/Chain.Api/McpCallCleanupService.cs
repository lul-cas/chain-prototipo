using Chain.Infrastructure;
using Microsoft.EntityFrameworkCore;

namespace Chain.Api;

/// <summary>Deletes MCP call log rows older than 90 days, every hour (mcp.md §6.1, Q-M8).</summary>
internal sealed partial class McpCallCleanupService(
    IServiceScopeFactory scopes,
    TimeProvider time,
    ILogger<McpCallCleanupService> logger) : BackgroundService
{
    public static readonly TimeSpan Retention = TimeSpan.FromDays(90);

    private static readonly TimeSpan Interval = TimeSpan.FromHours(1);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Interval);
        do
        {
            try
            {
                await DeleteExpiredAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception exception)
            {
                LogCleanupFailed(logger, exception);
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    internal async Task DeleteExpiredAsync(CancellationToken cancellationToken)
    {
        await using var scope = scopes.CreateAsyncScope();
        var cutoff = time.GetUtcNow() - Retention;
        await scope.ServiceProvider.GetRequiredService<ChainDbContext>().McpCalls
            .Where(call => call.CalledAt < cutoff)
            .ExecuteDeleteAsync(cancellationToken);
    }

    [LoggerMessage(Level = LogLevel.Error, Message = "MCP call log cleanup failed")]
    private static partial void LogCleanupFailed(ILogger logger, Exception exception);
}
