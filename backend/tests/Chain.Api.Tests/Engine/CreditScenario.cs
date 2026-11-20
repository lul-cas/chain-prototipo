using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Chain.Api.Tests.Infrastructure;

namespace Chain.Api.Tests.Engine;

/// <summary>
/// A published credit workflow and its people (workflow-engine.md, E1):
/// start → "Preencher proposta" (requesters) → "Analisar" (Analistas) → "Docs ok?" (Analistas, human)
/// true → end, false → back to "Preencher proposta".
/// Ana (Comercial: start) requests; Bruno and Carla (Analistas) analyse; Diego (Supervisores: close);
/// Eva (Auditoria: view); Fabio belongs to no group.
/// </summary>
internal sealed class CreditScenario : IDisposable
{
    public const string Password = "scenario-passphrase";

    private CreditScenario(ChainApiFactory factory, HttpClient admin) => (Factory, Admin) = (factory, admin);

    public ChainApiFactory Factory { get; }
    public HttpClient Admin { get; }
    public Guid DefinitionId { get; private set; }
    public Guid Analistas { get; private set; }
    public Dictionary<string, Guid> UserIds { get; } = [];
    public Dictionary<string, HttpClient> Browsers { get; } = [];

    public HttpClient Ana => Browsers["ana"];
    public HttpClient Bruno => Browsers["bruno"];
    public HttpClient Carla => Browsers["carla"];
    public HttpClient Diego => Browsers["diego"];
    public HttpClient Eva => Browsers["eva"];
    public HttpClient Fabio => Browsers["fabio"];

    public static Task<CreditScenario> CreateAsync(ChainApiFactory factory, JsonObject? document = null) =>
        CreateAsync(factory, document is null ? null : _ => Task.FromResult(document));

    /// <summary>Builds the people and groups, then publishes the document produced by <paramref name="documentFactory"/> (e.g. after publishing forms).</summary>
    public static async Task<CreditScenario> CreateAsync(ChainApiFactory factory, Func<CreditScenario, Task<JsonObject>>? documentFactory)
    {
        var scenario = new CreditScenario(factory, await factory.CreateReadyAdminAsync());
        var comercial = await scenario.GroupAsync("Comercial");
        scenario.Analistas = await scenario.GroupAsync("Analistas");
        var supervisores = await scenario.GroupAsync("Supervisores");
        var auditoria = await scenario.GroupAsync("Auditoria");

        foreach (var (name, group) in new (string, Guid?)[] { ("ana", comercial), ("bruno", scenario.Analistas), ("carla", scenario.Analistas), ("diego", supervisores), ("eva", auditoria), ("fabio", null) })
        {
            await scenario.UserAsync(name, group);
        }

        var document = documentFactory is null ? Document(scenario.Analistas) : await documentFactory(scenario);
        scenario.DefinitionId = await scenario.PublishAsync("Concessão de Crédito", document);
        await scenario.GrantAsync(scenario.DefinitionId, [(comercial, "start"), (supervisores, "close"), (auditoria, "view")]);
        return scenario;
    }

    /// <summary>The credit workflow document; lane "lane_an" belongs to <paramref name="analistas"/>.</summary>
    public static JsonObject Document(Guid analistas) => new()
    {
        ["schemaVersion"] = 1,
        ["lanes"] = new JsonArray
        {
            new JsonObject { ["id"] = "lane_req", ["title"] = "Solicitantes", ["group"] = new JsonObject { ["kind"] = "requesters" } },
            new JsonObject { ["id"] = "lane_an", ["title"] = "Análise", ["group"] = new JsonObject { ["kind"] = "group", ["groupId"] = analistas.ToString() } },
        },
        ["nodes"] = new JsonArray
        {
            new JsonObject { ["id"] = "start", ["type"] = "start", ["label"] = "Início", ["laneId"] = "lane_req" },
            new JsonObject { ["id"] = "fill", ["type"] = "task", ["taskKind"] = "human", ["label"] = "Preencher proposta", ["laneId"] = "lane_req" },
            new JsonObject { ["id"] = "analyse", ["type"] = "task", ["taskKind"] = "human", ["label"] = "Analisar", ["laneId"] = "lane_an" },
            new JsonObject { ["id"] = "docs_ok", ["type"] = "gateway", ["label"] = "Docs ok?", ["laneId"] = "lane_an", ["decisionMode"] = "human", ["question"] = "Documentação correta?" },
            new JsonObject { ["id"] = "end", ["type"] = "end", ["label"] = "Fim", ["laneId"] = "lane_an" },
        },
        ["flows"] = new JsonArray
        {
            new JsonObject { ["id"] = "f1", ["source"] = "start", ["target"] = "fill" },
            new JsonObject { ["id"] = "f2", ["source"] = "fill", ["target"] = "analyse" },
            new JsonObject { ["id"] = "f3", ["source"] = "analyse", ["target"] = "docs_ok" },
            new JsonObject { ["id"] = "f4", ["source"] = "docs_ok", ["target"] = "end", ["branch"] = "true" },
            new JsonObject { ["id"] = "f5", ["source"] = "docs_ok", ["target"] = "fill", ["branch"] = "false" },
        },
    };

    // Engine commands (each with a fresh Idempotency-Key unless one is given)

    public static Task<HttpResponseMessage> StartAsync(HttpClient client, Guid definitionId, string? key = null) =>
        PostAsync(client, "/api/instances", new { definitionId }, key ?? NewKey());

    public static Task<HttpResponseMessage> CompleteAsync(HttpClient client, Guid taskId, string? comment = null, string? key = null, JsonObject? data = null) =>
        PostAsync(client, $"/api/tasks/{taskId}/complete", new { comment, data }, key ?? NewKey());

    public static Task<HttpResponseMessage> StartWithDataAsync(HttpClient client, Guid definitionId, JsonObject data) =>
        PostAsync(client, "/api/instances", new { definitionId, data }, NewKey());

    /// <summary>Creates and publishes a form, returning its id.</summary>
    public async Task<Guid> PublishFormAsync(string name, JsonObject document)
    {
        var created = await Admin.PostAsJsonAsync("/api/forms", new { name });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        await RepublishFormAsync(id, document);
        return id;
    }

    /// <summary>Saves <paramref name="document"/> as the form's draft and publishes it as a new version.</summary>
    public async Task RepublishFormAsync(Guid id, JsonObject document)
    {
        await SendAsync(HttpMethod.Put, $"/api/forms/{id}/draft", new { document }, (await Admin.GetAsync($"/api/forms/{id}")).Headers.ETag!.Tag);
        var publish = await SendAsync(HttpMethod.Post, $"/api/forms/{id}/publish", null, (await Admin.GetAsync($"/api/forms/{id}")).Headers.ETag!.Tag);
        Assert.True(publish.IsSuccessStatusCode, await publish.Content.ReadAsStringAsync());
    }

    public static Task<HttpResponseMessage> DecideAsync(HttpClient client, Guid taskId, bool outcome, string? justification = null) =>
        PostAsync(client, $"/api/tasks/{taskId}/decide", new { outcome, justification }, NewKey());

    public static Task<HttpResponseMessage> StartWorkingAsync(HttpClient client, Guid taskId) =>
        PostAsync(client, $"/api/tasks/{taskId}/start", null, NewKey());

    public static Task<HttpResponseMessage> TakeOverAsync(HttpClient client, Guid taskId) =>
        PostAsync(client, $"/api/tasks/{taskId}/take-over", null, NewKey());

    public static Task<HttpResponseMessage> CloseAsync(HttpClient client, Guid instanceId, string? justification) =>
        PostAsync(client, $"/api/instances/{instanceId}/close", new { justification }, NewKey());

    public static async Task<HttpResponseMessage> PostAsync(HttpClient client, string path, object? body, string? key)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = JsonContent.Create(body ?? new { }) };
        if (key is not null)
        {
            request.Headers.Add("Idempotency-Key", key);
        }

        return await client.SendAsync(request);
    }

    /// <summary>A command whose body is <paramref name="json"/> as written, for text a serializer would not produce (card #129).</summary>
    public static async Task<HttpResponseMessage> PostTextAsync(HttpClient client, string path, string json, string? key = null)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = ApiTestSession.RawJson(json) };
        request.Headers.Add("Idempotency-Key", key ?? NewKey());
        return await client.SendAsync(request);
    }

    /// <summary>Admin data correction (workflow-engine.md §16), with <c>If-Match</c> when <paramref name="etag"/> is given.</summary>
    public static async Task<HttpResponseMessage> CorrectAsync(HttpClient client, Guid instanceId, string? etag, object body, string? key = null)
    {
        using var request = new HttpRequestMessage(HttpMethod.Patch, $"/api/instances/{instanceId}/data") { Content = JsonContent.Create(body) };
        request.Headers.Add("Idempotency-Key", key ?? NewKey());
        if (etag is not null)
        {
            request.Headers.TryAddWithoutValidation("If-Match", etag);
        }

        return await client.SendAsync(request);
    }

    /// <summary>The instance's current version, from its <c>ETag</c>.</summary>
    public static async Task<string> CurrentETagAsync(HttpClient client, Guid instanceId) =>
        (await client.GetAsync($"/api/instances/{instanceId}")).Headers.ETag!.Tag;

    public static string NewKey() => Guid.NewGuid().ToString("N");

    public static async Task<Guid> StartedInstanceAsync(HttpClient client, Guid definitionId)
    {
        var response = await StartAsync(client, definitionId);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    /// <summary>The single open task of an instance, as seen by <paramref name="client"/>.</summary>
    public static async Task<JsonElement> OpenTaskAsync(HttpClient client, Guid instanceId)
    {
        var instance = await client.GetFromJsonAsync<JsonElement>($"/api/instances/{instanceId}");
        return Assert.Single(instance.GetProperty("openTasks").EnumerateArray());
    }

    public static Guid Id(JsonElement element) => element.GetProperty("id").GetGuid();

    // Setup helpers

    public async Task<Guid> PublishAsync(string name, JsonObject document)
    {
        var id = await DraftAsync(name, document);
        var publish = await TryPublishAsync(id);
        Assert.True(publish.IsSuccessStatusCode, await publish.Content.ReadAsStringAsync());
        return id;
    }

    /// <summary>Creates a definition whose draft is <paramref name="document"/>, without publishing it.</summary>
    public async Task<Guid> DraftAsync(string name, JsonObject document)
    {
        var created = await Admin.PostAsJsonAsync("/api/workflows", new { name });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        await SaveDraftAsync(id, document);
        return id;
    }

    /// <summary>Replaces the draft of the definition <paramref name="id"/> with <paramref name="document"/>.</summary>
    public async Task SaveDraftAsync(Guid id, JsonObject document)
    {
        var saved = await SendAsync(HttpMethod.Put, $"/api/workflows/{id}/draft", new { document }, await ETagAsync(id));
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
    }

    public async Task<HttpResponseMessage> TryPublishAsync(Guid id) =>
        await SendAsync(HttpMethod.Post, $"/api/workflows/{id}/publish", null, await ETagAsync(id));

    public async Task GrantAsync(Guid definitionId, (Guid Group, string Capability)[] grants)
    {
        var body = grants.GroupBy(g => g.Group).Select(g => new { groupId = g.Key, capabilities = g.Select(x => x.Capability).ToArray() }).ToArray();
        var response = await SendAsync(HttpMethod.Put, $"/api/workflows/{definitionId}/grants", body, await ETagAsync(definitionId));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    public async Task<Guid> GroupAsync(string name)
    {
        var response = await Admin.PostAsJsonAsync("/api/admin/groups", new { name });
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    public async Task UserAsync(string username, Guid? group)
    {
        var response = await Admin.PostAsJsonAsync("/api/admin/users", new { username, displayName = username, isAdmin = false });
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var id = body.GetProperty("user").GetProperty("id").GetGuid();
        if (group is { } groupId)
        {
            await Admin.PutAsync($"/api/admin/groups/{groupId}/members/{id}", null);
        }

        UserIds[username] = id;
        Browsers[username] = await Factory.CreateReadyUserAsync(username, body.GetProperty("temporaryPassword").GetString()!, Password);
    }

    private async Task<string> ETagAsync(Guid id) => (await Admin.GetAsync($"/api/workflows/{id}")).Headers.ETag!.Tag;

    private async Task<HttpResponseMessage> SendAsync(HttpMethod method, string path, object? body, string etag)
    {
        using var request = new HttpRequestMessage(method, path);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }

        request.Headers.TryAddWithoutValidation("If-Match", etag);
        return await Admin.SendAsync(request);
    }

    public void Dispose()
    {
        Admin.Dispose();
        foreach (var browser in Browsers.Values)
        {
            browser.Dispose();
        }
    }
}
