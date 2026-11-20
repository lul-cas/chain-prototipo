using Chain.Api.Tests.Infrastructure;
using Chain.SharedKernel;
using Microsoft.Extensions.DependencyInjection;

namespace Chain.Api.Tests.Mcp;

/// <summary>The MCP call log (mcp.md §6.1; card #83, N9b-2): one row per tool call, the arguments only hashed, kept 90 days.</summary>
[Collection(PostgresTestGroup.Name)]
public sealed class McpCallLogTests(PostgresFixture postgres) : IAsyncLifetime, IDisposable
{
    private const string Canary = "canary-comment-text-83";

    private readonly ChainApiFactory _factory = new(postgres.ConnectionString, settings: new Dictionary<string, string> { ["Chain:Mcp:CallsPerMinute"] = "3" });

    public async Task InitializeAsync() => await _factory.ResetDatabaseAsync();

    public Task DisposeAsync() => Task.CompletedTask;

    public void Dispose() => _factory.Dispose();

    [Fact]
    public async Task Every_tool_call_is_logged_with_its_outcome_and_a_hash_of_its_arguments_never_the_arguments()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var bot = await McpTestClient.CreateBotAsync(admin, "agente-ia");
        using var http = _factory.Http(bot.Token);
        var arguments = $$"""{"requestId":"{{Guid.NewGuid()}}","text":"{{Canary}}","idempotencyKey":" comentario-1 "}""";
        const string TraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
        http.DefaultRequestHeaders.Add("traceparent", $"00-{TraceId}-00f067aa0ba902b7-01"); // the caller's W3C trace

        (await http.RawCallAsync("add_comment", arguments)).RawError("not_found");
        (await http.RawCallAsync("list_my_tasks", "{}")).GetProperty("structuredContent");
        (await http.RawCallAsync("get_request", """{"requestId":"42"}""")).RawError("validation_failed");
        (await http.RawCallAsync("list_my_tasks", "{}")).RawError("rate_limited"); // the fourth call in this minute

        string[] expected =
            [
                $"{bot.Id}|add_comment|not_found|comentario-1|test|1|{ContentHash.Compute(arguments)}",
                $"{bot.Id}|list_my_tasks|ok|-|test|1|{ContentHash.Compute("{}")}",
                $"{bot.Id}|get_request|validation_failed|-|test|1|{ContentHash.Compute("""{"requestId":"42"}""")}",
                $"{bot.Id}|list_my_tasks|rate_limited|-|test|1|{ContentHash.Compute("{}")}",
            ];
        var rows = await _factory.QueryAsync("""
                SELECT bot_id || '|' || tool || '|' || outcome || '|' || coalesce(idempotency_key, '-') || '|' || client_name || '|'
                    || client_version || '|' || arguments_sha256
                FROM chain.mcp_calls
                """);
        Assert.Equal(expected.Order(StringComparer.Ordinal), rows.Order(StringComparer.Ordinal)); // one fake instant: ids do not order them
        Assert.Equal(["4|" + TraceId], await _factory.QueryAsync("SELECT count(*) FILTER (WHERE duration_ms >= 0) || '|' || min(correlation_id) FROM chain.mcp_calls"));
        Assert.Equal(["0"], await _factory.QueryAsync($"SELECT count(*) FROM chain.mcp_calls c WHERE row_to_json(c)::text LIKE '%{Canary}%'"));
    }

    [Fact]
    public async Task Rows_older_than_90_days_are_deleted()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var bot = await McpTestClient.CreateBotAsync(admin, "agente-ia");
        using var http = _factory.Http(bot.Token);
        await http.RawCallAsync("list_my_tasks", "{}");
        _factory.Time.Advance(TimeSpan.FromDays(90) - TimeSpan.FromMinutes(1));
        await http.RawCallAsync("list_my_tasks", "{}");

        var cleanup = ActivatorUtilities.CreateInstance<McpCallCleanupService>(_factory.Services);
        await cleanup.DeleteExpiredAsync(CancellationToken.None);
        Assert.Equal(["2"], await _factory.QueryAsync("SELECT count(*) FROM chain.mcp_calls"));

        _factory.Time.Advance(TimeSpan.FromMinutes(2));
        await cleanup.DeleteExpiredAsync(CancellationToken.None);
        Assert.Equal(["1"], await _factory.QueryAsync("SELECT count(*) FROM chain.mcp_calls"));
    }
}
