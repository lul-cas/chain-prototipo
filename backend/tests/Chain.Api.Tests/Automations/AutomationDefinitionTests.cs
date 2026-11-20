using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Chain.Api.Tests.Infrastructure;

namespace Chain.Api.Tests.Automations;

/// <summary>
/// Automation definitions through the API (automation.md §5.1–§5.4): drafts, validation, publishing, versions and restore, and
/// the in-use checks that published versions enable for destinations and secrets (§3.2, §4.2).
/// </summary>
[Collection(PostgresTestGroup.Name)]
public sealed class AutomationDefinitionTests(PostgresFixture postgres) : IAsyncLifetime, IDisposable
{
    private const string Automations = "/api/automations";
    private const string Destinations = "/api/admin/automation/destinations";
    private const string Secrets = "/api/admin/automation/secrets";
    private static readonly string[] Erp = ["erp"];
    private static readonly string[] Crm = ["crm"];
    private static readonly string[] ErpAndCrm = ["erp", "crm"];

    private readonly ChainApiFactory _factory = new(postgres.ConnectionString);
    private HttpClient _admin = null!;

    public async Task InitializeAsync()
    {
        await _factory.ResetDatabaseAsync();
        _admin = await _factory.CreateReadyAdminAsync();
        Assert.Equal(HttpStatusCode.Created, (await _admin.PostAsJsonAsync(Destinations, new { name = "erp", host = "api.erp.example", pathPrefix = "/v1" })).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await _admin.PostAsJsonAsync(Secrets, new { name = "erp_api_key", value = "s3cret-value", allowedDestinations = Erp })).StatusCode);
    }

    public Task DisposeAsync() => Task.CompletedTask;

    public void Dispose()
    {
        _admin?.Dispose();
        _factory.Dispose();
    }

    private static JsonObject Consulta(string destination = "erp", int? timeoutSeconds = null)
    {
        var document = JsonNode.Parse("""
            {
              "schemaVersion": 1,
              "kind": "http",
              "inputs": [{ "key": "cpf", "type": "text", "required": true }],
              "request": {
                "method": "GET",
                "destination": "erp",
                "path": "/v1/clientes/{cpf}",
                "headers": { "X-Api-Key": "{{secret:erp_api_key}}" }
              },
              "response": { "type": "json" },
              "outputs": [{ "key": "situacao", "type": "text", "required": true, "source": "body", "path": ["situacao"] }]
            }
            """)!.AsObject();
        document["request"]!["destination"] = destination;
        if (timeoutSeconds is { } timeout)
        {
            document["execution"] = new JsonObject { ["timeoutSeconds"] = timeout };
        }

        return document;
    }

    private async Task<Guid> CreateAsync(string name, HttpClient? client = null)
    {
        var response = await (client ?? _admin).PostAsJsonAsync(Automations, new { name, description = "Consulta o CPF no ERP" });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    private async Task<string> ETagAsync(Guid id, HttpClient? client = null) => (await (client ?? _admin).GetAsync($"{Automations}/{id}")).Headers.ETag!.Tag;

    private async Task<HttpResponseMessage> SaveDraftAsync(Guid id, JsonNode document, HttpClient? client = null) =>
        await SendAsync(client ?? _admin, HttpMethod.Put, $"{Automations}/{id}/draft", new { document }, await ETagAsync(id, client));

    private async Task<HttpResponseMessage> PublishAsync(Guid id, HttpClient? client = null) =>
        await SendAsync(client ?? _admin, HttpMethod.Post, $"{Automations}/{id}/publish", null, await ETagAsync(id, client));

    private static async Task<HttpResponseMessage> SendAsync(HttpClient client, HttpMethod method, string path, object? body, string? etag)
    {
        using var request = new HttpRequestMessage(method, path) { Content = body is null ? null : JsonContent.Create(body) };
        if (etag is not null)
        {
            request.Headers.TryAddWithoutValidation("If-Match", etag);
        }

        return await client.SendAsync(request);
    }

    private static async Task<List<(string Code, string? Path)>> IssuesAsync(HttpResponseMessage response) =>
        [.. (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("errors").EnumerateArray()
            .Select(e => (e.GetProperty("code").GetString()!, e.TryGetProperty("path", out var path) ? path.GetString() : null))];

    /// <summary>What a 409 says still uses a destination or secret, as "secrets: a,b; automations: c".</summary>
    private static async Task<string> UsageAsync(HttpResponseMessage response)
    {
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        string Names(string list) => problem.TryGetProperty(list, out var names) ? string.Join(',', names.EnumerateArray().Select(n => n.GetString())) : "-";
        return $"secrets: {Names("secrets")}; automations: {Names("automations")}";
    }

    /// <summary>Replaces a destination's settings with its current <c>ETag</c>, forced when <paramref name="force"/> is set.</summary>
    private async Task<HttpResponseMessage> PutDestinationAsync(string name, object settings, bool force = false) =>
        await SendAsync(_admin, HttpMethod.Put, $"{Destinations}/{name}{(force ? "?force=true" : string.Empty)}", settings,
            (await _admin.GetAsync($"{Destinations}/{name}")).Headers.ETag!.Tag);

    /// <summary>Changes a secret's metadata with its current <c>ETag</c>, forced when <paramref name="force"/> is set.</summary>
    private async Task<HttpResponseMessage> PatchSecretAsync(string name, object changes, bool force = false) =>
        await SendAsync(_admin, HttpMethod.Patch, $"{Secrets}/{name}{(force ? "?force=true" : string.Empty)}", changes,
            (await _admin.GetAsync($"{Secrets}/{name}")).Headers.ETag!.Tag);

    /// <summary>
    /// Asserts a refused change of a destination (409 <c>destination_in_use</c>) or of a secret (<c>secret_in_use</c>) and says what
    /// it would break, as "automations: a; versions: a v1 AU105 request.path".
    /// </summary>
    private static async Task<string> RefusedChangeAsync(HttpResponseMessage response, string code = "destination_in_use")
    {
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(code, problem.GetProperty("code").GetString());
        var automations = string.Join(',', problem.GetProperty("automations").EnumerateArray().Select(name => name.GetString()));
        var versions = string.Join(", ", problem.GetProperty("versions").EnumerateArray().Select(version =>
            $"{version.GetProperty("automation").GetString()} v{version.GetProperty("version").GetInt32()} "
            + string.Join(' ', version.GetProperty("errors").EnumerateArray().Select(e => $"{e.GetProperty("code").GetString()} {e.GetProperty("path").GetString()}"))));
        return $"automations: {automations}; versions: {versions}";
    }

    private async Task<HttpClient> UserAsync(string username, bool modeler)
    {
        var created = await (await _admin.PostAsJsonAsync("/api/admin/users", new { username, displayName = username, isAdmin = false })).Content.ReadFromJsonAsync<JsonElement>();
        if (modeler)
        {
            var group = (await (await _admin.PostAsJsonAsync("/api/admin/groups", new { name = $"Modeladores {username}" })).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
            Assert.Equal(HttpStatusCode.NoContent, (await _admin.PutAsync($"/api/admin/groups/{group}/modeler", null)).StatusCode);
            Assert.Equal(HttpStatusCode.NoContent, (await _admin.PutAsync($"/api/admin/groups/{group}/members/{created.GetProperty("user").GetProperty("id").GetGuid()}", null)).StatusCode);
        }

        return await _factory.CreateReadyUserAsync(username, created.GetProperty("temporaryPassword").GetString()!, "a-long-enough-password");
    }

    // Lifecycle (§5.1)

    [Fact]
    public async Task Automations_are_drafted_validated_and_published_as_immutable_versions()
    {
        var created = await _admin.PostAsJsonAsync(Automations, new { name = "Consultar CPF" });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var body = await created.Content.ReadFromJsonAsync<JsonElement>();
        var id = body.GetProperty("id").GetGuid();
        Assert.Equal($"/api/automations/{id}", created.Headers.Location!.ToString());
        Assert.NotNull(created.Headers.ETag);
        Assert.Equal("", body.GetProperty("draft").GetProperty("request").GetProperty("destination").GetString());

        var empty = await (await _admin.PostAsync($"{Automations}/{id}/validate", null)).Content.ReadFromJsonAsync<JsonElement>();
        Assert.False(empty.GetProperty("valid").GetBoolean());
        Assert.Equal(["AU101"], empty.GetProperty("errors").EnumerateArray().Select(e => e.GetProperty("code").GetString()));

        Assert.Equal(HttpStatusCode.OK, (await SaveDraftAsync(id, Consulta())).StatusCode);
        Assert.True((await (await _admin.PostAsync($"{Automations}/{id}/validate", null)).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("valid").GetBoolean());

        var first = await PublishAsync(id);
        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        Assert.Equal($"/api/automations/{id}/versions/1", first.Headers.Location!.ToString());
        var outcome = await first.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(1, outcome.GetProperty("versionNumber").GetInt32());
        Assert.StartsWith("sha256:", outcome.GetProperty("contentHash").GetString(), StringComparison.Ordinal);

        Assert.Equal(HttpStatusCode.OK, (await PublishAsync(id)).StatusCode);
        var withExplicitDefaults = Consulta(timeoutSeconds: 30);
        withExplicitDefaults["request"]!["auth"] = null;
        await SaveDraftAsync(id, withExplicitDefaults);
        Assert.Equal(HttpStatusCode.OK, (await PublishAsync(id)).StatusCode); // the same automation, written out in full

        await SaveDraftAsync(id, Consulta(timeoutSeconds: 10));
        Assert.Equal(2, (await (await PublishAsync(id)).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("versionNumber").GetInt32());

        var v1 = (await _admin.GetFromJsonAsync<JsonElement>($"{Automations}/{id}/versions/1")).GetProperty("document");
        Assert.Equal(30, v1.GetProperty("execution").GetProperty("timeoutSeconds").GetInt32());
        Assert.Equal("Idempotency-Key", v1.GetProperty("execution").GetProperty("idempotency").GetProperty("header").GetString());
        Assert.Equal(JsonValueKind.Null, v1.GetProperty("request").GetProperty("auth").ValueKind);
        var versions = await _admin.GetFromJsonAsync<JsonElement>($"{Automations}/{id}/versions");
        Assert.Equal([1, 2], versions.EnumerateArray().Select(v => v.GetProperty("versionNumber").GetInt32()));
        var summary = (await _admin.GetFromJsonAsync<JsonElement>(Automations))[0];
        Assert.Equal(("Consultar CPF", 2), (summary.GetProperty("name").GetString(), summary.GetProperty("latestVersion").GetInt32()));

        Assert.Equal(["1|erp|{erp_api_key}", "2|erp|{erp_api_key}"], await _factory.QueryAsync(
            "SELECT version_number || '|' || destination || '|' || secrets::text FROM chain.automation_versions ORDER BY version_number"));
        var update = await Assert.ThrowsAnyAsync<Exception>(() => _factory.QueryAsync("UPDATE chain.automation_versions SET content_hash = 'x' RETURNING id"));
        Assert.Contains("append-only", update.Message, StringComparison.Ordinal);
        var delete = await Assert.ThrowsAnyAsync<Exception>(() => _factory.QueryAsync("DELETE FROM chain.automation_versions RETURNING id"));
        Assert.Contains("append-only", delete.Message, StringComparison.Ordinal);

        Assert.Equal( // the test clock stands still, so the events are counted rather than ordered; unchanged publishes are not audited
            ["automation.created|1", "automation.draft_saved|3", "automation.published|2"],
            await _factory.QueryAsync("SELECT action || '|' || count(*) FROM chain.audit_events WHERE action LIKE 'automation.%' GROUP BY action ORDER BY action"));
    }

    [Fact]
    public async Task Malformed_drafts_are_rejected_and_invalid_automations_cannot_be_published()
    {
        var id = await CreateAsync("Inválida");
        var malformed = Consulta();
        malformed["request"]!["verb"] = "GET";
        var refused = await SaveDraftAsync(id, malformed);
        await refused.AssertProblemAsync(HttpStatusCode.BadRequest, "invalid_document");

        var invalid = Consulta();
        invalid["request"]!["method"] = "HEAD";
        invalid["request"]!["headers"]!["X-Other"] = "{{secret:nao_existe}}";
        Assert.Equal(HttpStatusCode.OK, (await SaveDraftAsync(id, invalid)).StatusCode); // saving only checks that it parses (AU000)

        var publish = await PublishAsync(id);
        await publish.AssertProblemAsync(HttpStatusCode.UnprocessableEntity, "automation_validation_failed");
        var issues = await IssuesAsync(await PublishAsync(id));
        Assert.Contains(("AU003", "request.method"), issues);
        Assert.Contains(("AU102", "request"), issues);
        Assert.Equal(["AU000"], (await IssuesAsync(await SaveDraftAsync(id, malformed))).Select(i => i.Code));
        await (await SendAsync(_admin, HttpMethod.Put, $"{Automations}/{id}/draft", new { }, await ETagAsync(id))).AssertProblemAsync(HttpStatusCode.BadRequest, "invalid_document");
        await (await SendAsync(_admin, HttpMethod.Put, $"{Automations}/{id}/draft", new { document = (object?)null }, await ETagAsync(id))).AssertProblemAsync(HttpStatusCode.BadRequest, "invalid_document");
        await (await SaveDraftAsync(id, JsonNode.Parse("""{"schemaVersion":1,"kind":"http","request":{"method":"GET","destination":"erp","path":"/","headers":{"X":"a\u0000b"}},"response":{"type":"none"}}""")!))
            .AssertProblemAsync(HttpStatusCode.BadRequest, "invalid_document");
        Assert.Empty(await _factory.QueryAsync("SELECT id FROM chain.automation_versions"));
    }

    // Regression #129: PostgreSQL cannot store the NUL character in text, nor an unpaired surrogate in jsonb, so these were 500s.
    // A serializer writes a lone surrogate as U+FFFD, so the escape is sent as JSON text written by hand.

    [Fact]
    public async Task A_name_or_description_with_the_NUL_character_is_invalid()
    {
        var id = await CreateAsync("Consultar CPF");

        await (await _admin.PostAsJsonAsync(Automations, new { name = "Consultar\u0000" })).AssertValidationFailedAsync("invalid_name");
        await (await _admin.PostAsJsonAsync(Automations, new { name = "Consultar CNPJ", description = "ERP\u0000" })).AssertValidationFailedAsync("invalid_description");
        await (await SendAsync(_admin, HttpMethod.Patch, $"{Automations}/{id}", new { name = "Consultar\u0000" }, await ETagAsync(id))).AssertValidationFailedAsync("invalid_name");
        await (await SendAsync(_admin, HttpMethod.Patch, $"{Automations}/{id}", new { description = "\u0000" }, await ETagAsync(id))).AssertValidationFailedAsync("invalid_description");

        Assert.Equal(["Consultar CPF"], await _factory.QueryAsync("SELECT name FROM chain.automation_definitions"));
    }

    [Fact]
    public async Task A_draft_with_an_unpaired_surrogate_is_an_invalid_document()
    {
        var id = await CreateAsync("Com surrogate");
        var document = Consulta();
        document["outputs"]![0]!["path"] = new JsonArray("UNPAIRED");
        using var request = new HttpRequestMessage(HttpMethod.Put, $"{Automations}/{id}/draft")
        {
            Content = ApiTestSession.RawJson(new JsonObject { ["document"] = document }.ToJsonString().Replace("UNPAIRED", "\\ud800", StringComparison.Ordinal)),
        };
        request.Headers.TryAddWithoutValidation("If-Match", await ETagAsync(id));

        var response = await _admin.SendAsync(request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("invalid_document", problem.GetProperty("code").GetString());
        Assert.Equal("AU000", Assert.Single(problem.GetProperty("errors").EnumerateArray()).GetProperty("code").GetString());
        Assert.Equal(string.Empty, (await _admin.GetFromJsonAsync<JsonElement>($"{Automations}/{id}")).GetProperty("draft").GetProperty("request").GetProperty("destination").GetString());
    }

    // Regression #153: bytes that are not UTF-8 reached GetRawText, which threw: a 500. Such a body is not JSON (identity.md I1).

    [Fact]
    public async Task A_draft_whose_bytes_are_not_UTF8_is_malformed_json()
    {
        var id = await CreateAsync("Com bytes");
        var document = Consulta();
        document["outputs"]![0]!["path"] = new JsonArray("NOT_UTF8");
        using var request = new HttpRequestMessage(HttpMethod.Put, $"{Automations}/{id}/draft")
        {
            Content = ApiTestSession.NotUtf8Json(new JsonObject { ["document"] = document }.ToJsonString()),
        };
        request.Headers.TryAddWithoutValidation("If-Match", await ETagAsync(id));

        var response = await _admin.SendAsync(request);

        await response.AssertMalformedJsonAsync(_admin, HttpMethod.Put, $"{Automations}/{id}/draft");
        Assert.Equal(string.Empty, (await _admin.GetFromJsonAsync<JsonElement>($"{Automations}/{id}")).GetProperty("draft").GetProperty("request").GetProperty("destination").GetString());
    }

    [Fact]
    public async Task Restore_copies_a_version_into_the_draft()
    {
        var id = await CreateAsync("Restaurável");
        await SaveDraftAsync(id, Consulta(timeoutSeconds: 12));
        await PublishAsync(id);
        await SaveDraftAsync(id, Consulta(timeoutSeconds: 45));

        var restore = await SendAsync(_admin, HttpMethod.Post, $"{Automations}/{id}/versions/1/restore", null, await ETagAsync(id));

        Assert.Equal(HttpStatusCode.OK, restore.StatusCode);
        var draft = (await _admin.GetFromJsonAsync<JsonElement>($"{Automations}/{id}")).GetProperty("draft");
        Assert.Equal(12, draft.GetProperty("execution").GetProperty("timeoutSeconds").GetInt32());
        Assert.Equal(HttpStatusCode.OK, (await PublishAsync(id)).StatusCode); // unchanged since version 1
        await (await SendAsync(_admin, HttpMethod.Post, $"{Automations}/{id}/versions/9/restore", null, await ETagAsync(id)))
            .AssertProblemAsync(HttpStatusCode.NotFound, "not_found");
        Assert.Contains("automation.restored", await _factory.QueryAsync("SELECT action FROM chain.audit_events"));
    }

    [Fact]
    public async Task Names_are_unique_ignoring_case_and_changes_need_the_current_version()
    {
        var id = await CreateAsync("Consultar CPF");
        await CreateAsync("Consultar CNPJ");
        await (await _admin.PostAsJsonAsync(Automations, new { name = "CONSULTAR CPF" })).AssertProblemAsync(HttpStatusCode.Conflict, "automation_name_taken");
        await (await _admin.PostAsJsonAsync(Automations, new { name = "  " })).AssertProblemAsync(HttpStatusCode.BadRequest, "validation_failed");
        await (await _admin.PostAsJsonAsync(Automations, new { name = "x", description = new string('d', 501) })).AssertProblemAsync(HttpStatusCode.BadRequest, "validation_failed");

        await (await SendAsync(_admin, HttpMethod.Patch, $"{Automations}/{id}", new { name = "consultar cnpj" }, await ETagAsync(id)))
            .AssertProblemAsync(HttpStatusCode.Conflict, "automation_name_taken");
        await (await SendAsync(_admin, HttpMethod.Put, $"{Automations}/{id}/draft", new { document = Consulta() }, etag: null))
            .AssertProblemAsync(HttpStatusCode.PreconditionRequired, "precondition_required");
        var stale = await ETagAsync(id);
        var renamed = await SendAsync(_admin, HttpMethod.Patch, $"{Automations}/{id}", new { name = "Consultar CPF no ERP" }, stale);
        Assert.Equal("Consultar CPF no ERP", (await renamed.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("name").GetString());
        await (await SendAsync(_admin, HttpMethod.Post, $"{Automations}/{id}/publish", null, stale)).AssertProblemAsync(HttpStatusCode.PreconditionFailed, "version_mismatch");
        await (await _admin.GetAsync($"{Automations}/{Guid.NewGuid()}")).AssertProblemAsync(HttpStatusCode.NotFound, "not_found");
    }

    [Fact]
    public async Task Modelers_and_admins_author_automations_and_others_cannot()
    {
        using var user = await UserAsync("lucas", modeler: false);
        using var modeler = await UserAsync("marta", modeler: true);

        await (await user.GetAsync(Automations)).AssertProblemAsync(HttpStatusCode.Forbidden, "forbidden");
        await (await user.PostAsJsonAsync(Automations, new { name = "x" })).AssertProblemAsync(HttpStatusCode.Forbidden, "forbidden");

        var id = await CreateAsync("Consultar CPF", modeler);
        Assert.Equal(HttpStatusCode.OK, (await SaveDraftAsync(id, Consulta(), modeler)).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await PublishAsync(id, modeler)).StatusCode);
        await (await user.GetAsync($"{Automations}/{id}/versions/1")).AssertProblemAsync(HttpStatusCode.Forbidden, "forbidden");
    }

    // In use (§3.2, §4.2)

    [Fact]
    public async Task Destinations_and_secrets_that_published_versions_use_are_deleted_only_with_force()
    {
        var id = await CreateAsync("Consultar CPF");
        await SaveDraftAsync(id, Consulta());
        await PublishAsync(id);
        Assert.Equal(HttpStatusCode.Created, (await _admin.PostAsJsonAsync(Destinations, new { name = "crm", host = "crm.example.com" })).StatusCode);
        var draftOnly = await CreateAsync("Rascunho no CRM");
        await SaveDraftAsync(draftOnly, Consulta("crm")); // drafts do not count

        var secret = await _admin.DeleteAsync($"{Secrets}/erp_api_key");
        await secret.AssertProblemAsync(HttpStatusCode.Conflict, "secret_in_use");
        Assert.Equal("secrets: -; automations: Consultar CPF", await UsageAsync(await _admin.DeleteAsync($"{Secrets}/erp_api_key")));
        var destination = await _admin.DeleteAsync($"{Destinations}/erp");
        await destination.AssertProblemAsync(HttpStatusCode.Conflict, "destination_in_use");
        Assert.Equal("secrets: erp_api_key; automations: Consultar CPF", await UsageAsync(await _admin.DeleteAsync($"{Destinations}/erp")));
        Assert.Equal(HttpStatusCode.NoContent, (await _admin.DeleteAsync($"{Destinations}/crm")).StatusCode);

        Assert.Equal(HttpStatusCode.NoContent, (await _admin.DeleteAsync($"{Secrets}/erp_api_key?force=true")).StatusCode);
        Assert.Equal("secrets: ; automations: Consultar CPF", await UsageAsync(await _admin.DeleteAsync($"{Destinations}/erp"))); // the version alone keeps it in use
        Assert.Equal(HttpStatusCode.NoContent, (await _admin.DeleteAsync($"{Destinations}/erp?force=true")).StatusCode);
        Assert.Equal(["true|Consultar CPF"], await _factory.QueryAsync(
            "SELECT details::jsonb->>'forced' || '|' || (details::jsonb->>'automations') FROM chain.audit_events WHERE action = 'admin.secret.deleted'"));
        Assert.Equal(["true||Consultar CPF"], await _factory.QueryAsync(
            "SELECT details::jsonb->>'forced' || '|' || (details::jsonb->>'secrets') || '|' || (details::jsonb->>'automations') FROM chain.audit_events WHERE action = 'admin.automation_destination.deleted' AND details::jsonb->>'name' = 'erp'"));

        var issues = await IssuesAsync(await SendAsync(_admin, HttpMethod.Post, $"{Automations}/{id}/publish", null, await ETagAsync(id)));
        Assert.Contains(("AU101", "request.destination"), issues);
        Assert.Contains(("AU102", "request"), issues);
        Assert.Equal(1, (await _admin.GetFromJsonAsync<JsonElement>($"{Automations}/{id}/versions/1")).GetProperty("versionNumber").GetInt32());
    }

    // Regression #165: a destination change was not checked against the published versions that call it, so a new prefix, host or
    // scheme failed only when a step called it (destination_denied, secret_not_allowed). Such a change is now refused like a delete
    // in use, naming the versions it would break, unless forced (§3.2).

    [Fact]
    public async Task A_prefix_change_that_a_published_version_would_leave_is_refused_unless_forced()
    {
        var id = await CreateAsync("Consultar CPF");
        await SaveDraftAsync(id, Consulta()); // calls /v1/clientes/{cpf}, within "/v1"
        Assert.Equal(HttpStatusCode.Created, (await PublishAsync(id)).StatusCode);
        var narrower = new { host = "api.erp.example", pathPrefix = "/v2" };

        Assert.Equal("automations: Consultar CPF; versions: Consultar CPF v1 AU105 request.path", await RefusedChangeAsync(await PutDestinationAsync("erp", narrower)));
        Assert.Equal("/v1", (await _admin.GetFromJsonAsync<JsonElement>($"{Destinations}/erp")).GetProperty("pathPrefix").GetString());
        Assert.Empty(await _factory.QueryAsync("SELECT action FROM chain.audit_events WHERE action = 'admin.automation_destination.updated'"));

        var forced = await PutDestinationAsync("erp", narrower, force: true);
        Assert.Equal(HttpStatusCode.OK, forced.StatusCode);
        Assert.Equal("/v2", (await forced.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("pathPrefix").GetString());
        Assert.Equal(["true|Consultar CPF"], await _factory.QueryAsync(
            "SELECT details::jsonb->>'forced' || '|' || (details::jsonb->>'automations') FROM chain.audit_events WHERE action = 'admin.automation_destination.updated'"));

        // Version 1 already leaves "/v2", so a later change breaks nothing more and needs no force.
        Assert.Equal(HttpStatusCode.OK, (await PutDestinationAsync("erp", new { host = "api.erp.example", pathPrefix = "/v2", description = "ERP v2" })).StatusCode);
    }

    [Fact]
    public async Task A_host_or_scheme_change_that_would_break_a_published_version_is_refused()
    {
        // A wildcard destination, so the version names its host (AU106).
        Assert.Equal(HttpStatusCode.Created, (await _admin.PostAsJsonAsync(Destinations, new { name = "crm", host = "*.crm.example" })).StatusCode);
        var crm = Consulta("crm");
        crm["request"]!["host"] = "api.crm.example";
        crm["request"]!["path"] = "/clientes/{cpf}";
        crm["request"]!.AsObject().Remove("headers"); // the secret allows "erp" only
        var crmId = await CreateAsync("Consultar CRM");
        await SaveDraftAsync(crmId, crm);
        Assert.Equal(HttpStatusCode.Created, (await PublishAsync(crmId)).StatusCode);

        Assert.Equal("automations: Consultar CRM; versions: Consultar CRM v1 AU106 request.host",
            await RefusedChangeAsync(await PutDestinationAsync("crm", new { host = "*.other.example" })));
        Assert.Equal(HttpStatusCode.OK, (await PutDestinationAsync("crm", new { host = "api.crm.example" })).StatusCode); // its own host

        // The secret would travel over plain http without the admin's confirmation (AU104).
        var erpId = await CreateAsync("Consultar CPF");
        await SaveDraftAsync(erpId, Consulta());
        Assert.Equal(HttpStatusCode.Created, (await PublishAsync(erpId)).StatusCode);
        Assert.Equal("automations: Consultar CPF; versions: Consultar CPF v1 AU104 request.destination",
            await RefusedChangeAsync(await PutDestinationAsync("erp", new { host = "api.erp.example", pathPrefix = "/v1", scheme = "http", @internal = true })));
        Assert.Equal(HttpStatusCode.OK, (await PutDestinationAsync("erp", new { host = "api.erp.example", pathPrefix = "/v1", scheme = "http", @internal = true, allowSecretsOverHttp = true })).StatusCode);
    }

    [Fact]
    public async Task A_change_that_every_published_version_survives_is_allowed()
    {
        var id = await CreateAsync("Consultar CPF");
        await SaveDraftAsync(id, Consulta()); // names no host, so it follows the destination's
        Assert.Equal(HttpStatusCode.Created, (await PublishAsync(id)).StatusCode);
        var draftOnly = await CreateAsync("Rascunho");
        var outside = Consulta();
        outside["request"]!["path"] = "/v1/pedidos";
        await SaveDraftAsync(draftOnly, outside); // drafts do not count

        var changed = await PutDestinationAsync("erp", new { host = "api2.erp.example", port = 8443, pathPrefix = "/v1/clientes", description = "ERP novo", maxResponseBytes = 2048 });

        Assert.Equal(HttpStatusCode.OK, changed.StatusCode);
        Assert.Equal(["false|"], await _factory.QueryAsync(
            "SELECT details::jsonb->>'forced' || '|' || (details::jsonb->>'automations') FROM chain.audit_events WHERE action = 'admin.automation_destination.updated'"));
    }

    // Regression #206: a secret change was not checked against the published versions that use the secret, so removing a
    // destination a version calls failed only when a step called it (secret_not_allowed). Such a change is now refused like a
    // delete in use, naming the versions it would break, unless forced (§4.2), as #165 did for destinations.

    [Fact]
    public async Task Removing_a_destination_a_published_version_needs_from_a_secret_is_refused_unless_forced()
    {
        var id = await CreateAsync("Consultar CPF");
        await SaveDraftAsync(id, Consulta()); // sends erp_api_key to "erp"
        Assert.Equal(HttpStatusCode.Created, (await PublishAsync(id)).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await _admin.PostAsJsonAsync(Destinations, new { name = "crm", host = "api.crm.example" })).StatusCode);
        var withoutErp = new { allowedDestinations = Crm };

        Assert.Equal("automations: Consultar CPF; versions: Consultar CPF v1 AU103 request",
            await RefusedChangeAsync(await PatchSecretAsync("erp_api_key", withoutErp), "secret_in_use"));
        Assert.Equal(Erp, (await _admin.GetFromJsonAsync<JsonElement>($"{Secrets}/erp_api_key")).GetProperty("allowedDestinations").EnumerateArray().Select(d => d.GetString()));
        Assert.Empty(await _factory.QueryAsync("SELECT action FROM chain.audit_events WHERE action = 'admin.secret.updated'"));

        var forced = await PatchSecretAsync("erp_api_key", withoutErp, force: true);
        Assert.Equal(HttpStatusCode.OK, forced.StatusCode);
        Assert.Equal(["crm"], (await forced.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("allowedDestinations").EnumerateArray().Select(d => d.GetString()));
        Assert.Equal(["true|Consultar CPF"], await _factory.QueryAsync(
            "SELECT details::jsonb->>'forced' || '|' || (details::jsonb->>'automations') FROM chain.audit_events WHERE action = 'admin.secret.updated'"));

        // Version 1 already fails AU103 for this secret, so a later change breaks nothing more and needs no force.
        Assert.Equal(HttpStatusCode.OK, (await PatchSecretAsync("erp_api_key", new { allowedDestinations = Array.Empty<string>(), description = "Sem destinos" })).StatusCode);
    }

    [Fact]
    public async Task A_secret_change_that_every_published_version_survives_is_allowed()
    {
        var id = await CreateAsync("Consultar CPF");
        await SaveDraftAsync(id, Consulta());
        Assert.Equal(HttpStatusCode.Created, (await PublishAsync(id)).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await _admin.PostAsJsonAsync(Destinations, new { name = "crm", host = "api.crm.example" })).StatusCode);
        var draftOnly = await CreateAsync("Rascunho");
        await SaveDraftAsync(draftOnly, Consulta("crm")); // drafts do not count

        Assert.Equal(HttpStatusCode.OK, (await PatchSecretAsync("erp_api_key", new { allowedDestinations = ErpAndCrm, description = "ERP e CRM" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await PatchSecretAsync("erp_api_key", new { allowedDestinations = Erp })).StatusCode); // only a draft calls "crm"

        Assert.Equal(["false|", "false|"], await _factory.QueryAsync(
            "SELECT details::jsonb->>'forced' || '|' || (details::jsonb->>'automations') FROM chain.audit_events WHERE action = 'admin.secret.updated'"));
    }

    [Fact]
    public async Task An_unused_secret_is_deleted_without_force_and_the_audit_says_so()
    {
        Assert.Equal(HttpStatusCode.NoContent, (await _admin.DeleteAsync($"{Secrets}/erp_api_key")).StatusCode);
        Assert.Equal(["false|"], await _factory.QueryAsync(
            "SELECT details::jsonb->>'forced' || '|' || (details::jsonb->>'automations') FROM chain.audit_events WHERE action = 'admin.secret.deleted'"));
    }
}
