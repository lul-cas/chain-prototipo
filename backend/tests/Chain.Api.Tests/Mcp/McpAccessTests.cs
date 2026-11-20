using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Chain.Api.Tests.Infrastructure;

namespace Chain.Api.Tests.Mcp;

/// <summary>Who may reach <c>/mcp</c>, and the endpoint rules (ADR-0015 §4–§5; mcp.md §1; identity.md, MCP access).</summary>
[Collection(PostgresTestGroup.Name)]
public sealed class McpAccessTests(PostgresFixture postgres) : IAsyncLifetime, IDisposable
{
    private readonly ChainApiFactory _factory = new(postgres.ConnectionString);

    public async Task InitializeAsync() => await _factory.ResetDatabaseAsync();

    public Task DisposeAsync() => Task.CompletedTask;

    public void Dispose() => _factory.Dispose();

    // The per-bot switch (Q-M4)

    [Fact]
    public async Task Admins_switch_mcp_per_bot_and_every_switch_is_audited()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var bot = await McpTestClient.CreateBotAsync(admin, "agente-ia", enableMcp: false);
        Assert.False(await McpEnabledAsync(admin, bot.Id));

        Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsync($"/api/admin/bots/{bot.Id}/mcp/enable", null)).StatusCode);
        Assert.True(await McpEnabledAsync(admin, bot.Id));
        var listed = await admin.GetFromJsonAsync<JsonElement>("/api/admin/bots");
        Assert.True(Assert.Single(listed.EnumerateArray()).GetProperty("mcpEnabled").GetBoolean());

        Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsync($"/api/admin/bots/{bot.Id}/mcp/disable", null)).StatusCode);
        Assert.False(await McpEnabledAsync(admin, bot.Id));

        var actions = await _factory.QueryAsync($"SELECT action FROM chain.audit_events WHERE subject_id = '{bot.Id}' AND action LIKE 'admin.bot.mcp%' ORDER BY action");
        Assert.Equal(["admin.bot.mcp_disabled", "admin.bot.mcp_enabled"], actions);
    }

    [Fact]
    public async Task Only_admins_switch_mcp_and_only_for_bots()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var bot = await McpTestClient.CreateBotAsync(admin, "agente-ia");
        using var asBot = _factory.Http(bot.Token);
        var adminId = (await admin.GetFromJsonAsync<JsonElement>("/api/auth/me")).GetProperty("id").GetGuid();

        await (await asBot.PostAsync($"/api/admin/bots/{bot.Id}/mcp/disable", null)).AssertProblemAsync(HttpStatusCode.Forbidden, "forbidden");
        await (await admin.PostAsync($"/api/admin/bots/{adminId}/mcp/enable", null)).AssertProblemAsync(HttpStatusCode.NotFound, "not_found");
        await (await admin.PostAsync($"/api/admin/bots/{Guid.NewGuid()}/mcp/enable", null)).AssertProblemAsync(HttpStatusCode.NotFound, "not_found");
    }

    [Fact]
    public async Task Database_allows_mcp_for_bots_only()
    {
        using var admin = await _factory.CreateReadyAdminAsync();

        var error = await Assert.ThrowsAnyAsync<Exception>(() =>
            _factory.QueryAsync($"UPDATE chain.users SET mcp_enabled = true WHERE username = '{ApiTestSession.AdminUsername}' RETURNING id"));

        Assert.Contains("ck_users_mcp_bots_only", error.Message, StringComparison.Ordinal);
    }

    // Authentication (ADR-0015 §5)

    [Fact]
    public async Task An_mcp_enabled_bot_connects_with_the_current_protocol_revision()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var bot = await McpTestClient.CreateBotAsync(admin, "agente-ia");

        await using var client = await _factory.ConnectAsync(bot.Token);

        Assert.Equal("chain", client.ServerInfo.Name);
        Assert.Equal("2026-07-28", client.NegotiatedProtocolVersion);
        Assert.NotNull(client.ServerCapabilities.Tools);
        Assert.Null(client.ServerCapabilities.Resources);
        Assert.Null(client.ServerCapabilities.Prompts);
    }

    [Fact]
    public async Task Everything_but_a_token_of_an_active_mcp_enabled_bot_gets_401()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var disabled = await McpTestClient.CreateBotAsync(admin, "sem-mcp", enableMcp: false);
        var revoked = await McpTestClient.CreateBotAsync(admin, "revogado");
        var revokedTokenId = (await admin.GetFromJsonAsync<JsonElement>($"/api/admin/bots/{revoked.Id}")).GetProperty("tokens")[0].GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsync($"/api/admin/bots/{revoked.Id}/tokens/{revokedTokenId}/revoke", null)).StatusCode);
        var inactive = await McpTestClient.CreateBotAsync(admin, "inativo");
        Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsync($"/api/admin/bots/{inactive.Id}/deactivate", null)).StatusCode);

        foreach (var token in new string?[] { null, "chn_aaaaaaaa_" + new string('A', 43), "not-a-token", disabled.Token, revoked.Token, inactive.Token })
        {
            using var client = _factory.Http(token);
            var response = await client.PostRawAsync();
            await response.AssertProblemAsync(HttpStatusCode.Unauthorized, "unauthenticated");
            Assert.Equal("Bearer", response.Headers.WwwAuthenticate.ToString());
        }

        var reasons = await _factory.QueryAsync("SELECT details->>'reason' FROM chain.audit_events WHERE action = 'auth.token.failed' ORDER BY details->>'reason'");
        Assert.Equal(["inactive_bot", "malformed", "mcp_disabled", "revoked", "unknown"], reasons);
    }

    [Fact]
    public async Task A_browser_session_is_never_accepted_on_mcp()
    {
        using var admin = await _factory.CreateReadyAdminAsync();

        var response = await admin.PostRawAsync();

        await response.AssertProblemAsync(HttpStatusCode.Unauthorized, "unauthenticated");
    }

    [Fact]
    public async Task Disabling_mcp_stops_the_token_on_mcp_only()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var bot = await McpTestClient.CreateBotAsync(admin, "agente-ia");
        await using (var client = await _factory.ConnectAsync(bot.Token))
        {
            Assert.NotEmpty(await client.ListToolsAsync());
        }

        Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsync($"/api/admin/bots/{bot.Id}/mcp/disable", null)).StatusCode);

        using var http = _factory.Http(bot.Token);
        await (await http.PostRawAsync()).AssertProblemAsync(HttpStatusCode.Unauthorized, "unauthenticated");
        Assert.Equal(HttpStatusCode.OK, (await http.GetAsync("/api/auth/me")).StatusCode);
    }

    // Endpoint rules (ADR-0015 §4)

    [Fact]
    public async Task A_request_from_a_foreign_origin_gets_403_and_the_frontend_origin_is_accepted()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var bot = await McpTestClient.CreateBotAsync(admin, "agente-ia");
        using var http = _factory.Http(bot.Token);
        http.DefaultRequestHeaders.Add("Origin", "https://evil.example");

        await (await http.PostRawAsync()).AssertProblemAsync(HttpStatusCode.Forbidden, "origin_not_allowed");

        await using var client = await _factory.ConnectAsync(bot.Token, origin: ChainApiFactory.FrontendOrigin);
        Assert.NotEmpty(await client.ListToolsAsync());
    }

    [Fact]
    public async Task Bodies_over_256_KB_get_413()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var bot = await McpTestClient.CreateBotAsync(admin, "agente-ia");
        using var http = _factory.Http(bot.Token);

        var over = await http.PostRawAsync(Padded(256 * 1024 + 1));
        var under = await http.PostRawAsync(Padded(256 * 1024));

        await over.AssertProblemAsync(HttpStatusCode.RequestEntityTooLarge, "payload_too_large");
        Assert.NotEqual(HttpStatusCode.RequestEntityTooLarge, under.StatusCode);
    }

    // Card #180: the SDK reads a body that is not UTF-8 as far as it can. A byte in the tool name, which it compares with the
    // Mcp-Name header, threw, which is a 500; in an argument it became U+FFFD and the call ran. Such a body is not JSON (RFC 8259
    // §8.1), so it now gets the SDK's own answer to malformed JSON, and nothing runs.

    [Fact]
    public async Task A_body_that_is_not_UTF8_gets_the_answer_to_malformed_json()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var bot = await McpTestClient.CreateBotAsync(admin, "agente-ia");
        using var http = _factory.Http(bot.Token);
        var malformed = await http.PostRawAsync("{ not json");
        Assert.Equal(HttpStatusCode.BadRequest, malformed.StatusCode);
        var expected = await malformed.Content.ReadAsStringAsync();
        Assert.Equal(-32600, JsonDocument.Parse(expected).RootElement.GetProperty("error").GetProperty("code").GetInt32()); // the SDK's answer

        var requestId = Guid.NewGuid();
        foreach (var (tool, arguments) in new[]
        {
            ("add_commentNOT_UTF8", $$"""{"requestId":"{{requestId}}","text":"Oi","idempotencyKey":"k1"}"""),
            ("add_comment", $$"""{"requestId":"{{requestId}}","text":"OiNOT_UTF8","idempotencyKey":"k2"}"""),
        })
        {
            var response = await http.SendAsync(McpTestClient.ToolCall(tool, arguments));

            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            Assert.Equal(expected, await response.Content.ReadAsStringAsync());
        }
    }

    [Fact]
    public async Task Get_and_delete_are_not_allowed()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var bot = await McpTestClient.CreateBotAsync(admin, "agente-ia");
        using var http = _factory.Http(bot.Token);

        Assert.Equal(HttpStatusCode.MethodNotAllowed, (await http.GetAsync("/mcp")).StatusCode);
        Assert.Equal(HttpStatusCode.MethodNotAllowed, (await http.DeleteAsync("/mcp")).StatusCode);
    }

    // Helpers

    private static async Task<bool> McpEnabledAsync(HttpClient admin, Guid bot) =>
        (await admin.GetFromJsonAsync<JsonElement>($"/api/admin/bots/{bot}")).GetProperty("mcpEnabled").GetBoolean();

    /// <summary>A JSON-RPC body of exactly <paramref name="bytes"/> bytes.</summary>
    private static string Padded(int bytes)
    {
        const string Head = """{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"pad":""";
        const string Tail = "\"}}";
        return Head + new string('x', bytes - Head.Length - Tail.Length) + Tail;
    }
}
