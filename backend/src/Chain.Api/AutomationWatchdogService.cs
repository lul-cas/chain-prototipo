using Chain.Workflows.Application.Engine;

namespace Chain.Api;

/// <summary>
/// Times out automation steps whose result never arrived, and completes expired cancel requests (automation.md §6.7). Every API
/// process runs it; the engine's re-check under the instance lock makes concurrent passes harmless.
/// </summary>
internal sealed partial class AutomationWatchdogService(IServiceScopeFactory scopes, ILogger<AutomationWatchdogService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(InstanceService.WatchdogInterval);
        do
        {
            try
            {
                await using var scope = scopes.CreateAsyncScope();
                await scope.ServiceProvider.GetRequiredService<InstanceService>().TimeOutAutomationsAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception exception)
            {
                LogPassFailed(logger, exception);
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    [LoggerMessage(Level = LogLevel.Error, Message = "Automation watchdog pass failed; it runs again on the next tick")]
    private static partial void LogPassFailed(ILogger logger, Exception exception);
}
