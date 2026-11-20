using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Chain.Api.Tests.Infrastructure;
using Chain.Automations;

namespace Chain.Api.Tests.Automations;

/// <summary>Destinations and secrets of automations (automation.md §3–§4; ADR-0012 Part 1), through the API.</summary>
[Collection(PostgresTestGroup.Name)]
public sealed class AutomationAdminTests(PostgresFixture postgres) : IAsyncLifetime, IDisposable
{
    private const string Destinations = "/api/admin/automation/destinations";
    private const string Secrets = "/api/admin/automation/secrets";
    private const string Canary = "canary-Sécret-value-7f3a";
    private static readonly string[] Erp = ["erp"];
    private static readonly string[] Missing = ["missing"];

    private readonly ChainApiFactory _factory = new(postgres.ConnectionString);
    private HttpClient _admin = null!;

    public async Task InitializeAsync()
    {
        await _factory.ResetDatabaseAsync();
        _admin = await _factory.CreateReadyAdminAsync();
    }

    public Task DisposeAsync() => Task.CompletedTask;

    public void Dispose()
    {
        _admin?.Dispose();
        _factory.Dispose();
    }

    private Task<HttpResponseMessage> CreateDestinationAsync(string name, string host = "api.example.com") =>
        _admin.PostAsJsonAsync(Destinations, new { name, host, description = "ERP" });

    private Task<HttpResponseMessage> CreateSecretAsync(string name, string value, params string[] allowedDestinations) =>
        _admin.PostAsJsonAsync(Secrets, new { name, value, allowedDestinations, description = "Chave do ERP" });

    private static async Task<HttpResponseMessage> SendAsync(HttpClient client, HttpMethod method, string path, object? body, string? etag)
    {
        using var request = new HttpRequestMessage(method, path) { Content = body is null ? null : JsonContent.Create(body) };
        if (etag is not null)
        {
            request.Headers.TryAddWithoutValidation("If-Match", etag);
        }

        return await client.SendAsync(request);
    }

    private static async Task<(string Code, string[] Errors)> ProblemAsync(HttpResponseMessage response)
    {
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        var errors = problem.TryGetProperty("errors", out var list) ? list.EnumerateArray().Select(e => e.GetString()!).ToArray() : [];
        return (problem.GetProperty("code").GetString()!, errors);
    }

    /// <summary>The stored envelope columns of a secret, decrypted with the test KEK (automation-contract.md §5).</summary>
    private async Task<string> DecryptStoredAsync(string name)
    {
        var row = (await _factory.QueryAsync(
            "SELECT replace(encode(nonce, 'base64'), E'\\n', '') || '|' || replace(encode(ciphertext, 'base64'), E'\\n', '') || '|' "
            + "|| replace(encode(wrapped_data_key, 'base64'), E'\\n', '') || '|' || key_id || '|' || version "
            + $"FROM chain.automation_secrets WHERE name = '{name}'")).Single().Split('|');
        var ring = KeyRing.Parse(ChainApiFactory.TestKeks, ChainApiFactory.TestKekId);
        var sealedSecret = new SealedSecret(Convert.FromBase64String(row[0]), Convert.FromBase64String(row[1]), Convert.FromBase64String(row[2]), row[3]);
        return SecretEnvelope.Open(ring, name, int.Parse(row[4], System.Globalization.CultureInfo.InvariantCulture), sealedSecret);
    }

    // Destinations (§3)

    [Fact]
    public async Task Admins_manage_destinations_with_versions_and_audit()
    {
        var created = await CreateDestinationAsync("erp");
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        Assert.Equal("/api/admin/automation/destinations/erp", created.Headers.Location!.ToString());
        var body = await created.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(("https", 1_048_576L, false), (body.GetProperty("scheme").GetString(), body.GetProperty("maxResponseBytes").GetInt64(), body.GetProperty("internal").GetBoolean()));

        var read = await _admin.GetAsync($"{Destinations}/erp");
        Assert.Equal(created.Headers.ETag!.Tag, read.Headers.ETag!.Tag);

        var update = new { host = "erp.internal", scheme = "http", @internal = true, port = 8080, pathPrefix = "/api" };
        await (await SendAsync(_admin, HttpMethod.Put, $"{Destinations}/erp", update, null)).AssertProblemAsync(HttpStatusCode.PreconditionRequired, "precondition_required");
        var updated = await SendAsync(_admin, HttpMethod.Put, $"{Destinations}/erp", update, read.Headers.ETag.Tag);
        Assert.Equal(HttpStatusCode.OK, updated.StatusCode);
        Assert.NotEqual(read.Headers.ETag.Tag, updated.Headers.ETag!.Tag);
        await (await SendAsync(_admin, HttpMethod.Put, $"{Destinations}/erp", update, read.Headers.ETag.Tag)).AssertProblemAsync(HttpStatusCode.PreconditionFailed, "version_mismatch");

        await (await CreateDestinationAsync("erp")).AssertProblemAsync(HttpStatusCode.Conflict, "destination_name_taken");
        Assert.Single((await _admin.GetFromJsonAsync<JsonElement>(Destinations)).EnumerateArray());

        Assert.Equal(HttpStatusCode.NoContent, (await _admin.DeleteAsync($"{Destinations}/erp")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _admin.GetAsync($"{Destinations}/erp")).StatusCode);
        Assert.Equal( // the test clock stands still, so the rows are compared as a set
            ["admin.automation_destination.created", "admin.automation_destination.deleted", "admin.automation_destination.updated"],
            await _factory.QueryAsync("SELECT action FROM chain.audit_events WHERE action LIKE 'admin.automation_destination.%' ORDER BY action"));
    }

    [Fact]
    public async Task An_invalid_destination_lists_every_broken_rule()
    {
        var response = await _admin.PostAsJsonAsync(Destinations, new { name = "ERP", host = "10.0.0.1", scheme = "http", port = 0, pathPrefix = "/a/../b" });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var (code, errors) = await ProblemAsync(response);
        Assert.Equal("validation_failed", code);
        Assert.Equal(["invalid_name", "http_requires_internal", "invalid_host", "invalid_port", "invalid_path_prefix"], errors);
    }

    [Fact]
    public async Task A_destination_that_secrets_allow_is_deleted_only_with_force()
    {
        await CreateDestinationAsync("erp");
        await CreateDestinationAsync("crm", "crm.example.com");
        await CreateSecretAsync("erp_key", Canary, "erp", "crm");

        var refused = await _admin.DeleteAsync($"{Destinations}/erp");
        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
        var problem = await refused.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("destination_in_use", problem.GetProperty("code").GetString());
        Assert.Equal(["erp_key"], problem.GetProperty("secrets").EnumerateArray().Select(s => s.GetString()));
        Assert.Empty(problem.GetProperty("automations").EnumerateArray());

        Assert.Equal(HttpStatusCode.NoContent, (await _admin.DeleteAsync($"{Destinations}/erp?force=true")).StatusCode);
        var secret = await _admin.GetFromJsonAsync<JsonElement>($"{Secrets}/erp_key");
        Assert.Equal(["crm"], secret.GetProperty("allowedDestinations").EnumerateArray().Select(d => d.GetString()));
        Assert.Equal(["true|erp_key"], await _factory.QueryAsync(
            "SELECT details::jsonb->>'forced' || '|' || (details::jsonb->>'secrets') FROM chain.audit_events WHERE action = 'admin.automation_destination.deleted'"));
    }

    // Secrets (§4)

    [Fact]
    public async Task Secrets_are_write_only_and_sealed_for_their_name_and_version()
    {
        await CreateDestinationAsync("erp");

        var created = await CreateSecretAsync("erp_key", Canary, "erp");
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var createdBody = await created.Content.ReadAsStringAsync();
        Assert.DoesNotContain(Canary, createdBody, StringComparison.Ordinal);
        var metadata = JsonDocument.Parse(createdBody).RootElement;
        Assert.Equal((1, ChainApiFactory.TestKekId), (metadata.GetProperty("version").GetInt32(), metadata.GetProperty("keyId").GetString()));
        Assert.False(metadata.TryGetProperty("value", out _));
        Assert.Equal(Canary, await DecryptStoredAsync("erp_key"));
        Assert.Equal(["0"], await _factory.QueryAsync($"SELECT count(*) FROM chain.automation_secrets WHERE position(convert_to('{Canary}', 'UTF8') in ciphertext) > 0"));

        var read = await _admin.GetAsync($"{Secrets}/erp_key");
        Assert.DoesNotContain(Canary, await read.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        Assert.Equal(created.Headers.ETag!.Tag, read.Headers.ETag!.Tag);

        var rotated = await SendAsync(_admin, HttpMethod.Put, $"{Secrets}/erp_key/value", new { value = "second-" + Canary }, read.Headers.ETag.Tag);
        Assert.Equal(HttpStatusCode.OK, rotated.StatusCode);
        Assert.Equal(2, (await rotated.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("version").GetInt32());
        Assert.Equal("second-" + Canary, await DecryptStoredAsync("erp_key"));

        Assert.Equal(HttpStatusCode.NoContent, (await _admin.DeleteAsync($"{Secrets}/erp_key")).StatusCode);
        Assert.Equal( // the test clock stands still, so the rows are compared as a set
            ["admin.secret.created|1", "admin.secret.deleted|2", "admin.secret.rotated|2"],
            await _factory.QueryAsync("SELECT action || '|' || (details::jsonb->>'version') FROM chain.audit_events WHERE action LIKE 'admin.secret.%' ORDER BY action"));
        Assert.Equal(["0"], await _factory.QueryAsync($"SELECT count(*) FROM chain.audit_events WHERE details::text LIKE '%{Canary}%' OR details::text LIKE '%second-%'"));
    }

    [Fact]
    public async Task Secret_rules_names_and_destinations_are_checked()
    {
        await CreateDestinationAsync("erp");

        var invalid = await _admin.PostAsJsonAsync(Secrets, new { name = "Bad Name", value = new string('a', 8193), allowedDestinations = Erp });
        var (invalidCode, invalidErrors) = await ProblemAsync(invalid);
        Assert.Equal("validation_failed", invalidCode);
        Assert.Equal(["invalid_name", "value_too_long"], invalidErrors);

        var unknown = await CreateSecretAsync("erp_key", Canary, "erp", "nowhere");
        Assert.Equal(HttpStatusCode.UnprocessableEntity, unknown.StatusCode);
        var (unknownCode, unknownNames) = await ProblemAsync(unknown);
        Assert.Equal("unknown_destination", unknownCode);
        Assert.Equal(["nowhere"], unknownNames);

        Assert.Equal(HttpStatusCode.Created, (await CreateSecretAsync("erp_key", Canary, "erp")).StatusCode);
        await (await CreateSecretAsync("erp_key", Canary)).AssertProblemAsync(HttpStatusCode.Conflict, "secret_name_taken");

        var etag = (await _admin.GetAsync($"{Secrets}/erp_key")).Headers.ETag!.Tag;
        var patched = await SendAsync(_admin, HttpMethod.Patch, $"{Secrets}/erp_key", new { allowedDestinations = Missing }, etag);
        var (patchCode, patchNames) = await ProblemAsync(patched);
        Assert.Equal("unknown_destination", patchCode);
        Assert.Equal(["missing"], patchNames);
        var cleared = await SendAsync(_admin, HttpMethod.Patch, $"{Secrets}/erp_key", new { description = "Sem destinos", allowedDestinations = Array.Empty<string>() }, etag);
        Assert.Equal(HttpStatusCode.OK, cleared.StatusCode);
        var body = await cleared.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(("Sem destinos", 0, 1), (body.GetProperty("description").GetString(), body.GetProperty("allowedDestinations").GetArrayLength(), body.GetProperty("version").GetInt32()));
    }

    // Regression #129: PostgreSQL text cannot store the NUL character, so a description with one was a 500.

    [Fact]
    public async Task A_description_with_the_NUL_character_is_invalid()
    {
        await CreateDestinationAsync("erp");
        await CreateSecretAsync("erp_key", Canary, "erp");
        var destination = (await _admin.GetAsync($"{Destinations}/erp")).Headers.ETag!.Tag;
        var secret = (await _admin.GetAsync($"{Secrets}/erp_key")).Headers.ETag!.Tag;

        await (await _admin.PostAsJsonAsync(Destinations, new { name = "crm", host = "crm.example.com", description = "CRM\u0000" })).AssertValidationFailedAsync("invalid_description");
        await (await SendAsync(_admin, HttpMethod.Put, $"{Destinations}/erp", new { host = "api.example.com", description = "\u0000" }, destination)).AssertValidationFailedAsync("invalid_description");
        await (await _admin.PostAsJsonAsync(Secrets, new { name = "crm_key", value = Canary, allowedDestinations = Erp, description = "Chave\u0000" })).AssertValidationFailedAsync("invalid_description");
        await (await SendAsync(_admin, HttpMethod.Patch, $"{Secrets}/erp_key", new { description = "\u0000" }, secret)).AssertValidationFailedAsync("invalid_description");

        Assert.Equal(["ERP"], await _factory.QueryAsync("SELECT description FROM chain.automation_destinations"));
        Assert.Equal(["Chave do ERP"], await _factory.QueryAsync("SELECT description FROM chain.automation_secrets"));
    }

    // Who may see what

    [Fact]
    public async Task Only_admins_manage_them_and_modelers_see_names_but_never_values()
    {
        await CreateDestinationAsync("erp");
        await CreateSecretAsync("erp_key", Canary, "erp");
        var modelers = (await (await _admin.PostAsJsonAsync("/api/admin/groups", new { name = "Modeladores" })).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.NoContent, (await _admin.PutAsync($"/api/admin/groups/{modelers}/modeler", null)).StatusCode);
        var modeler = await UserAsync("marta", modelers);
        var user = await UserAsync("lucas", null);

        Assert.Equal(HttpStatusCode.Forbidden, (await modeler.GetAsync(Secrets)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.PostAsJsonAsync(Destinations, new { name = "x", host = "x.example.com" })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.GetAsync("/api/automations/resources")).StatusCode);

        var resources = await modeler.GetAsync("/api/automations/resources");
        Assert.Equal(HttpStatusCode.OK, resources.StatusCode);
        var text = await resources.Content.ReadAsStringAsync();
        Assert.DoesNotContain(Canary, text, StringComparison.Ordinal);
        Assert.DoesNotContain("ciphertext", text, StringComparison.OrdinalIgnoreCase);
        var body = JsonDocument.Parse(text).RootElement;
        Assert.Equal("erp", body.GetProperty("destinations")[0].GetProperty("name").GetString());
        Assert.Equal(["erp"], body.GetProperty("secrets")[0].GetProperty("allowedDestinations").EnumerateArray().Select(d => d.GetString()));
    }

    private async Task<HttpClient> UserAsync(string username, Guid? group)
    {
        var created = await (await _admin.PostAsJsonAsync("/api/admin/users", new { username, displayName = username, isAdmin = false })).Content.ReadFromJsonAsync<JsonElement>();
        if (group is { } id)
        {
            await _admin.PutAsync($"/api/admin/groups/{id}/members/{created.GetProperty("user").GetProperty("id").GetGuid()}", null);
        }

        return await _factory.CreateReadyUserAsync(username, created.GetProperty("temporaryPassword").GetString()!, "a-long-enough-password");
    }

    // Key-encryption keys (§4.1)

    [Fact]
    public async Task Without_an_active_key_secrets_cannot_be_written_but_metadata_still_reads()
    {
        using var factory = new ChainApiFactory(postgres.ConnectionString, ChainApiFactory.TestKeks, activeKek: null);
        await factory.ResetDatabaseAsync();
        using var admin = await factory.CreateReadyAdminAsync();

        await (await admin.PostAsJsonAsync(Secrets, new { name = "erp_key", value = Canary, allowedDestinations = Array.Empty<string>() }))
            .AssertProblemAsync(HttpStatusCode.ServiceUnavailable, "secrets_unavailable");
        Assert.Equal(HttpStatusCode.OK, (await admin.GetAsync(Secrets)).StatusCode);
    }

    [Fact]
    public void A_malformed_key_configuration_stops_the_api()
    {
        using var factory = new ChainApiFactory(postgres.ConnectionString, "test:not-a-32-byte-key", "test");

        Assert.ThrowsAny<FormatException>(() => factory.CreateClient());
    }

    // Card #164: docker-compose.yml's development KEK and result token are published, so the API refuses them outside
    // Development, naming the setting and never the value (automation.md §4.1).

    private static readonly JsonElement DevelopmentValues =
        JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "contract", "development-values.json"))).RootElement;

    private static string DevelopmentKeks => DevelopmentValues.GetProperty("keks").GetString()!;

    private static string DevelopmentTokenHash => DevelopmentValues.GetProperty("resultTokenSha256").GetString()!;

    [Fact]
    public void The_development_key_stops_the_api_outside_development()
    {
        using var factory = new ChainApiFactory(postgres.ConnectionString, $"{ChainApiFactory.TestKeks},{DevelopmentKeks}", ChainApiFactory.TestKekId,
            environment: "Production");

        var error = Assert.Throws<InvalidOperationException>(() => factory.CreateClient());

        Assert.Contains("Chain:Automation:Keks", error.Message, StringComparison.Ordinal);
        Assert.Contains("'dev'", error.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(DevelopmentKeks.Split(':', 2)[1], error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void The_development_token_hash_stops_the_api_outside_development()
    {
        using var factory = new ChainApiFactory(postgres.ConnectionString, environment: "Production",
            settings: new Dictionary<string, string> { ["Chain:Automation:ResultTokenSha256"] = DevelopmentTokenHash });

        var error = Assert.Throws<InvalidOperationException>(() => factory.CreateClient());

        Assert.Contains("Chain:Automation:ResultTokenSha256", error.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(DevelopmentTokenHash, error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task The_development_values_are_accepted_in_development()
    {
        using var factory = new ChainApiFactory(postgres.ConnectionString, DevelopmentKeks, "dev",
            settings: new Dictionary<string, string> { ["Chain:Automation:ResultTokenSha256"] = DevelopmentTokenHash }, environment: "Development");
        using var client = factory.CreateClient();

        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/health/live")).StatusCode);
    }
}
