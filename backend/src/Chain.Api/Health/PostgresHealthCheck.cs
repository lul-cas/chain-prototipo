using Microsoft.Extensions.Diagnostics.HealthChecks;
using Npgsql;

namespace Chain.Api.Health;

/// <summary>Reports whether the PostgreSQL database accepts connections and queries.</summary>
public sealed partial class PostgresHealthCheck(IConfiguration configuration, ILogger<PostgresHealthCheck> logger) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        var connectionString = configuration.GetConnectionString("Chain");
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            return HealthCheckResult.Unhealthy("Connection string 'Chain' is not configured.");
        }

        try
        {
            await using var connection = new NpgsqlConnection(connectionString);
            await connection.OpenAsync(cancellationToken);
            await using var command = new NpgsqlCommand("SELECT 1", connection);
            await command.ExecuteScalarAsync(cancellationToken);
            return HealthCheckResult.Healthy();
        }
        catch (Exception ex) when (ex is NpgsqlException or TimeoutException or System.Net.Sockets.SocketException)
        {
            LogReadinessFailed(logger, ex);
            return HealthCheckResult.Unhealthy("PostgreSQL is unreachable.", ex);
        }
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "PostgreSQL readiness check failed")]
    private static partial void LogReadinessFailed(ILogger logger, Exception exception);
}
