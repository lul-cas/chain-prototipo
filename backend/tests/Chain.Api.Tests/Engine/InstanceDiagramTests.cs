using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Chain.Api.Tests.Infrastructure;

namespace Chain.Api.Tests.Engine;

/// <summary>The request's diagram (workflow-engine.md §9, "Diagram"; workflow-editor.md §9, N2f).</summary>
[Collection(PostgresTestGroup.Name)]
public sealed class InstanceDiagramTests(PostgresFixture postgres) : IAsyncLifetime, IDisposable
{
    private readonly ChainApiFactory _factory = new(postgres.ConnectionString);
    private CreditScenario _s = null!;

    public async Task InitializeAsync() => await _factory.ResetDatabaseAsync();

    public Task DisposeAsync() => Task.CompletedTask;

    public void Dispose()
    {
        _s?.Dispose();
        _factory.Dispose();
    }

    [Fact]
    public async Task The_diagram_shows_the_pinned_version_and_the_current_step_to_whoever_sees_the_request()
    {
        _s = await CreditScenario.CreateAsync(_factory);
        var instanceId = await CreditScenario.StartedInstanceAsync(_s.Ana, _s.DefinitionId);

        var diagram = await _s.Ana.GetFromJsonAsync<JsonElement>($"/api/instances/{instanceId}/diagram");

        Assert.Equal(_s.DefinitionId, diagram.GetProperty("definitionId").GetGuid());
        Assert.Equal(1, diagram.GetProperty("versionNumber").GetInt32());
        Assert.Equal("fill", diagram.GetProperty("currentNodeId").GetString());
        var document = diagram.GetProperty("document");
        Assert.Equal(["start", "fill", "analyse", "docs_ok", "end"], document.GetProperty("nodes").EnumerateArray().Select(n => n.GetProperty("id").GetString()));
        Assert.Equal(5, document.GetProperty("flows").GetArrayLength());
        Assert.Equal("false", document.GetProperty("flows")[4].GetProperty("branch").GetString());

        Assert.Equal(HttpStatusCode.OK, (await _s.Eva.GetAsync($"/api/instances/{instanceId}/diagram")).StatusCode);   // view capability
        Assert.Equal(HttpStatusCode.NotFound, (await _s.Fabio.GetAsync($"/api/instances/{instanceId}/diagram")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _s.Ana.GetAsync($"/api/instances/{Guid.NewGuid()}/diagram")).StatusCode);
    }

    [Fact]
    public async Task The_diagram_leaves_out_forms_questions_conditions_and_lane_groups()
    {
        _s = await CreditScenario.CreateAsync(_factory, async s =>
        {
            var form = await s.PublishFormAsync("Proposta", new JsonObject
            {
                ["schemaVersion"] = 1,
                ["components"] = new JsonArray(new JsonObject { ["type"] = "text", ["key"] = "cliente", ["label"] = "Cliente" }),
            });
            var document = CreditScenario.Document(s.Analistas);
            document["nodes"]![0]!["form"] = new JsonObject { ["formId"] = form.ToString() };
            document["nodes"]![3]!.AsObject().Remove("question");
            document["nodes"]![3]!["decisionMode"] = "automatic";
            document["nodes"]![3]!["condition"] = new JsonObject
            {
                ["kind"] = "compare",
                ["left"] = new JsonObject { ["kind"] = "path", ["path"] = new JsonArray("cliente") },
                ["operator"] = "isNotEmpty",
            };
            document["nodes"]![1]!["layout"] = new JsonObject { ["x"] = 210, ["y"] = 60, ["w"] = 140, ["h"] = 70 };
            return document;
        });
        var started = await CreditScenario.StartWithDataAsync(_s.Ana, _s.DefinitionId, new JsonObject { ["cliente"] = "Ana" });
        var instanceId = (await started.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();

        var document = (await _s.Ana.GetFromJsonAsync<JsonElement>($"/api/instances/{instanceId}/diagram")).GetProperty("document");

        var nodes = document.GetProperty("nodes").EnumerateArray().ToList();
        Assert.False(nodes[0].TryGetProperty("form", out _));
        Assert.Equal(("automatic", false, false), (nodes[3].GetProperty("decisionMode").GetString(), nodes[3].TryGetProperty("condition", out _), nodes[3].TryGetProperty("question", out _)));
        Assert.Equal(("task", "human", "Preencher proposta"), (nodes[1].GetProperty("type").GetString(), nodes[1].GetProperty("taskKind").GetString(), nodes[1].GetProperty("label").GetString()));
        Assert.Equal(210, nodes[1].GetProperty("layout").GetProperty("x").GetInt32());
        var lane = document.GetProperty("lanes")[1];
        Assert.Equal(("lane_an", "Análise", false), (lane.GetProperty("id").GetString(), lane.GetProperty("title").GetString(), lane.TryGetProperty("group", out _)));
    }
}
