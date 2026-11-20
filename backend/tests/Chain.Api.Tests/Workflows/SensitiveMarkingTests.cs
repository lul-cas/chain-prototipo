using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Chain.Api.Tests.Engine;
using Chain.Api.Tests.Infrastructure;
using Chain.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Chain.Api.Tests.Workflows;

/// <summary>Sensitive data S1a: the sensitive keys of a version, the catalog and <c>viewSensitive</c> (sensitive-data.md §2, §3; card #53).</summary>
[Collection(PostgresTestGroup.Name)]
public sealed class SensitiveMarkingTests(PostgresFixture postgres) : IAsyncLifetime, IDisposable
{
    private readonly ChainApiFactory _factory = new(postgres.ConnectionString);
    private CreditScenario _s = null!;

    public async Task InitializeAsync()
    {
        await _factory.ResetDatabaseAsync();
        _s = await CreditScenario.CreateAsync(_factory);
    }

    public Task DisposeAsync() => Task.CompletedTask;

    public void Dispose()
    {
        _s.Dispose();
        _factory.Dispose();
    }

    private static JsonObject Form(params JsonObject[] components) => new() { ["schemaVersion"] = 1, ["components"] = new JsonArray(components) };

    private static JsonObject Text(string key, bool sensitive = false)
    {
        var field = new JsonObject { ["type"] = "text", ["key"] = key, ["label"] = key };
        if (sensitive)
        {
            field["sensitive"] = true;
        }

        return field;
    }

    private JsonObject WithForms(Guid startForm, Guid fillForm)
    {
        var document = CreditScenario.Document(_s.Analistas);
        document["nodes"]![0]!["form"] = new JsonObject { ["formId"] = startForm.ToString() };
        document["nodes"]![1]!["form"] = new JsonObject { ["formId"] = fillForm.ToString() };
        return document;
    }

    private async Task<IReadOnlyList<string>> SensitiveKeysAsync(Guid definitionId, int versionNumber)
    {
        await using var scope = _factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ChainDbContext>();
        var version = await db.WorkflowVersions.SingleAsync(v => v.DefinitionId == definitionId && v.VersionNumber == versionNumber);
        return version.SensitiveKeys;
    }

    [Fact]
    public async Task Publishing_records_the_union_of_its_forms_and_a_later_version_does_not_change_an_earlier_one()
    {
        var start = await _s.PublishFormAsync("Proposta", Form(Text("cpf", sensitive: true), Text("valor")));
        var fill = await _s.PublishFormAsync("Complemento", Form(Text("renda", sensitive: true), Text("cpf")));
        var id = await _s.PublishAsync("Crédito sigiloso", WithForms(start, fill));

        Assert.Equal(["cpf", "renda"], await SensitiveKeysAsync(id, 1)); // cpf: marked by one of its two writers

        await _s.RepublishFormAsync(fill, Form(Text("renda"), Text("cpf")));
        var republished = await _s.TryPublishAsync(id);
        Assert.Equal(HttpStatusCode.Created, republished.StatusCode); // a new version: the form's pin changed

        Assert.Equal(["cpf"], await SensitiveKeysAsync(id, 2));
        Assert.Equal(["cpf", "renda"], await SensitiveKeysAsync(id, 1));
    }

    [Fact]
    public async Task A_workflow_without_marks_records_no_sensitive_keys()
    {
        var start = await _s.PublishFormAsync("Proposta", Form(Text("cpf")));
        var id = await _s.PublishAsync("Crédito comum", WithForms(start, start));

        Assert.Empty(await SensitiveKeysAsync(id, 1));
    }

    [Fact]
    public async Task The_catalog_marks_sensitive_entries_nested_ones_included_and_leaves_the_others_as_they_were()
    {
        var conta = new JsonObject
        {
            ["type"] = "group", ["key"] = "conta", ["label"] = "Conta", ["sensitive"] = true,
            ["components"] = new JsonArray(Text("numero")),
        };
        var start = await _s.PublishFormAsync("Proposta", Form(conta, Text("obs")));
        var fill = await _s.PublishFormAsync("Complemento", Form(Text("renda")));
        var id = await _s.DraftAsync("Crédito sigiloso", WithForms(start, fill));

        var catalog = await _s.Admin.GetFromJsonAsync<JsonElement>($"/api/workflows/{id}/data-catalog");
        var analyse = catalog.GetProperty("nodes").EnumerateArray().Single(n => n.GetProperty("nodeId").GetString() == "analyse");
        var entries = analyse.GetProperty("entries").EnumerateArray()
            .ToDictionary(e => string.Join('.', e.GetProperty("path").EnumerateArray().Select(p => p.GetString())));

        Assert.True(entries["conta"].GetProperty("sensitive").GetBoolean());
        Assert.True(entries["conta.numero"].GetProperty("sensitive").GetBoolean());
        Assert.False(entries["obs"].TryGetProperty("sensitive", out _));
        Assert.False(entries["renda"].TryGetProperty("sensitive", out _));
    }

    [Fact]
    public async Task ViewSensitive_can_be_granted_and_is_listed_in_camel_case()
    {
        await _s.GrantAsync(_s.DefinitionId, [(_s.Analistas, "view"), (_s.Analistas, "viewSensitive")]);

        var grants = await _s.Admin.GetFromJsonAsync<JsonElement>($"/api/workflows/{_s.DefinitionId}/grants");

        var grant = Assert.Single(grants.EnumerateArray());
        Assert.Equal(["view", "viewSensitive"], grant.GetProperty("capabilities").EnumerateArray().Select(c => c.GetString()));
    }
}
