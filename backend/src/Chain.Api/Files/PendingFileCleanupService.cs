using Chain.Workflows.Application.Files;

namespace Chain.Api.Files;

internal sealed class PendingFileCleanupService(IServiceProvider services, ILogger<PendingFileCleanupService> logger) : BackgroundService
{
    private static readonly Action<ILogger, Exception?> Failed =
        LoggerMessage.Define(LogLevel.Error, new EventId(1, "PendingFileCleanup"), "Pending file cleanup failed.");

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromHours(1));
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await using var scope = services.CreateAsyncScope();
                await scope.ServiceProvider.GetRequiredService<FileService>().PurgePendingAsync(stoppingToken);
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                Failed(logger, exception);
            }

            if (!await timer.WaitForNextTickAsync(stoppingToken))
            {
                break;
            }
        }
    }
}
