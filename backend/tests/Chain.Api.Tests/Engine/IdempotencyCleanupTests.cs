using Chain.Api;
using Chain.Api.Tests.Infrastructure;
using Chain.Infrastructure;
using Chain.Workflows.Application.Engine;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Chain.Api.Tests.Engine;

[Collection(PostgresTestGroup.Name)]
public sealed class IdempotencyCleanupTests(PostgresFixture postgres) : IAsyncLifetime, IDisposable
{
    private readonly ChainApiFactory _factory = new(postgres.ConnectionString);

    public async Task InitializeAsync() => await _factory.ResetDatabaseAsync();

    public Task DisposeAsync() => Task.CompletedTask;

    public void Dispose() => _factory.Dispose();

    [Fact]
    public async Task Expired_keys_are_deleted_and_fresh_keys_are_kept()
    {
        var now = _factory.Time.GetUtcNow();
        var actorId = Guid.NewGuid();
        var window = InstanceService.IdempotencyWindow;

        await using (var scope = _factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ChainDbContext>();
            db.IdempotencyKeys.AddRange(
                Row(actorId, "expired", now - window - TimeSpan.FromSeconds(1)),
                Row(actorId, "boundary", now - window),
                Row(actorId, "fresh", now));
            await db.SaveChangesAsync();
        }

        var cleanup = _factory.Services.GetServices<IHostedService>().OfType<IdempotencyCleanupService>().Single();
        await cleanup.DeleteExpiredAsync(CancellationToken.None);

        await using var check = _factory.Services.CreateAsyncScope();
        var keys = await check.ServiceProvider.GetRequiredService<ChainDbContext>().IdempotencyKeys
            .OrderBy(key => key.Key)
            .Select(key => key.Key)
            .ToListAsync();

        Assert.Equal(["boundary", "fresh"], keys);
    }

    private static IdempotencyKeyRow Row(Guid actorId, string key, DateTimeOffset createdAt) => new()
    {
        ActorId = actorId,
        Key = key,
        RequestHash = new string('a', 64),
        CreatedAt = createdAt,
    };
}
