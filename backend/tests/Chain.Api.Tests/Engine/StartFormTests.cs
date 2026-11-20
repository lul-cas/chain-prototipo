using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Chain.Api.Tests.Infrastructure;

namespace Chain.Api.Tests.Engine;

/// <summary>The pinned start form of a startable workflow (workflow-engine.md §13.1, ADR-0015 §6.1, card #49).</summary>
[Collection(PostgresTestGroup.Name)]
public sealed class StartFormTests(PostgresFixture postgres) : IAsyncLifetime, IDisposable
{
    private readonly ChainApiFactory _factory = new(postgres.ConnectionString);
    private CreditScenario _s = null!;
    private Guid _proposta;

    public async Task InitializeAsync()
    {
        await _factory.ResetDatabaseAsync();
        _s = await CreditScenario.CreateAsync(_factory, async s =>
        {
            _proposta = await s.PublishFormAsync("Proposta", Form("cpf"));
            return WithStartForm(CreditScenario.Document(s.Analistas), _proposta);
        });
    }

    public Task DisposeAsync() => Task.CompletedTask;

    public void Dispose()
    {
        _s?.Dispose();
        _factory.Dispose();
    }

    private static string Path(Guid definitionId) => $"/api/startable-workflows/{definitionId}/start-form";

    [Fact]
    public async Task Start_holders_get_the_pinned_start_form_of_the_latest_version()
    {
        var response = await _s.Ana.GetAsync(Path(_s.DefinitionId));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(_s.DefinitionId, body.GetProperty("workflowId").GetGuid());
        Assert.Equal(1, body.GetProperty("versionNumber").GetInt32());
        var form = body.GetProperty("form");
        Assert.Equal(_proposta, form.GetProperty("formId").GetGuid());
        Assert.Equal(1, form.GetProperty("version").GetInt32());
        Assert.Equal("cpf", Assert.Single(form.GetProperty("document").GetProperty("components").EnumerateArray()).GetProperty("key").GetString());
    }

    [Fact]
    public async Task A_newer_version_with_another_start_form_is_returned()
    {
        var other = await _s.PublishFormAsync("Proposta simplificada", Form("nome"));
        await RepublishAsync(WithStartForm(CreditScenario.Document(_s.Analistas), other));

        var body = await _s.Ana.GetFromJsonAsync<JsonElement>(Path(_s.DefinitionId));

        Assert.Equal(2, body.GetProperty("versionNumber").GetInt32());
        Assert.Equal(other, body.GetProperty("form").GetProperty("formId").GetGuid());
    }

    [Fact]
    public async Task A_start_node_without_a_form_returns_a_null_form()
    {
        await RepublishAsync(CreditScenario.Document(_s.Analistas));

        var response = await _s.Ana.GetAsync(Path(_s.DefinitionId));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(2, body.GetProperty("versionNumber").GetInt32());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("form").ValueKind);
    }

    [Fact]
    public async Task Callers_without_start_get_404()
    {
        await (await _s.Bruno.GetAsync(Path(_s.DefinitionId))).AssertProblemAsync(HttpStatusCode.NotFound, "not_found"); // other group
        await (await _s.Eva.GetAsync(Path(_s.DefinitionId))).AssertProblemAsync(HttpStatusCode.NotFound, "not_found");   // view only
        await (await _s.Diego.GetAsync(Path(_s.DefinitionId))).AssertProblemAsync(HttpStatusCode.NotFound, "not_found"); // close only
        await (await _s.Fabio.GetAsync(Path(_s.DefinitionId))).AssertProblemAsync(HttpStatusCode.NotFound, "not_found"); // no group
        await (await _s.Admin.GetAsync(Path(_s.DefinitionId))).AssertProblemAsync(HttpStatusCode.NotFound, "not_found"); // E-1: admin without start
        await (await _s.Ana.GetAsync(Path(Guid.NewGuid()))).AssertProblemAsync(HttpStatusCode.NotFound, "not_found");    // unknown workflow
    }

    [Fact]
    public async Task Inactive_or_unpublished_workflows_are_not_startable_and_return_404()
    {
        var draftOnly = await _s.DraftAsync("Rascunho", CreditScenario.Document(_s.Analistas));
        await _s.GrantAsync(draftOnly, [(await AnaGroupAsync(), "start")]);
        await (await _s.Ana.GetAsync(Path(draftOnly))).AssertProblemAsync(HttpStatusCode.NotFound, "not_found");

        await _s.Admin.PostAsync($"/api/workflows/{_s.DefinitionId}/deactivate", null);
        await (await _s.Ana.GetAsync(Path(_s.DefinitionId))).AssertProblemAsync(HttpStatusCode.NotFound, "not_found");
    }

    [Fact]
    public async Task Anonymous_callers_are_rejected()
    {
        using var anonymous = _factory.CreateClient();

        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync(Path(_s.DefinitionId))).StatusCode);
    }

    private static JsonObject Form(string key) => new()
    {
        ["schemaVersion"] = 1,
        ["components"] = new JsonArray
        {
            new JsonObject { ["type"] = "text", ["key"] = key, ["label"] = key, ["validate"] = new JsonObject { ["required"] = true } },
        },
    };

    private static JsonObject WithStartForm(JsonObject document, Guid formId)
    {
        document["nodes"]![0]!["form"] = new JsonObject { ["formId"] = formId.ToString() };
        return document;
    }

    private async Task<Guid> AnaGroupAsync()
    {
        var me = await _s.Ana.GetFromJsonAsync<JsonElement>("/api/auth/me");
        return CreditScenario.Id(Assert.Single(me.GetProperty("groups").EnumerateArray()));
    }

    private async Task RepublishAsync(JsonObject document)
    {
        var etag = (await _s.Admin.GetAsync($"/api/workflows/{_s.DefinitionId}")).Headers.ETag!.Tag;
        using var draft = new HttpRequestMessage(HttpMethod.Put, $"/api/workflows/{_s.DefinitionId}/draft") { Content = JsonContent.Create(new { document }) };
        draft.Headers.TryAddWithoutValidation("If-Match", etag);
        var saved = await _s.Admin.SendAsync(draft);
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
        using var publish = new HttpRequestMessage(HttpMethod.Post, $"/api/workflows/{_s.DefinitionId}/publish");
        publish.Headers.TryAddWithoutValidation("If-Match", saved.Headers.ETag!.Tag);
        var published = await _s.Admin.SendAsync(publish);
        Assert.True(published.StatusCode == HttpStatusCode.Created, await published.Content.ReadAsStringAsync());
    }
}
