using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Chain.Api.Tests.Infrastructure;

namespace Chain.Api.Tests.Mcp;

/// <summary>Per-bot MCP rates with a count shared between API processes (mcp.md §5; identity.md, MCP access; card #83, N9b-3).</summary>
[Collection(PostgresTestGroup.Name)]
public sealed class McpRateTests(PostgresFixture postgres) : IAsyncLifetime, IDisposable
{
    private readonly ChainApiFactory _factory = new(postgres.ConnectionString);

    public async Task InitializeAsync() => await _factory.ResetDatabaseAsync();

    public Task DisposeAsync() => Task.CompletedTask;

    public void Dispose() => _factory.Dispose();

    private static Task<HttpResponseMessage> SetRateAsync(HttpClient admin, Guid bot, int? callsPerMinute) =>
        admin.PutAsJsonAsync($"/api/admin/bots/{bot}/mcp/rate", new { callsPerMinute });

    [Fact]
    public async Task Admins_set_a_bots_rate_and_return_it_to_the_default()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var bot = await McpTestClient.CreateBotAsync(admin, "agente-ia");

        var set = await SetRateAsync(admin, bot.Id, 120);
        Assert.Equal(HttpStatusCode.OK, set.StatusCode);
        Assert.Equal(120, (await set.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("mcpCallsPerMinute").GetInt32());
        var reset = await SetRateAsync(admin, bot.Id, null);
        Assert.Equal(JsonValueKind.Null, (await reset.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("mcpCallsPerMinute").ValueKind);

        await (await SetRateAsync(admin, bot.Id, 0)).AssertValidationFailedAsync("invalid_calls_per_minute");
        await (await SetRateAsync(admin, bot.Id, 601)).AssertValidationFailedAsync("invalid_calls_per_minute");
        await (await SetRateAsync(admin, Guid.NewGuid(), 60)).AssertProblemAsync(HttpStatusCode.NotFound, "not_found");
        using var asBot = _factory.Http(bot.Token);
        await (await SetRateAsync(asBot, bot.Id, 600)).AssertProblemAsync(HttpStatusCode.Forbidden, "forbidden");
        Assert.Equal(["120", "default"], (await _factory.QueryAsync(
            $"SELECT details::jsonb->>'callsPerMinute' FROM chain.audit_events WHERE action = 'admin.bot.mcp_rate_changed' AND subject_id = '{bot.Id}'"))
            .Order(StringComparer.Ordinal));
    }

    [Fact]
    public async Task A_bots_own_rate_applies_to_its_next_call()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var bot = await McpTestClient.CreateBotAsync(admin, "agente-ia");
        Assert.Equal(HttpStatusCode.OK, (await SetRateAsync(admin, bot.Id, 2)).StatusCode);
        using var http = _factory.Http(bot.Token);

        (await http.RawCallAsync("list_my_tasks", "{}")).GetProperty("structuredContent");
        (await http.RawCallAsync("list_my_tasks", "{}")).GetProperty("structuredContent");
        var refused = (await http.RawCallAsync("list_my_tasks", "{}")).RawError("rate_limited");

        Assert.InRange(refused.GetProperty("retryAfterSeconds").GetInt32(), 1, 60);
    }

    // Regression of mcp.md §5 before N9b-3: each API process counted on its own, so with two processes a bot got twice its rate.

    [Fact]
    public async Task Two_api_processes_share_one_count()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var bot = await McpTestClient.CreateBotAsync(admin, "agente-ia");
        Assert.Equal(HttpStatusCode.OK, (await SetRateAsync(admin, bot.Id, 3)).StatusCode);
        using var other = new ChainApiFactory(postgres.ConnectionString); // a second process on the same database
        using var first = _factory.Http(bot.Token);
        using var second = other.Http(bot.Token);

        (await first.RawCallAsync("list_my_tasks", "{}")).GetProperty("structuredContent");
        (await second.RawCallAsync("list_my_tasks", "{}")).GetProperty("structuredContent");
        (await first.RawCallAsync("list_my_tasks", "{}")).GetProperty("structuredContent");

        (await first.RawCallAsync("list_my_tasks", "{}")).RawError("rate_limited");
        (await second.RawCallAsync("list_my_tasks", "{}")).RawError("rate_limited");
    }
}
