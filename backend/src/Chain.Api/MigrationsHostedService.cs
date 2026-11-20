using Chain.Infrastructure;
using Microsoft.EntityFrameworkCore;

namespace Chain.Api;

/// <summary>
/// Applies EF Core migrations at startup when <c>Chain:ApplyMigrationsOnStartup</c> is true
/// (local development and tests; production applies migrations as a separate deployment step).
/// </summary>
internal sealed class MigrationsHostedService(IServiceProvider services, IConfiguration configuration) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken) => MigrateIfEnabledAsync(services, configuration, cancellationToken);

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public static async Task MigrateIfEnabledAsync(IServiceProvider services, IConfiguration configuration, CancellationToken cancellationToken = default)
    {
        if (!configuration.GetValue<bool>("Chain:ApplyMigrationsOnStartup"))
        {
            return;
        }

        await using var scope = services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<ChainDbContext>().Database.MigrateAsync(cancellationToken);
    }
}
