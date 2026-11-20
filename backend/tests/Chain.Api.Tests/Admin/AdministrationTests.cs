using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Chain.Api.Tests.Infrastructure;
using static Chain.Api.Tests.Infrastructure.ApiTestSession;

namespace Chain.Api.Tests.Admin;

/// <summary>Acceptance criteria of identity increment I2 (specs/modules/identity.md).</summary>
[Collection(PostgresTestGroup.Name)]
public sealed class AdministrationTests(PostgresFixture postgres) : IAsyncLifetime, IDisposable
{
    private const string UserPassword = "ana-own-passphrase";

    private readonly ChainApiFactory _factory = new(postgres.ConnectionString);

    public async Task InitializeAsync() => await _factory.ResetDatabaseAsync();

    public Task DisposeAsync() => Task.CompletedTask;

    public void Dispose() => _factory.Dispose();

    // 1. Admin-only

    [Fact]
    public async Task Admin_endpoints_require_a_session()
    {
        using var anonymous = _factory.CreateBrowser();

        await (await anonymous.GetAsync("/api/admin/users")).AssertProblemAsync(HttpStatusCode.Unauthorized, "unauthenticated");
        await (await anonymous.GetAsync("/api/admin/groups")).AssertProblemAsync(HttpStatusCode.Unauthorized, "unauthenticated");
    }

    [Fact]
    public async Task Admin_endpoints_are_forbidden_to_non_admins()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var (_, temporary) = await CreateUserAsync(admin, "ana.souza");
        using var ana = await _factory.CreateReadyUserAsync("ana.souza", temporary, UserPassword);

        await (await ana.GetAsync("/api/admin/users")).AssertProblemAsync(HttpStatusCode.Forbidden, "forbidden");
        await (await ana.PostAsJsonAsync("/api/admin/groups", new { name = "Hackers" })).AssertProblemAsync(HttpStatusCode.Forbidden, "forbidden");
    }

    [Fact]
    public async Task Demoted_admin_loses_access_immediately()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var (bruno, temporary) = await CreateUserAsync(admin, "bruno", isAdmin: true);
        using var brunoBrowser = await _factory.CreateReadyUserAsync("bruno", temporary, UserPassword);
        Assert.Equal(HttpStatusCode.OK, (await brunoBrowser.GetAsync("/api/admin/users")).StatusCode);

        await PatchUserAsync(admin, bruno, new { isAdmin = false });

        Assert.Equal(HttpStatusCode.Forbidden, (await brunoBrowser.GetAsync("/api/admin/users")).StatusCode);
    }

    // 2. Create user with temporary password

    [Fact]
    public async Task Created_user_signs_in_with_the_temporary_password_and_must_change_it()
    {
        using var admin = await _factory.CreateReadyAdminAsync();

        var (id, temporary) = await CreateUserAsync(admin, "Ana.Souza", displayName: "Ana Souza");

        Assert.Equal(20, temporary.Length);
        using var ana = _factory.CreateBrowser();
        Assert.Equal(HttpStatusCode.NoContent, (await ana.LoginAsync("ana.souza", temporary)).StatusCode);
        var me = await ana.GetFromJsonAsync<JsonElement>("/api/auth/me");
        Assert.Equal(id, me.GetProperty("id").GetGuid());
        Assert.Equal("Ana Souza", me.GetProperty("displayName").GetString());
        Assert.True(me.GetProperty("mustChangePassword").GetBoolean());
    }

    [Fact]
    public async Task Users_can_be_listed_and_searched()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        await CreateUserAsync(admin, "ana.souza", displayName: "Ana Souza");
        await CreateUserAsync(admin, "bruno.lima", displayName: "Bruno Lima");

        var all = await admin.GetFromJsonAsync<JsonElement>("/api/admin/users");
        var search = await admin.GetFromJsonAsync<JsonElement>("/api/admin/users?search=bruno");
        var paged = await admin.GetFromJsonAsync<JsonElement>("/api/admin/users?limit=1&offset=1");

        Assert.Equal(3, all.GetProperty("total").GetInt32());
        Assert.Equal("bruno.lima", Assert.Single(search.GetProperty("items").EnumerateArray()).GetProperty("username").GetString());
        Assert.Equal(3, paged.GetProperty("total").GetInt32());
        Assert.Single(paged.GetProperty("items").EnumerateArray());
    }

    // Regression #153: PostgreSQL refuses the NUL character in the ILIKE pattern (22021), so this was a 500. No stored name
    // holds text PostgreSQL cannot store (I1), so such a search matches nobody.

    [Fact]
    public async Task A_search_with_the_NUL_character_matches_nobody()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        await CreateUserAsync(admin, "ana.souza", displayName: "Ana Souza");

        var response = await admin.GetAsync("/api/admin/users?search=ana%00");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var page = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(0, page.GetProperty("total").GetInt32());
        Assert.Empty(page.GetProperty("items").EnumerateArray());
    }

    [Fact]
    public async Task Invalid_user_input_is_rejected()
    {
        using var admin = await _factory.CreateReadyAdminAsync();

        var badUsername = await admin.PostAsJsonAsync("/api/admin/users", new { username = "ana souza", displayName = "Ana", isAdmin = false });
        var blankName = await admin.PostAsJsonAsync("/api/admin/users", new { username = "ana", displayName = " ", isAdmin = false });

        await badUsername.AssertProblemAsync(HttpStatusCode.BadRequest, "validation_failed");
        await blankName.AssertProblemAsync(HttpStatusCode.BadRequest, "validation_failed");
    }

    // Regression #129: PostgreSQL text cannot store the NUL character, so a name or description with one was a 500.

    [Fact]
    public async Task A_display_name_with_the_NUL_character_is_invalid()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var (id, _) = await CreateUserAsync(admin, "ana.souza", displayName: "Ana Souza");

        var created = await admin.PostAsJsonAsync("/api/admin/users", new { username = "bruno", displayName = "Bruno\u0000Lima", isAdmin = false });
        var renamed = await PatchUserAsync(admin, id, new { displayName = "Ana\u0000" }, expectSuccess: false);

        await created.AssertValidationFailedAsync("invalid_display_name");
        await renamed.AssertValidationFailedAsync("invalid_display_name");
        Assert.Equal(0, await _factory.CountAsync("SELECT count(*) FROM chain.users WHERE username = 'bruno'"));
        Assert.Equal("Ana Souza", (await admin.GetFromJsonAsync<JsonElement>($"/api/admin/users/{id}")).GetProperty("displayName").GetString());
    }

    [Fact]
    public async Task A_group_name_or_description_with_the_NUL_character_is_invalid()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var id = await CreateGroupAsync(admin, "Análise");
        var etag = (await admin.GetAsync($"/api/admin/groups/{id}")).Headers.ETag!.Tag;

        await (await admin.PostAsJsonAsync("/api/admin/groups", new { name = "Crédito\u0000" })).AssertValidationFailedAsync("invalid_group_name");
        await (await admin.PostAsJsonAsync("/api/admin/groups", new { name = "Crédito", description = "Time\u0000" })).AssertValidationFailedAsync("invalid_description");
        await (await SendPatchAsync(admin, $"/api/admin/groups/{id}", new { name = "Análise\u0000" }, etag)).AssertValidationFailedAsync("invalid_group_name");
        await (await SendPatchAsync(admin, $"/api/admin/groups/{id}", new { description = "\u0000" }, etag)).AssertValidationFailedAsync("invalid_description");

        Assert.Equal(["Análise"], await _factory.QueryAsync("SELECT name FROM chain.groups"));
    }

    [Fact]
    public async Task Unknown_ids_return_not_found()
    {
        using var admin = await _factory.CreateReadyAdminAsync();

        await (await admin.GetAsync($"/api/admin/users/{Guid.NewGuid()}")).AssertProblemAsync(HttpStatusCode.NotFound, "not_found");
        await (await admin.PostAsync($"/api/admin/groups/{Guid.NewGuid()}/archive", null)).AssertProblemAsync(HttpStatusCode.NotFound, "not_found");
    }

    // 3. Uniqueness

    [Fact]
    public async Task Duplicate_usernames_are_rejected_ignoring_case()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        await CreateUserAsync(admin, "ana.souza");

        var duplicate = await admin.PostAsJsonAsync("/api/admin/users", new { username = "ANA.SOUZA", displayName = "Outra Ana", isAdmin = false });

        await duplicate.AssertProblemAsync(HttpStatusCode.Conflict, "username_taken");
    }

    [Fact]
    public async Task Duplicate_group_names_are_rejected_ignoring_case()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        await CreateGroupAsync(admin, "Análise de Crédito");

        var duplicate = await admin.PostAsJsonAsync("/api/admin/groups", new { name = "análise de crédito" });

        await duplicate.AssertProblemAsync(HttpStatusCode.Conflict, "group_name_taken");
    }

    // 4. Deactivation

    [Fact]
    public async Task Deactivation_revokes_sessions_and_blocks_login_until_reactivated()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var (ana, temporary) = await CreateUserAsync(admin, "ana.souza");
        using var anaBrowser = await _factory.CreateReadyUserAsync("ana.souza", temporary, UserPassword);

        Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsync($"/api/admin/users/{ana}/deactivate", null)).StatusCode);

        Assert.Equal(HttpStatusCode.Unauthorized, (await anaBrowser.GetAsync("/api/auth/me")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anaBrowser.LoginAsync("ana.souza", UserPassword)).StatusCode);

        Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsync($"/api/admin/users/{ana}/activate", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await anaBrowser.LoginAsync("ana.souza", UserPassword)).StatusCode);
    }

    // 5. Reset password and unlock

    [Fact]
    public async Task Password_reset_revokes_sessions_unlocks_and_forces_a_change()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var (ana, temporary) = await CreateUserAsync(admin, "ana.souza");
        using var anaBrowser = await _factory.CreateReadyUserAsync("ana.souza", temporary, UserPassword);
        await LockOutAsync("ana.souza");

        var reset = await admin.PostAsync($"/api/admin/users/{ana}/reset-password", null);

        Assert.Equal(HttpStatusCode.OK, reset.StatusCode);
        var newTemporary = (await reset.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("temporaryPassword").GetString()!;
        Assert.Equal(HttpStatusCode.Unauthorized, (await anaBrowser.GetAsync("/api/auth/me")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anaBrowser.LoginAsync("ana.souza", UserPassword)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await anaBrowser.LoginAsync("ana.souza", newTemporary)).StatusCode);
        var me = await anaBrowser.GetFromJsonAsync<JsonElement>("/api/auth/me");
        Assert.True(me.GetProperty("mustChangePassword").GetBoolean());
    }

    [Fact]
    public async Task Unlock_lets_a_locked_user_sign_in_again()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var (ana, temporary) = await CreateUserAsync(admin, "ana.souza");
        (await _factory.CreateReadyUserAsync("ana.souza", temporary, UserPassword)).Dispose();
        await LockOutAsync("ana.souza");

        var user = await admin.GetFromJsonAsync<JsonElement>($"/api/admin/users/{ana}");
        Assert.True(user.GetProperty("isLocked").GetBoolean());

        Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsync($"/api/admin/users/{ana}/unlock", null)).StatusCode);

        using var anaBrowser = _factory.CreateBrowser();
        Assert.Equal(HttpStatusCode.NoContent, (await anaBrowser.LoginAsync("ana.souza", UserPassword)).StatusCode);
    }

    // 6. Last admin and self-protection

    [Fact]
    public async Task The_last_admin_cannot_be_demoted()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var adminId = await MyIdAsync(admin);

        var demote = await PatchUserAsync(admin, adminId, new { isAdmin = false }, expectSuccess: false);

        await demote.AssertProblemAsync(HttpStatusCode.Conflict, "last_admin");
    }

    [Fact]
    public async Task An_admin_cannot_deactivate_themselves()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var adminId = await MyIdAsync(admin);

        var deactivate = await admin.PostAsync($"/api/admin/users/{adminId}/deactivate", null);

        await deactivate.AssertProblemAsync(HttpStatusCode.Conflict, "cannot_deactivate_self");
    }

    [Fact]
    public async Task The_last_active_admin_cannot_be_deactivated_by_another_admin_who_is_inactive_or_demoted()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var adminId = await MyIdAsync(admin);
        var (bruno, temporary) = await CreateUserAsync(admin, "bruno", isAdmin: true);
        using var brunoBrowser = await _factory.CreateReadyUserAsync("bruno", temporary, UserPassword);

        // Bruno deactivates the original admin: allowed, Bruno remains an active admin.
        Assert.Equal(HttpStatusCode.NoContent, (await brunoBrowser.PostAsync($"/api/admin/users/{adminId}/deactivate", null)).StatusCode);

        // Now Bruno is the last active admin and cannot demote himself.
        var demote = await PatchUserAsync(brunoBrowser, bruno, new { isAdmin = false }, expectSuccess: false);
        await demote.AssertProblemAsync(HttpStatusCode.Conflict, "last_admin");
    }

    [Fact]
    public async Task Two_admins_demoting_each_other_concurrently_leave_one_admin()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var adminId = await MyIdAsync(admin);
        var (bruno, temporary) = await CreateUserAsync(admin, "bruno", isAdmin: true);
        using var brunoBrowser = await _factory.CreateReadyUserAsync("bruno", temporary, UserPassword);

        // Read both versions first: once one demotion commits, the demoted admin can no longer read users.
        var brunoVersion = (await admin.GetAsync($"/api/admin/users/{bruno}")).Headers.ETag!.Tag;
        var adminVersion = (await admin.GetAsync($"/api/admin/users/{adminId}")).Headers.ETag!.Tag;

        var results = await Task.WhenAll(
            SendPatchAsync(admin, $"/api/admin/users/{bruno}", new { isAdmin = false }, brunoVersion),
            SendPatchAsync(brunoBrowser, $"/api/admin/users/{adminId}", new { isAdmin = false }, adminVersion));

        // Whichever loses is refused (409 last_admin, or 403 if its admin flag was already revoked); never zero admins.
        Assert.Equal(1, await _factory.CountAsync("SELECT count(*) FROM chain.users WHERE is_admin AND is_active"));
        Assert.Single(results, r => r.StatusCode == HttpStatusCode.OK);
        Assert.Contains(results.Single(r => r.StatusCode != HttpStatusCode.OK).StatusCode, new[] { HttpStatusCode.Conflict, HttpStatusCode.Forbidden });
    }

    // 7. Versions

    [Fact]
    public async Task Patch_requires_the_current_version()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var (ana, _) = await CreateUserAsync(admin, "ana.souza");
        var get = await admin.GetAsync($"/api/admin/users/{ana}");
        var etag = get.Headers.ETag!.Tag;

        using var noVersion = new HttpRequestMessage(HttpMethod.Patch, $"/api/admin/users/{ana}") { Content = JsonContent.Create(new { displayName = "Ana S." }) };
        await (await admin.SendAsync(noVersion)).AssertProblemAsync(HttpStatusCode.PreconditionRequired, "precondition_required");

        var updated = await SendPatchAsync(admin, $"/api/admin/users/{ana}", new { displayName = "Ana S." }, etag);
        Assert.Equal(HttpStatusCode.OK, updated.StatusCode);
        Assert.NotEqual(etag, updated.Headers.ETag!.Tag);
        Assert.Equal("Ana S.", (await updated.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("displayName").GetString());

        var stale = await SendPatchAsync(admin, $"/api/admin/users/{ana}", new { displayName = "Ana Souza" }, etag);
        await stale.AssertProblemAsync(HttpStatusCode.PreconditionFailed, "version_mismatch");
    }

    [Fact]
    public async Task Group_patch_uses_versions_too()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var group = await CreateGroupAsync(admin, "Comitê");
        var etag = (await admin.GetAsync($"/api/admin/groups/{group}")).Headers.ETag!.Tag;

        var renamed = await SendPatchAsync(admin, $"/api/admin/groups/{group}", new { name = "Comitê de Crédito", description = "Aprova operações" }, etag);
        var stale = await SendPatchAsync(admin, $"/api/admin/groups/{group}", new { name = "Outro" }, etag);

        Assert.Equal(HttpStatusCode.OK, renamed.StatusCode);
        var body = await renamed.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("Comitê de Crédito", body.GetProperty("name").GetString());
        Assert.Equal("Aprova operações", body.GetProperty("description").GetString());
        await stale.AssertProblemAsync(HttpStatusCode.PreconditionFailed, "version_mismatch");
    }

    // 8. Membership

    [Fact]
    public async Task Membership_changes_are_idempotent_and_listed_in_me()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var (ana, temporary) = await CreateUserAsync(admin, "ana.souza");
        var group = await CreateGroupAsync(admin, "Análise de Crédito");

        Assert.Equal(HttpStatusCode.NoContent, (await admin.PutAsync($"/api/admin/groups/{group}/members/{ana}", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await admin.PutAsync($"/api/admin/groups/{group}/members/{ana}", null)).StatusCode);

        var details = await admin.GetFromJsonAsync<JsonElement>($"/api/admin/groups/{group}");
        Assert.Equal("ana.souza", Assert.Single(details.GetProperty("members").EnumerateArray()).GetProperty("username").GetString());

        using var anaBrowser = await _factory.CreateReadyUserAsync("ana.souza", temporary, UserPassword);
        var me = await anaBrowser.GetFromJsonAsync<JsonElement>("/api/auth/me");
        Assert.Equal("Análise de Crédito", Assert.Single(me.GetProperty("groups").EnumerateArray()).GetProperty("name").GetString());

        Assert.Equal(HttpStatusCode.NoContent, (await admin.DeleteAsync($"/api/admin/groups/{group}/members/{ana}")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await admin.DeleteAsync($"/api/admin/groups/{group}/members/{ana}")).StatusCode);
        Assert.Empty((await anaBrowser.GetFromJsonAsync<JsonElement>("/api/auth/me")).GetProperty("groups").EnumerateArray());
    }

    [Fact]
    public async Task Archived_groups_reject_new_members_and_are_hidden_by_default()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var (ana, _) = await CreateUserAsync(admin, "ana.souza");
        var group = await CreateGroupAsync(admin, "Antigo");

        Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsync($"/api/admin/groups/{group}/archive", null)).StatusCode);

        await (await admin.PutAsync($"/api/admin/groups/{group}/members/{ana}", null)).AssertProblemAsync(HttpStatusCode.Conflict, "group_archived");
        Assert.Empty((await admin.GetFromJsonAsync<JsonElement>("/api/admin/groups")).EnumerateArray());
        Assert.Single((await admin.GetFromJsonAsync<JsonElement>("/api/admin/groups?includeArchived=true")).EnumerateArray());

        Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsync($"/api/admin/groups/{group}/unarchive", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await admin.PutAsync($"/api/admin/groups/{group}/members/{ana}", null)).StatusCode);
    }

    [Fact]
    public async Task Group_views_say_whether_the_group_holds_Modeler_even_while_archived()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var modelers = await CreateGroupAsync(admin, "Modeladores");
        var others = await CreateGroupAsync(admin, "Cadastro");

        // As the list and the group's own view say it (admin-ui.md §8, S-A1).
        async Task<(bool Listed, bool Viewed)> IsModelerAsync(Guid group)
        {
            var listed = (await admin.GetFromJsonAsync<JsonElement>("/api/admin/groups?includeArchived=true")).EnumerateArray()
                .Single(summary => summary.GetProperty("id").GetGuid() == group);
            var viewed = await admin.GetFromJsonAsync<JsonElement>($"/api/admin/groups/{group}");
            return (listed.GetProperty("isModeler").GetBoolean(), viewed.GetProperty("isModeler").GetBoolean());
        }

        Assert.Equal((false, false), await IsModelerAsync(modelers));
        Assert.Equal(HttpStatusCode.NoContent, (await admin.PutAsync($"/api/admin/groups/{modelers}/modeler", null)).StatusCode);
        Assert.Equal((true, true), await IsModelerAsync(modelers));
        Assert.Equal((false, false), await IsModelerAsync(others));

        Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsync($"/api/admin/groups/{modelers}/archive", null)).StatusCode);
        Assert.Equal((true, true), await IsModelerAsync(modelers)); // suspended while archived, but still held

        Assert.Equal(HttpStatusCode.NoContent, (await admin.DeleteAsync($"/api/admin/groups/{modelers}/modeler")).StatusCode);
        Assert.Equal((false, false), await IsModelerAsync(modelers));
    }

    // 9. Audit

    [Fact]
    public async Task Admin_changes_are_audited_with_the_actor_and_without_temporary_passwords()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var adminId = await MyIdAsync(admin);
        var (ana, temporary) = await CreateUserAsync(admin, "ana.souza");
        var reset = await admin.PostAsync($"/api/admin/users/{ana}/reset-password", null);
        var resetTemporary = (await reset.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("temporaryPassword").GetString()!;
        var group = await CreateGroupAsync(admin, "Comitê");
        await admin.PutAsync($"/api/admin/groups/{group}/members/{ana}", null);

        var actions = await _factory.QueryAsync($"SELECT action FROM chain.audit_events WHERE actor_id = '{adminId}' AND action LIKE 'admin.%'");
        Assert.Equal(
            ["admin.group.created", "admin.group.member_added", "admin.user.created", "admin.user.password_reset"],
            actions.Order(StringComparer.Ordinal));

        var details = string.Join('\n', await _factory.QueryAsync("SELECT details::text FROM chain.audit_events"));
        Assert.DoesNotContain(temporary, details, StringComparison.Ordinal);
        Assert.DoesNotContain(resetTemporary, details, StringComparison.Ordinal);
    }

    // Helpers

    private static async Task<(Guid Id, string TemporaryPassword)> CreateUserAsync(
        HttpClient admin, string username, string displayName = "Pessoa", bool isAdmin = false)
    {
        var response = await admin.PostAsJsonAsync("/api/admin/users", new { username, displayName, isAdmin });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        return (body.GetProperty("user").GetProperty("id").GetGuid(), body.GetProperty("temporaryPassword").GetString()!);
    }

    private static async Task<Guid> CreateGroupAsync(HttpClient admin, string name)
    {
        var response = await admin.PostAsJsonAsync("/api/admin/groups", new { name });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    private static async Task<Guid> MyIdAsync(HttpClient client) =>
        (await client.GetFromJsonAsync<JsonElement>("/api/auth/me")).GetProperty("id").GetGuid();

    private static async Task<HttpResponseMessage> PatchUserAsync(HttpClient admin, Guid id, object body, bool expectSuccess = true)
    {
        var etag = (await admin.GetAsync($"/api/admin/users/{id}")).Headers.ETag!.Tag;
        var response = await SendPatchAsync(admin, $"/api/admin/users/{id}", body, etag);
        if (expectSuccess)
        {
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        }

        return response;
    }

    private static async Task<HttpResponseMessage> SendPatchAsync(HttpClient client, string path, object body, string etag)
    {
        using var request = new HttpRequestMessage(HttpMethod.Patch, path) { Content = JsonContent.Create(body) };
        request.Headers.TryAddWithoutValidation("If-Match", etag);
        return await client.SendAsync(request);
    }

    private async Task LockOutAsync(string username)
    {
        using var attacker = _factory.CreateBrowser();
        for (var i = 0; i < 5; i++)
        {
            await attacker.LoginAsync(username, "wrong-password-123");
        }

        Assert.Equal(1, await _factory.CountAsync($"SELECT count(*) FROM chain.users WHERE username = '{username}' AND locked_until IS NOT NULL"));
    }
}
