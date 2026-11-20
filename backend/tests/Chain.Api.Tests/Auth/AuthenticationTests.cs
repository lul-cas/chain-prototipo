using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Chain.Api.Cli;
using Chain.Api.Tests.Infrastructure;
using Chain.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Chain.Api.Tests.Auth;

/// <summary>Acceptance criteria of identity increment I1 (specs/modules/identity.md).</summary>
[Collection(PostgresTestGroup.Name)]
public sealed class AuthenticationTests(PostgresFixture postgres) : IAsyncLifetime, IDisposable
{
    private const string AdminUsername = "admin";
    private const string AdminPassword = "initial-password-123";
    private const string NewPassword = "a-much-better-passphrase";

    private readonly ChainApiFactory _factory = new(postgres.ConnectionString);

    public async Task InitializeAsync() => await _factory.ResetDatabaseAsync();

    public Task DisposeAsync() => Task.CompletedTask;

    public void Dispose() => _factory.Dispose();

    // 1. Bootstrap

    [Fact]
    public async Task Bootstrap_creates_the_first_admin_exactly_once()
    {
        Assert.Equal(0, await BootstrapAsync());

        var output = new StringWriter();
        var exitCode = await BootstrapAsync(output: output, username: "second");

        Assert.NotEqual(0, exitCode);
        Assert.Contains("already", output.ToString(), StringComparison.OrdinalIgnoreCase);
        Assert.Equal(1, await CountAsync("SELECT count(*) FROM chain.users"));
    }

    [Fact]
    public async Task Bootstrap_reads_the_password_from_the_environment_variable()
    {
        Assert.Equal(0, await BootstrapAsync(passwordFromEnvironment: AdminPassword, stdinPassword: null));

        using var browser = _factory.CreateBrowser();
        Assert.Equal(HttpStatusCode.NoContent, (await LoginAsync(browser)).StatusCode);
    }

    [Fact]
    public async Task Bootstrap_rejects_a_password_that_violates_the_policy()
    {
        Assert.NotEqual(0, await BootstrapAsync(stdinPassword: "short"));
        Assert.Equal(0, await CountAsync("SELECT count(*) FROM chain.users"));
    }

    // 2. Login and session cookie

    [Fact]
    public async Task Login_sets_a_hardened_session_cookie_and_me_returns_the_user()
    {
        await BootstrapAsync();
        using var raw = _factory.CreateBrowser(handleCookies: false);

        var response = await LoginAsync(raw);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        var cookie = Assert.Single(response.Headers.GetValues("Set-Cookie"));
        Assert.StartsWith("chain_session=", cookie, StringComparison.Ordinal);
        Assert.Contains("httponly", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("secure", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("samesite=strict", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("path=/", cookie, StringComparison.OrdinalIgnoreCase);

        using var browser = _factory.CreateBrowser();
        await LoginAsync(browser);
        var me = await browser.GetFromJsonAsync<JsonElement>("/api/auth/me");
        Assert.Equal(AdminUsername, me.GetProperty("username").GetString());
        Assert.True(me.GetProperty("isAdmin").GetBoolean());
        Assert.True(me.GetProperty("mustChangePassword").GetBoolean());
    }

    [Fact]
    public async Task Username_is_case_insensitive()
    {
        await BootstrapAsync();
        using var browser = _factory.CreateBrowser();

        Assert.Equal(HttpStatusCode.NoContent, (await LoginAsync(browser, "ADMIN")).StatusCode);
    }

    [Fact]
    public async Task Me_requires_a_session()
    {
        using var browser = _factory.CreateBrowser();

        Assert.Equal(HttpStatusCode.Unauthorized, (await browser.GetAsync("/api/auth/me")).StatusCode);
    }

    [Fact]
    public async Task Login_with_missing_fields_is_a_validation_error()
    {
        using var browser = _factory.CreateBrowser();

        var response = await browser.PostAsJsonAsync("/api/auth/login", new { username = "admin" });

        await AssertProblemAsync(response, HttpStatusCode.BadRequest, "validation_failed");
    }

    // 3. Indistinguishable failures

    [Fact]
    public async Task Every_kind_of_login_failure_returns_the_identical_response()
    {
        await BootstrapAsync();
        using var browser = _factory.CreateBrowser();

        var wrongPassword = await ReadBodyAsync(await LoginAsync(browser, password: "wrong-password-123"));
        var unknownUser = await ReadBodyAsync(await LoginAsync(browser, username: "nobody"));
        var invalidUsername = await ReadBodyAsync(await LoginAsync(browser, username: "not a username!"));

        await ExecuteAsync("UPDATE chain.users SET is_active = false");
        var inactive = await ReadBodyAsync(await LoginAsync(browser));

        await ExecuteAsync("UPDATE chain.users SET is_active = true, locked_until = '2026-10-15 13:00:00+00'");
        var locked = await ReadBodyAsync(await LoginAsync(browser));

        foreach (var (status, body) in new[] { wrongPassword, unknownUser, invalidUsername, inactive, locked })
        {
            Assert.Equal(HttpStatusCode.Unauthorized, status);
            Assert.Equal(wrongPassword.Body, body);
        }

        Assert.Contains("invalid_credentials", wrongPassword.Body, StringComparison.Ordinal);
    }

    // Regression #129: auth.login.failed records the username as typed, and PostgreSQL jsonb cannot store the NUL character, so
    // a login with one was a 500, and the failure went unaudited.

    [Fact]
    public async Task A_login_name_with_the_NUL_character_fails_like_any_other_and_is_audited_without_it()
    {
        await BootstrapAsync();
        using var browser = _factory.CreateBrowser();
        var wrongPassword = await ReadBodyAsync(await LoginAsync(browser, password: "wrong-password-123"));

        var nul = await ReadBodyAsync(await LoginAsync(browser, username: "admin\u0000"));

        Assert.Equal((HttpStatusCode.Unauthorized, wrongPassword.Body), nul);
        Assert.Equal(1, await CountAsync(
            "SELECT count(*) FROM chain.audit_events WHERE action = 'auth.login.failed' AND details ? 'username' AND details->>'username' IS NULL AND details->>'reason' = 'unknown_user'"));
    }

    // 4. Lockout

    [Fact]
    public async Task Five_consecutive_failures_lock_the_account_for_fifteen_minutes()
    {
        await BootstrapAsync();
        using var browser = _factory.CreateBrowser();

        for (var i = 0; i < 5; i++)
        {
            Assert.Equal(HttpStatusCode.Unauthorized, (await LoginAsync(browser, password: "wrong-password-123")).StatusCode);
        }

        Assert.Equal(HttpStatusCode.Unauthorized, (await LoginAsync(browser)).StatusCode);

        _factory.Time.Advance(TimeSpan.FromMinutes(15));
        Assert.Equal(HttpStatusCode.NoContent, (await LoginAsync(browser)).StatusCode);
        Assert.Equal(1, await CountAsync("SELECT count(*) FROM chain.audit_events WHERE action = 'auth.lockout'"));
    }

    [Fact]
    public async Task A_successful_login_resets_the_failure_count()
    {
        await BootstrapAsync();
        using var browser = _factory.CreateBrowser();

        for (var i = 0; i < 4; i++)
        {
            await LoginAsync(browser, password: "wrong-password-123");
        }

        Assert.Equal(HttpStatusCode.NoContent, (await LoginAsync(browser)).StatusCode);
        await LoginAsync(browser, password: "wrong-password-123");

        Assert.Equal(HttpStatusCode.NoContent, (await LoginAsync(browser)).StatusCode);
    }

    [Fact]
    public async Task Concurrent_failures_lock_the_account_exactly_once()
    {
        await BootstrapAsync();

        var attempts = Enumerable.Range(0, 12).Select(async _ =>
        {
            using var browser = _factory.CreateBrowser();
            return (await LoginAsync(browser, password: "wrong-password-123")).StatusCode;
        });
        var results = await Task.WhenAll(attempts);

        Assert.All(results, status => Assert.Equal(HttpStatusCode.Unauthorized, status));
        Assert.Equal(1, await CountAsync("SELECT count(*) FROM chain.audit_events WHERE action = 'auth.lockout'"));
        Assert.Equal(1, await CountAsync("SELECT count(*) FROM chain.users WHERE locked_until > '2026-10-15 12:00:00+00'"));

        using var correct = _factory.CreateBrowser();
        Assert.Equal(HttpStatusCode.Unauthorized, (await LoginAsync(correct)).StatusCode);
    }

    // 5. Logout and expiry

    [Fact]
    public async Task Logout_makes_the_session_unusable()
    {
        await BootstrapAsync();
        using var browser = _factory.CreateBrowser(handleCookies: false);
        var cookie = SessionCookie(await LoginAsync(browser));

        var logout = await SendWithCookieAsync(browser, HttpMethod.Post, "/api/auth/logout", cookie);
        Assert.Equal(HttpStatusCode.NoContent, logout.StatusCode);

        var me = await SendWithCookieAsync(browser, HttpMethod.Get, "/api/auth/me", cookie);
        Assert.Equal(HttpStatusCode.Unauthorized, me.StatusCode);
    }

    [Fact]
    public async Task Session_expires_after_thirty_idle_minutes()
    {
        await BootstrapAsync();
        using var browser = _factory.CreateBrowser();
        await LoginAsync(browser);

        _factory.Time.Advance(TimeSpan.FromMinutes(29));
        Assert.Equal(HttpStatusCode.OK, (await browser.GetAsync("/api/auth/me")).StatusCode);

        _factory.Time.Advance(TimeSpan.FromMinutes(30));
        Assert.Equal(HttpStatusCode.Unauthorized, (await browser.GetAsync("/api/auth/me")).StatusCode);
    }

    [Fact]
    public async Task Session_expires_after_twelve_hours_even_when_active()
    {
        await BootstrapAsync();
        using var browser = _factory.CreateBrowser();
        await LoginAsync(browser);

        for (var i = 0; i < 35; i++)
        {
            _factory.Time.Advance(TimeSpan.FromMinutes(20));
            Assert.Equal(HttpStatusCode.OK, (await browser.GetAsync("/api/auth/me")).StatusCode);
        }

        _factory.Time.Advance(TimeSpan.FromMinutes(20)); // 12h00 after login
        Assert.Equal(HttpStatusCode.Unauthorized, (await browser.GetAsync("/api/auth/me")).StatusCode);
    }

    [Fact]
    public async Task Forged_session_cookie_is_rejected()
    {
        using var browser = _factory.CreateBrowser(handleCookies: false);

        var me = await SendWithCookieAsync(browser, HttpMethod.Get, "/api/auth/me", "chain_session=forged-token");

        Assert.Equal(HttpStatusCode.Unauthorized, me.StatusCode);
    }

    // 6. Must change password

    [Fact]
    public async Task User_who_must_change_password_is_restricted_to_the_auth_endpoints()
    {
        await BootstrapAsync();
        using var browser = _factory.CreateBrowser();
        await LoginAsync(browser);

        var other = await browser.GetAsync("/api/anything-else");

        await AssertProblemAsync(other, HttpStatusCode.Forbidden, "password_change_required");
        Assert.Equal(HttpStatusCode.OK, (await browser.GetAsync("/api/auth/me")).StatusCode);
    }

    [Fact]
    public async Task Changing_the_password_lifts_the_restriction()
    {
        await BootstrapAsync();
        using var browser = _factory.CreateBrowser();
        await LoginAsync(browser);

        var change = await ChangePasswordAsync(browser, AdminPassword, NewPassword);

        Assert.Equal(HttpStatusCode.NoContent, change.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await browser.GetAsync("/api/anything-else")).StatusCode);
        var me = await browser.GetFromJsonAsync<JsonElement>("/api/auth/me");
        Assert.False(me.GetProperty("mustChangePassword").GetBoolean());
    }

    [Fact]
    public async Task Changing_the_password_requires_the_current_password()
    {
        await BootstrapAsync();
        using var browser = _factory.CreateBrowser();
        await LoginAsync(browser);

        var change = await ChangePasswordAsync(browser, "not-the-password", NewPassword);

        await AssertProblemAsync(change, HttpStatusCode.Forbidden, "invalid_current_password");
    }

    [Fact]
    public async Task New_password_must_satisfy_the_policy()
    {
        await BootstrapAsync();
        using var browser = _factory.CreateBrowser();
        await LoginAsync(browser);

        var change = await ChangePasswordAsync(browser, AdminPassword, "short");

        await AssertProblemAsync(change, HttpStatusCode.BadRequest, "validation_failed");
    }

    // 7. Password change revokes other sessions

    [Fact]
    public async Task Changing_the_password_revokes_the_other_sessions_only()
    {
        await BootstrapAsync();
        using var laptop = _factory.CreateBrowser();
        using var phone = _factory.CreateBrowser();
        await LoginAsync(laptop);
        await LoginAsync(phone);

        await ChangePasswordAsync(laptop, AdminPassword, NewPassword);

        Assert.Equal(HttpStatusCode.OK, (await laptop.GetAsync("/api/auth/me")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await phone.GetAsync("/api/auth/me")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await LoginAsync(phone, password: NewPassword)).StatusCode);
    }

    // 8. Origin check

    [Theory]
    [InlineData(null)]
    [InlineData("https://evil.example")]
    public async Task State_changing_requests_from_other_origins_are_rejected(string? origin)
    {
        await BootstrapAsync();
        using var client = _factory.CreateClient(new() { BaseAddress = new Uri("https://localhost") });
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/auth/login")
        {
            Content = JsonContent.Create(new { username = AdminUsername, password = AdminPassword }),
        };
        if (origin is not null)
        {
            request.Headers.Add("Origin", origin);
        }

        var response = await client.SendAsync(request);

        await AssertProblemAsync(response, HttpStatusCode.Forbidden, "origin_not_allowed");
    }

    // 9. Audit without secrets

    [Fact]
    public async Task Authentication_events_are_audited_without_secrets()
    {
        await BootstrapAsync();
        using var browser = _factory.CreateBrowser();
        await LoginAsync(browser, password: "wrong-password-123");
        await LoginAsync(browser);
        await ChangePasswordAsync(browser, AdminPassword, NewPassword);
        await browser.PostAsync("/api/auth/logout", null);

        var actions = await QueryAsync("SELECT action FROM chain.audit_events");
        string[] expected = ["auth.admin.bootstrapped", "auth.login.failed", "auth.login.succeeded", "auth.logout", "auth.password.changed"];
        Assert.Equal(expected, actions.Order(StringComparer.Ordinal));

        var everything = string.Join('\n', await QueryAsync("SELECT details::text FROM chain.audit_events"));
        Assert.DoesNotContain(AdminPassword, everything, StringComparison.Ordinal);
        Assert.DoesNotContain(NewPassword, everything, StringComparison.Ordinal);
        Assert.DoesNotContain("wrong-password-123", everything, StringComparison.Ordinal);
    }

    // Helpers

    private async Task<int> BootstrapAsync(
        string username = AdminUsername,
        string? stdinPassword = AdminPassword,
        string? passwordFromEnvironment = null,
        TextWriter? output = null)
    {
        _ = _factory.Server; // ensure the host (and migrations) started
        return await BootstrapAdminCommand.RunAsync(
            ["bootstrap-admin", "--username", username],
            _factory.Services,
            new StringReader(stdinPassword ?? string.Empty),
            output ?? TextWriter.Null,
            name => name == BootstrapAdminCommand.PasswordVariable ? passwordFromEnvironment : null);
    }

    private static Task<HttpResponseMessage> LoginAsync(HttpClient client, string username = AdminUsername, string password = AdminPassword) =>
        client.PostAsJsonAsync("/api/auth/login", new { username, password });

    private static Task<HttpResponseMessage> ChangePasswordAsync(HttpClient client, string currentPassword, string newPassword) =>
        client.PostAsJsonAsync("/api/auth/change-password", new { currentPassword, newPassword });

    private static string SessionCookie(HttpResponseMessage loginResponse) =>
        loginResponse.Headers.GetValues("Set-Cookie").Single().Split(';')[0];

    private static async Task<HttpResponseMessage> SendWithCookieAsync(HttpClient client, HttpMethod method, string path, string cookie)
    {
        using var request = new HttpRequestMessage(method, path);
        request.Headers.Add("Cookie", cookie);
        return await client.SendAsync(request);
    }

    private static async Task<(HttpStatusCode Status, string Body)> ReadBodyAsync(HttpResponseMessage response) =>
        (response.StatusCode, await response.Content.ReadAsStringAsync());

    private static async Task AssertProblemAsync(HttpResponseMessage response, HttpStatusCode status, string code)
    {
        Assert.Equal(status, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(code, problem.GetProperty("code").GetString());
    }

    private async Task ExecuteAsync(string sql)
    {
        using var scope = _factory.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<ChainDbContext>().Database.ExecuteSqlRawAsync(sql);
    }

    private async Task<long> CountAsync(string sql) => long.Parse((await QueryAsync(sql)).Single(), System.Globalization.CultureInfo.InvariantCulture);

    private async Task<List<string>> QueryAsync(string sql)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ChainDbContext>();
        await using var connection = db.Database.GetDbConnection();
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        var values = new List<string>();
        await using var reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            values.Add(Convert.ToString(reader.GetValue(0), System.Globalization.CultureInfo.InvariantCulture)!);
        }

        return values;
    }
}
