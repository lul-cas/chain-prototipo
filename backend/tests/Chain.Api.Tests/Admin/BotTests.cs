using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Chain.Api.Tests.Infrastructure;

namespace Chain.Api.Tests.Admin;

/// <summary>Acceptance criteria of identity increment I3: bots and API tokens (specs/modules/identity.md).</summary>
[Collection(PostgresTestGroup.Name)]
public sealed class BotTests(PostgresFixture postgres) : IAsyncLifetime, IDisposable
{
    private readonly ChainApiFactory _factory = new(postgres.ConnectionString);

    public async Task InitializeAsync() => await _factory.ResetDatabaseAsync();

    public Task DisposeAsync() => Task.CompletedTask;

    public void Dispose() => _factory.Dispose();

    // 1. Bot with token

    [Fact]
    public async Task Bot_token_authenticates_as_the_bot()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var bot = await CreateBotAsync(admin, "integracao-erp", "Integração ERP");
        var group = await CreateGroupAsync(admin, "Automações");
        Assert.Equal(HttpStatusCode.NoContent, (await admin.PutAsync($"/api/admin/groups/{group}/members/{bot}", null)).StatusCode);
        var (_, value) = await CreateTokenAsync(admin, bot, "produção");

        using var client = BearerClient(value);
        var me = await client.GetFromJsonAsync<JsonElement>("/api/auth/me");

        Assert.Equal(bot, me.GetProperty("id").GetGuid());
        Assert.Equal("bot", me.GetProperty("kind").GetString());
        Assert.False(me.GetProperty("isAdmin").GetBoolean());
        Assert.Equal("Automações", Assert.Single(me.GetProperty("groups").EnumerateArray()).GetProperty("name").GetString());
    }

    [Fact]
    public async Task Human_sessions_report_kind_user()
    {
        using var admin = await _factory.CreateReadyAdminAsync();

        var me = await admin.GetFromJsonAsync<JsonElement>("/api/auth/me");

        Assert.Equal("user", me.GetProperty("kind").GetString());
    }

    // 2. Token shown once, never audited

    [Fact]
    public async Task Token_value_is_shown_only_at_creation_and_never_audited()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var bot = await CreateBotAsync(admin, "integracao-erp");
        var (tokenId, value) = await CreateTokenAsync(admin, bot, "produção");

        Assert.Matches("^chn_[a-z2-7]{8}_[A-Za-z0-9_-]{43}$", value);
        var details = await admin.GetAsync($"/api/admin/bots/{bot}");
        var body = await details.Content.ReadAsStringAsync();
        Assert.DoesNotContain(value, body, StringComparison.Ordinal);
        var token = JsonDocument.Parse(body).RootElement.GetProperty("tokens").EnumerateArray().Single();
        Assert.Equal(tokenId, token.GetProperty("id").GetGuid());
        Assert.Equal(value.Split('_')[1], token.GetProperty("prefix").GetString());

        var audit = string.Join('\n', await _factory.QueryAsync("SELECT details::text FROM chain.audit_events"));
        Assert.DoesNotContain(value, audit, StringComparison.Ordinal);
        Assert.Equal(1, await _factory.CountAsync("SELECT count(*) FROM chain.audit_events WHERE action = 'admin.bot.token_created'"));
    }

    // 3. Rejected tokens

    [Fact]
    public async Task Revoked_tokens_stop_working()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var bot = await CreateBotAsync(admin, "integracao-erp");
        var (tokenId, value) = await CreateTokenAsync(admin, bot, "produção");
        using var client = BearerClient(value);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/auth/me")).StatusCode);

        Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsync($"/api/admin/bots/{bot}/tokens/{tokenId}/revoke", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsync($"/api/admin/bots/{bot}/tokens/{tokenId}/revoke", null)).StatusCode);

        await (await client.GetAsync("/api/auth/me")).AssertProblemAsync(HttpStatusCode.Unauthorized, "unauthenticated");
    }

    [Fact]
    public async Task Deactivated_bot_tokens_stop_working_until_reactivated()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var bot = await CreateBotAsync(admin, "integracao-erp");
        var (_, value) = await CreateTokenAsync(admin, bot, "produção");
        using var client = BearerClient(value);

        Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsync($"/api/admin/bots/{bot}/deactivate", null)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/auth/me")).StatusCode);

        Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsync($"/api/admin/bots/{bot}/activate", null)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/auth/me")).StatusCode);
    }

    [Theory]
    [InlineData("chn_abcdefgh_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]
    [InlineData("not-a-token")]
    [InlineData("chn_")]
    public async Task Unknown_or_malformed_tokens_are_rejected_and_audited(string value)
    {
        using var client = BearerClient(value);

        await (await client.GetAsync("/api/auth/me")).AssertProblemAsync(HttpStatusCode.Unauthorized, "unauthenticated");
        Assert.Equal(1, await _factory.CountAsync("SELECT count(*) FROM chain.audit_events WHERE action = 'auth.token.failed'"));
    }

    [Fact]
    public async Task Token_with_a_known_prefix_but_a_wrong_secret_is_rejected()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var bot = await CreateBotAsync(admin, "integracao-erp");
        var (_, value) = await CreateTokenAsync(admin, bot, "produção");
        var forged = value[..^1] + (value[^1] == 'A' ? 'B' : 'A'); // same prefix, secret differs in one character

        using var client = BearerClient(forged);

        await (await client.GetAsync("/api/auth/me")).AssertProblemAsync(HttpStatusCode.Unauthorized, "unauthenticated");
    }

    [Fact]
    public async Task Bearer_takes_precedence_over_a_session_cookie()
    {
        using var admin = await _factory.CreateReadyAdminAsync();

        admin.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "not-a-token");

        Assert.Equal(HttpStatusCode.Unauthorized, (await admin.GetAsync("/api/auth/me")).StatusCode);
    }

    // 4. Bots are not humans

    [Fact]
    public async Task Bots_cannot_log_in_or_change_passwords_or_log_out()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var bot = await CreateBotAsync(admin, "integracao-erp");
        var (_, value) = await CreateTokenAsync(admin, bot, "produção");

        using var browser = _factory.CreateBrowser();
        await (await browser.LoginAsync("integracao-erp", "anything-at-all-123")).AssertProblemAsync(HttpStatusCode.Unauthorized, "invalid_credentials");

        using var client = BearerClient(value);
        var change = await client.PostAsJsonAsync("/api/auth/change-password", new { currentPassword = "x", newPassword = "a-very-long-password" });
        await change.AssertProblemAsync(HttpStatusCode.Forbidden, "forbidden");
        await (await client.PostAsync("/api/auth/logout", null)).AssertProblemAsync(HttpStatusCode.Forbidden, "forbidden");
    }

    [Fact]
    public async Task Database_rejects_a_bot_admin()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var bot = await CreateBotAsync(admin, "integracao-erp");

        var error = await Assert.ThrowsAnyAsync<Exception>(() => _factory.QueryAsync($"UPDATE chain.users SET is_admin = true WHERE id = '{bot}' RETURNING id"));

        Assert.Contains("ck_users_bot_not_admin", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Bots_are_not_listed_or_managed_as_users()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var bot = await CreateBotAsync(admin, "integracao-erp");

        var users = await admin.GetFromJsonAsync<JsonElement>("/api/admin/users");

        Assert.Equal(1, users.GetProperty("total").GetInt32()); // only the admin
        await (await admin.GetAsync($"/api/admin/users/{bot}")).AssertProblemAsync(HttpStatusCode.NotFound, "not_found");
        Assert.Single((await admin.GetFromJsonAsync<JsonElement>("/api/admin/bots")).EnumerateArray());
    }

    // 5. Shared name space

    [Fact]
    public async Task Bot_and_user_names_share_one_namespace()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        await CreateBotAsync(admin, "integracao-erp");

        var userClash = await admin.PostAsJsonAsync("/api/admin/users", new { username = "integracao-erp", displayName = "X", isAdmin = false });
        var botClash = await admin.PostAsJsonAsync("/api/admin/bots", new { name = ApiTestSession.AdminUsername, displayName = "X" });

        await userClash.AssertProblemAsync(HttpStatusCode.Conflict, "username_taken");
        await botClash.AssertProblemAsync(HttpStatusCode.Conflict, "username_taken");
    }

    // 6. Token limit

    [Fact]
    public async Task At_most_five_active_tokens_per_bot()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var bot = await CreateBotAsync(admin, "integracao-erp");
        var first = Guid.Empty;
        for (var i = 0; i < 5; i++)
        {
            var (id, _) = await CreateTokenAsync(admin, bot, $"token {i}");
            first = i == 0 ? id : first;
        }

        var sixth = await admin.PostAsJsonAsync($"/api/admin/bots/{bot}/tokens", new { label = "sexto" });
        await sixth.AssertProblemAsync(HttpStatusCode.Conflict, "token_limit_reached");

        await admin.PostAsync($"/api/admin/bots/{bot}/tokens/{first}/revoke", null);
        Assert.Equal(HttpStatusCode.Created, (await admin.PostAsJsonAsync($"/api/admin/bots/{bot}/tokens", new { label = "sexto" })).StatusCode);
    }

    [Fact]
    public async Task Bot_views_count_the_active_tokens_in_the_list_too()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var erp = await CreateBotAsync(admin, "integracao-erp");
        var crm = await CreateBotAsync(admin, "integracao-crm");
        var (revoked, _) = await CreateTokenAsync(admin, erp, "antigo");
        await CreateTokenAsync(admin, erp, "produção");
        await CreateTokenAsync(admin, erp, "homologação");
        Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsync($"/api/admin/bots/{erp}/tokens/{revoked}/revoke", null)).StatusCode);

        // The list's Tokens column (admin-ui.md §6.1, S-A3), and the bot's own view.
        var listed = (await admin.GetFromJsonAsync<JsonElement>("/api/admin/bots")).EnumerateArray()
            .ToDictionary(bot => bot.GetProperty("id").GetGuid(), bot => bot.GetProperty("activeTokenCount").GetInt32());
        Assert.Equal(2, listed[erp]);
        Assert.Equal(0, listed[crm]);
        Assert.Equal(2, (await admin.GetFromJsonAsync<JsonElement>($"/api/admin/bots/{erp}")).GetProperty("activeTokenCount").GetInt32());
    }

    // 7. Origin exemption for bearer requests

    [Fact]
    public async Task Bearer_requests_need_no_origin_but_cookie_requests_do()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var bot = await CreateBotAsync(admin, "integracao-erp");
        var (_, value) = await CreateTokenAsync(admin, bot, "produção");

        // Without an Origin header the bearer request still reaches the endpoint (which refuses bots with "forbidden").
        using var bearer = BearerClient(value);
        await (await bearer.PostAsync("/api/auth/logout", null)).AssertProblemAsync(HttpStatusCode.Forbidden, "forbidden");

        using var noOrigin = _factory.CreateClient(new() { BaseAddress = new Uri("https://localhost") });
        await (await noOrigin.PostAsync("/api/auth/logout", null)).AssertProblemAsync(HttpStatusCode.Forbidden, "origin_not_allowed");
    }

    // 8. Admin-only

    [Fact]
    public async Task Bots_and_non_admins_cannot_manage_bots()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var bot = await CreateBotAsync(admin, "integracao-erp");
        var (_, value) = await CreateTokenAsync(admin, bot, "produção");
        using var client = BearerClient(value);

        await (await client.GetAsync("/api/admin/bots")).AssertProblemAsync(HttpStatusCode.Forbidden, "forbidden");
        await (await client.PostAsJsonAsync($"/api/admin/bots/{bot}/tokens", new { label = "eu mesmo" })).AssertProblemAsync(HttpStatusCode.Forbidden, "forbidden");
    }

    // 9. Last used

    [Fact]
    public async Task Last_used_is_recorded_at_most_once_per_minute()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var bot = await CreateBotAsync(admin, "integracao-erp");
        var (_, value) = await CreateTokenAsync(admin, bot, "produção");
        using var client = BearerClient(value);

        await client.GetAsync("/api/auth/me");
        var first = await LastUsedAsync(bot);
        _factory.Time.Advance(TimeSpan.FromSeconds(30));
        await client.GetAsync("/api/auth/me");
        var second = await LastUsedAsync(bot);
        _factory.Time.Advance(TimeSpan.FromSeconds(31));
        await client.GetAsync("/api/auth/me");
        var third = await LastUsedAsync(bot);

        Assert.NotNull(first);
        Assert.Equal(first, second);
        Assert.Equal(first + 61, third);
    }

    // Helpers

    // Regression #129: PostgreSQL text cannot store the NUL character, so a display name or token label with one was a 500.

    [Fact]
    public async Task A_bot_display_name_or_token_label_with_the_NUL_character_is_invalid()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var bot = await CreateBotAsync(admin, "integracao-erp");

        var created = await admin.PostAsJsonAsync("/api/admin/bots", new { name = "outro-robo", displayName = "Robô\u0000" });
        var token = await admin.PostAsJsonAsync($"/api/admin/bots/{bot}/tokens", new { label = "produção\u0000" });

        await created.AssertValidationFailedAsync("invalid_display_name");
        await token.AssertValidationFailedAsync("invalid_label");
        Assert.Equal(0, await _factory.CountAsync("SELECT count(*) FROM chain.users WHERE username = 'outro-robo'"));
        Assert.Equal(0, await _factory.CountAsync($"SELECT count(*) FROM chain.bot_tokens WHERE bot_id = '{bot}'"));
    }

    private HttpClient BearerClient(string token)
    {
        var client = _factory.CreateClient(new() { BaseAddress = new Uri("https://localhost") });
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return client;
    }

    private static async Task<Guid> CreateBotAsync(HttpClient admin, string name, string displayName = "Robô")
    {
        var response = await admin.PostAsJsonAsync("/api/admin/bots", new { name, displayName });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    private static async Task<(Guid Id, string Value)> CreateTokenAsync(HttpClient admin, Guid bot, string label)
    {
        var response = await admin.PostAsJsonAsync($"/api/admin/bots/{bot}/tokens", new { label });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        return (body.GetProperty("token").GetProperty("id").GetGuid(), body.GetProperty("value").GetString()!);
    }

    private static async Task<Guid> CreateGroupAsync(HttpClient admin, string name)
    {
        var response = await admin.PostAsJsonAsync("/api/admin/groups", new { name });
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    /// <summary>Seconds since the Unix epoch of the token's last use, or null if never used.</summary>
    private async Task<double?> LastUsedAsync(Guid bot)
    {
        var value = (await _factory.QueryAsync($"SELECT extract(epoch FROM last_used_at) FROM chain.bot_tokens WHERE bot_id = '{bot}'")).Single();
        return string.IsNullOrEmpty(value) ? null : double.Parse(value, System.Globalization.CultureInfo.InvariantCulture);
    }
}
