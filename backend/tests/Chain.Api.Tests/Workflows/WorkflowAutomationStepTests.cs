using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Chain.Api.Tests.Infrastructure;

namespace Chain.Api.Tests.Workflows;

/// <summary>
/// Automation steps in workflows (automation.md §5.5, workflow-definition.md §5.3): publishing pins the automation's latest version
/// (WF104) and re-checks it (WF107–WF110). Running them is EngineE4Tests'.
/// </summary>
[Collection(PostgresTestGroup.Name)]
public sealed class WorkflowAutomationStepTests(PostgresFixture postgres) : IAsyncLifetime, IDisposable
{
    private const string Destinations = "/api/admin/automation/destinations";
    private const string Secrets = "/api/admin/automation/secrets";
    private static readonly string[] Erp = ["erp"];

    private readonly ChainApiFactory _factory = new(postgres.ConnectionString);

    public async Task InitializeAsync() => await _factory.ResetDatabaseAsync();

    public Task DisposeAsync() => Task.CompletedTask;

    public void Dispose() => _factory.Dispose();

    // WF104 and pinning

    [Fact]
    public async Task An_automation_step_is_pinned_to_the_latest_published_version()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var automation = await PublishedAutomationAsync(admin, versions: 2);
        var inputs = new JsonObject { ["cpf"] = Path("cpf"), ["canal"] = Path("canal") }; // "canal" is declared from version 2 on
        var outputs = new JsonObject { ["situacao_cpf"] = Path("situacao"), ["codigo"] = Path("httpStatus") }; // "httpStatus" from version 2 on
        var workflow = await DraftAsync(admin, "Cadastro", StepDocument(automation, inputs, outputs));

        Assert.Equal(HttpStatusCode.Created, (await PublishWorkflowAsync(admin, workflow)).StatusCode);

        var version = await admin.GetFromJsonAsync<JsonElement>($"/api/workflows/{workflow}/versions/1");
        Assert.Equal(2, Step(version.GetProperty("document")).GetProperty("version").GetInt32());
        var draft = (await admin.GetFromJsonAsync<JsonElement>($"/api/workflows/{workflow}")).GetProperty("draft");
        Assert.False(Step(draft).TryGetProperty("version", out _));

        // Card #76: the catalog types each output key from the pinned version's output contract.
        var catalog = await admin.GetFromJsonAsync<JsonElement>($"/api/workflows/{workflow}/data-catalog");
        var atEnd = catalog.GetProperty("nodes").EnumerateArray().Single(n => n.GetProperty("nodeId").GetString() == "end_1").GetProperty("entries");
        Assert.Equal(["codigo|number|definite|cpf", "situacao_cpf|text|definite|cpf"], atEnd.EnumerateArray().Select(e => string.Join('|',
            e.GetProperty("path")[0].GetString(), e.GetProperty("type").GetString(), e.GetProperty("presence").GetString(), e.GetProperty("sources")[0].GetString())));
    }

    [Fact]
    public async Task Automations_that_do_not_exist_or_were_never_published_are_WF104()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var unpublished = (await (await admin.PostAsJsonAsync("/api/automations", new { name = "Sem versão" })).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
        var workflow = await DraftAsync(admin, "Cadastro", StepDocument("consulta-serasa"));

        Assert.Equal(["WF104"], await PublishErrorsAsync(admin, workflow));

        await SaveWorkflowDraftAsync(admin, workflow, StepDocument(Guid.NewGuid().ToString()));
        Assert.Equal(["WF104"], await PublishErrorsAsync(admin, workflow));

        await SaveWorkflowDraftAsync(admin, workflow, StepDocument(unpublished));
        Assert.Equal(["WF104"], await PublishErrorsAsync(admin, workflow));
    }

    // WF107 and WF108: what admins changed since the automation was published

    [Fact]
    public async Task Publishing_rechecks_the_secrets_and_destination_of_the_pinned_version()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var automation = await PublishedAutomationAsync(admin);
        var workflow = await DraftAsync(admin, "Cadastro", StepDocument(automation));

        // The version sends this secret to "erp", so unbinding it breaks the version (AU103): only a forced change gets through (§4.2).
        await PatchSecretAsync(admin, allowedDestinations: [], force: true);
        var unbound = await PublishProblemAsync(admin, workflow);
        Assert.Equal(["WF108"], Codes(unbound));
        Assert.Equal("Automation version 1: The secret 'erp_api_key' is not allowed for the destination 'erp'.", Messages(unbound).Single());

        await PatchSecretAsync(admin, allowedDestinations: Erp);
        // The version sends its secret, so going to plain http breaks it (AU104): only a forced change gets through (§3.2).
        await PutDestinationAsync(admin, new { host = "erp.internal", scheme = "http", @internal = true, pathPrefix = "/v1", allowSecretsOverHttp = false }, force: true);
        Assert.Equal(["WF108"], await PublishErrorsAsync(admin, workflow));

        await PutDestinationAsync(admin, new { host = "api.erp.example", pathPrefix = "/v1" });
        Assert.Equal(HttpStatusCode.NoContent, (await admin.DeleteAsync($"{Secrets}/erp_api_key?force=true")).StatusCode);
        var missingSecret = await PublishProblemAsync(admin, workflow);
        Assert.Equal(["WF107"], Codes(missingSecret));
        Assert.Equal("Automation version 1: The secret 'erp_api_key' does not exist.", Messages(missingSecret).Single());

        Assert.Equal(HttpStatusCode.NoContent, (await admin.DeleteAsync($"{Destinations}/erp?force=true")).StatusCode);
        Assert.Equal(["WF107", "WF108"], (await PublishErrorsAsync(admin, workflow)).Order(StringComparer.Ordinal));
    }

    // A prefix change that breaks a published version needs force (automation.md §3.2). A forced one is then left to execution.

    [Fact]
    public async Task A_forced_prefix_change_is_left_to_execution()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var automation = await PublishedAutomationAsync(admin);
        var workflow = await DraftAsync(admin, "Cadastro", StepDocument(automation));

        await PutDestinationAsync(admin, new { host = "api.erp.example", pathPrefix = "/v2" }, force: true);

        Assert.Equal(HttpStatusCode.Created, (await PublishWorkflowAsync(admin, workflow)).StatusCode);
    }

    // WF110: the step's inputs against the pinned version's input contract

    [Fact]
    public async Task Step_inputs_must_be_declared_and_cover_every_required_input()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var automation = await PublishedAutomationAsync(admin, versions: 2);
        var workflow = await DraftAsync(admin, "Cadastro", StepDocument(automation, inputs: new JsonObject { ["cpf"] = Path("cpf"), ["renda"] = Path("renda") }));

        var undeclared = await PublishProblemAsync(admin, workflow);
        Assert.Equal(["WF110"], Codes(undeclared));
        Assert.Contains("'renda'", Messages(undeclared).Single(), StringComparison.Ordinal);

        await SaveWorkflowDraftAsync(admin, workflow, StepDocument(automation, inputs: new JsonObject()));
        var unmapped = await PublishProblemAsync(admin, workflow);
        Assert.Equal(["WF110"], Codes(unmapped));
        Assert.Contains("'cpf'", Messages(unmapped).Single(), StringComparison.Ordinal);

        await SaveWorkflowDraftAsync(admin, workflow, StepDocument(automation, inputs: new JsonObject { ["cpf"] = Path("cpf"), ["canal"] = Path("canal") }));
        Assert.Equal(HttpStatusCode.Created, (await PublishWorkflowAsync(admin, workflow)).StatusCode);
    }

    // WF204 and WF205: the step's mappings against the pinned version's contracts (card #76)

    [Fact]
    public async Task Step_mappings_are_type_checked_against_the_pinned_contracts()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var automation = await PublishedAutomationAsync(admin);
        var half = new JsonObject { ["kind"] = "arithmetic", ["op"] = "divide", ["left"] = Path("situacao"), ["right"] = Literal("number", "2") };
        var workflow = await DraftAsync(admin, "Cadastro", StepDocument(automation,
            inputs: new JsonObject { ["cpf"] = Literal("number", "52998224725") }, outputs: new JsonObject { ["metade"] = half }));

        var refused = await PublishProblemAsync(admin, workflow);
        Assert.Equal(["WF204", "WF205"], Codes(refused).Order(StringComparer.Ordinal));
        Assert.Contains("Input 'cpf': automation version 1 takes text, not number.", Messages(refused));

        await SaveWorkflowDraftAsync(admin, workflow, StepDocument(automation,
            inputs: new JsonObject { ["cpf"] = Literal("text", "529.982.247-25") }, outputs: new JsonObject { ["situacao_cpf"] = Path("situacao") }));
        Assert.Equal(HttpStatusCode.Created, (await PublishWorkflowAsync(admin, workflow)).StatusCode);
    }

    // Helpers

    /// <summary>
    /// The automation of the step: a required input, one secret, one optional output. Version 2 on also declares an optional
    /// "canal", makes the output required and adds the HTTP status as "httpStatus".
    /// </summary>
    private static JsonObject Consulta(int version) => new()
    {
        ["schemaVersion"] = 1,
        ["kind"] = "http",
        ["inputs"] = version == 1
            ? new JsonArray { new JsonObject { ["key"] = "cpf", ["type"] = "text", ["required"] = true } }
            : new JsonArray
            {
                new JsonObject { ["key"] = "cpf", ["type"] = "text", ["required"] = true },
                new JsonObject { ["key"] = "canal", ["type"] = "text" },
            },
        ["request"] = new JsonObject
        {
            ["method"] = "GET", ["destination"] = "erp", ["path"] = "/v1/clientes/{cpf}",
            ["headers"] = new JsonObject { ["X-Api-Key"] = "{{secret:erp_api_key}}" },
        },
        ["response"] = new JsonObject { ["type"] = "json" },
        ["outputs"] = version == 1
            ? new JsonArray { new JsonObject { ["key"] = "situacao", ["type"] = "text", ["source"] = "body", ["path"] = new JsonArray("situacao") } }
            : new JsonArray
            {
                new JsonObject { ["key"] = "situacao", ["type"] = "text", ["required"] = true, ["source"] = "body", ["path"] = new JsonArray("situacao") },
                new JsonObject { ["key"] = "httpStatus", ["type"] = "number", ["source"] = "status" },
            },
        ["execution"] = new JsonObject { ["timeoutSeconds"] = 10 * version },
    };

    /// <summary>Creates the destination "erp", the secret "erp_api_key" and "Consultar CPF", published <paramref name="versions"/> times.</summary>
    private static async Task<string> PublishedAutomationAsync(HttpClient admin, int versions = 1)
    {
        Assert.Equal(HttpStatusCode.Created, (await admin.PostAsJsonAsync(Destinations, new { name = "erp", host = "api.erp.example", pathPrefix = "/v1" })).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await admin.PostAsJsonAsync(Secrets, new { name = "erp_api_key", value = "s3cret-value", allowedDestinations = Erp })).StatusCode);
        var created = await admin.PostAsJsonAsync("/api/automations", new { name = "Consultar CPF" });
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        for (var version = 1; version <= versions; version++)
        {
            var saved = await SendAsync(admin, HttpMethod.Put, $"/api/automations/{id}/draft", new { document = Consulta(version) }, await ETagAsync(admin, $"/api/automations/{id}"));
            Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
            var published = await SendAsync(admin, HttpMethod.Post, $"/api/automations/{id}/publish", null, await ETagAsync(admin, $"/api/automations/{id}"));
            Assert.Equal(HttpStatusCode.Created, published.StatusCode);
        }

        return id.ToString();
    }

    /// <summary>start_1 → cpf (the automation step) → end_1.</summary>
    private static JsonObject StepDocument(string automationId, JsonObject? inputs = null, JsonObject? outputs = null)
    {
        var reference = new JsonObject { ["automationId"] = automationId, ["inputs"] = inputs ?? new JsonObject { ["cpf"] = Path("cpf") } };
        if (outputs is not null)
        {
            reference["outputs"] = outputs;
        }

        return new JsonObject
        {
            ["schemaVersion"] = 1,
            ["lanes"] = new JsonArray(),
            ["nodes"] = new JsonArray
            {
                new JsonObject { ["id"] = "start_1", ["type"] = "start", ["label"] = "Início" },
                new JsonObject { ["id"] = "cpf", ["type"] = "task", ["taskKind"] = "automation", ["label"] = "Consultar CPF", ["automation"] = reference },
                new JsonObject { ["id"] = "end_1", ["type"] = "end", ["label"] = "Fim" },
            },
            ["flows"] = new JsonArray
            {
                new JsonObject { ["id"] = "f_1", ["source"] = "start_1", ["target"] = "cpf" },
                new JsonObject { ["id"] = "f_2", ["source"] = "cpf", ["target"] = "end_1" },
            },
        };
    }

    private static JsonObject Path(string key) => new() { ["kind"] = "path", ["path"] = new JsonArray(key) };

    private static JsonObject Literal(string type, string value) => new() { ["kind"] = "literal", ["type"] = type, ["value"] = value };

    private static JsonElement Step(JsonElement document) => document.GetProperty("nodes")[1].GetProperty("automation");

    private static async Task<Guid> DraftAsync(HttpClient admin, string name, JsonObject document)
    {
        var created = await admin.PostAsJsonAsync("/api/workflows", new { name });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        await SaveWorkflowDraftAsync(admin, id, document);
        return id;
    }

    private static async Task SaveWorkflowDraftAsync(HttpClient admin, Guid id, JsonObject document) =>
        Assert.Equal(HttpStatusCode.OK, (await SendAsync(admin, HttpMethod.Put, $"/api/workflows/{id}/draft", new { document }, await ETagAsync(admin, $"/api/workflows/{id}"))).StatusCode);

    private static async Task<HttpResponseMessage> PublishWorkflowAsync(HttpClient admin, Guid id) =>
        await SendAsync(admin, HttpMethod.Post, $"/api/workflows/{id}/publish", null, await ETagAsync(admin, $"/api/workflows/{id}"));

    /// <summary>The findings of a refused publish, each checked to point at the automation step.</summary>
    private static async Task<JsonElement> PublishProblemAsync(HttpClient admin, Guid id)
    {
        var response = await PublishWorkflowAsync(admin, id);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("publish_validation_failed", problem.GetProperty("code").GetString());
        var errors = problem.GetProperty("errors");
        Assert.All(errors.EnumerateArray(), e => Assert.Equal("cpf", e.GetProperty("elementId").GetString()));
        return errors;
    }

    private static async Task<List<string>> PublishErrorsAsync(HttpClient admin, Guid id) => Codes(await PublishProblemAsync(admin, id));

    private static List<string> Codes(JsonElement errors) => [.. errors.EnumerateArray().Select(e => e.GetProperty("code").GetString()!)];

    private static List<string> Messages(JsonElement errors) => [.. errors.EnumerateArray().Select(e => e.GetProperty("message").GetString()!)];

    private static async Task PatchSecretAsync(HttpClient admin, string[] allowedDestinations, bool force = false) =>
        Assert.Equal(HttpStatusCode.OK, (await SendAsync(admin, HttpMethod.Patch, $"{Secrets}/erp_api_key{(force ? "?force=true" : string.Empty)}", new { allowedDestinations }, await ETagAsync(admin, $"{Secrets}/erp_api_key"))).StatusCode);

    private static async Task PutDestinationAsync(HttpClient admin, object settings, bool force = false) =>
        Assert.Equal(HttpStatusCode.OK, (await SendAsync(admin, HttpMethod.Put, $"{Destinations}/erp{(force ? "?force=true" : string.Empty)}", settings, await ETagAsync(admin, $"{Destinations}/erp"))).StatusCode);

    private static async Task<string> ETagAsync(HttpClient client, string path) => (await client.GetAsync(path)).Headers.ETag!.Tag;

    private static async Task<HttpResponseMessage> SendAsync(HttpClient client, HttpMethod method, string path, object? body, string? etag)
    {
        using var request = new HttpRequestMessage(method, path) { Content = body is null ? null : JsonContent.Create(body) };
        if (etag is not null)
        {
            request.Headers.TryAddWithoutValidation("If-Match", etag);
        }

        return await client.SendAsync(request);
    }
}
