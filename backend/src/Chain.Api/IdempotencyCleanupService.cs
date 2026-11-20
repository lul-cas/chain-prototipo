using Chain.Infrastructure;
using Chain.Workflows.Application.Engine;
using Microsoft.EntityFrameworkCore;

namespace Chain.Api;

internal sealed partial class IdempotencyCleanupService(
    IServiceScopeFactory scopes,
    TimeProvider time,
    ILogger<IdempotencyCleanupService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(InstanceService.IdempotencyWindow);
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
        var cutoff = time.GetUtcNow() - InstanceService.IdempotencyWindow;
        await scope.ServiceProvider.GetRequiredService<ChainDbContext>().IdempotencyKeys
            .Where(key => key.CreatedAt < cutoff)
            .ExecuteDeleteAsync(cancellationToken);
    }

    [LoggerMessage(Level = LogLevel.Error, Message = "Idempotency key cleanup failed")]
    private static partial void LogCleanupFailed(ILogger logger, Exception exception);
}
