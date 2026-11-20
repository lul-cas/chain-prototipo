using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Chain.Api.Tests.Infrastructure;

namespace Chain.Api.Tests.Engine;

/// <summary>Acceptance criteria of increment E2b: data catalog and publish-time type checking (workflow-definition.md §6).</summary>
[Collection(PostgresTestGroup.Name)]
public sealed class EngineE2bTests(PostgresFixture postgres) : IAsyncLifetime, IDisposable
{
    private readonly ChainApiFactory _factory = new(postgres.ConnectionString);
    private CreditScenario _s = null!;
    private Guid _proposta;
    private Guid _parecer;

    public async Task InitializeAsync()
    {
        await _factory.ResetDatabaseAsync();
        _s = await CreditScenario.CreateAsync(_factory);
        _proposta = await _s.PublishFormAsync("Proposta", Form(
            Field("number", "valor", required: true),
            Field("date", "vencimento", required: true),
            Field("text", "obs", required: false)));
        _parecer = await _s.PublishFormAsync("Parecer", Form(Field("number", "score", required: true), Field("text", "nota", required: false)));
    }

    public Task DisposeAsync() => Task.CompletedTask;

    public void Dispose()
    {
        _s?.Dispose();
        _factory.Dispose();
    }

    private static JsonObject Form(params JsonObject[] components) => new() { ["schemaVersion"] = 1, ["components"] = new JsonArray(components) };

    private static JsonObject Field(string type, string key, bool required) =>
        new() { ["type"] = type, ["key"] = key, ["label"] = key, ["validate"] = new JsonObject { ["required"] = required } };

    private static JsonObject Path(string key) => new() { ["kind"] = "path", ["path"] = new JsonArray(key) };

    private static JsonObject Literal(string type, string value) => new() { ["kind"] = "literal", ["type"] = type, ["value"] = value };

    private static JsonObject Compare(JsonObject left, string op, JsonObject right) => new() { ["kind"] = "compare", ["left"] = left, ["operator"] = op, ["right"] = right };

    private static JsonObject Flow(string id, string source, string target, string? branch = null)
    {
        var flow = new JsonObject { ["id"] = id, ["source"] = source, ["target"] = target };
        if (branch is not null)
        {
            flow["branch"] = branch;
        }

        return flow;
    }

    /// <summary>start (Proposta) → gw (automatic, <paramref name="condition"/>) → end either way.</summary>
    private JsonObject Gateway(JsonObject condition) => new()
    {
        ["schemaVersion"] = 1,
        ["lanes"] = new JsonArray(),
        ["nodes"] = new JsonArray
        {
            new JsonObject { ["id"] = "start", ["type"] = "start", ["label"] = "Início", ["form"] = new JsonObject { ["formId"] = _proposta.ToString() } },
            new JsonObject { ["id"] = "gw", ["type"] = "gateway", ["label"] = "Teste", ["decisionMode"] = "automatic", ["condition"] = condition },
            new JsonObject { ["id"] = "end", ["type"] = "end", ["label"] = "Fim" },
        },
        ["flows"] = new JsonArray { Flow("f1", "start", "gw"), Flow("f2", "gw", "end", "true"), Flow("f3", "gw", "end", "false") },
    };

    /// <summary>Child: start (Proposta) → "Avaliar" (Analistas, Parecer) → end.</summary>
    private JsonObject Child() => new()
    {
        ["schemaVersion"] = 1,
        ["lanes"] = new JsonArray
        {
            new JsonObject { ["id"] = "lane_an", ["title"] = "Análise", ["group"] = new JsonObject { ["kind"] = "group", ["groupId"] = _s.Analistas.ToString() } },
        },
        ["nodes"] = new JsonArray
        {
            new JsonObject { ["id"] = "start", ["type"] = "start", ["label"] = "Início", ["form"] = new JsonObject { ["formId"] = _proposta.ToString() } },
            new JsonObject { ["id"] = "risk", ["type"] = "task", ["taskKind"] = "human", ["label"] = "Avaliar", ["laneId"] = "lane_an", ["form"] = new JsonObject { ["formId"] = _parecer.ToString() } },
            new JsonObject { ["id"] = "end", ["type"] = "end", ["label"] = "Fim" },
        },
        ["flows"] = new JsonArray { Flow("f1", "start", "risk"), Flow("f2", "risk", "end") },
    };

    /// <summary>Parent: start (Proposta) → sub (child) → review → end.</summary>
    private static JsonObject Parent(Guid child, JsonObject inputs, JsonObject outputs) => new()
    {
        ["schemaVersion"] = 1,
        ["lanes"] = new JsonArray(),
        ["nodes"] = new JsonArray
        {
            new JsonObject { ["id"] = "start", ["type"] = "start", ["label"] = "Início" },
            new JsonObject
            {
                ["id"] = "sub", ["type"] = "task", ["taskKind"] = "subprocess", ["label"] = "Análise",
                ["workflow"] = new JsonObject { ["workflowId"] = child.ToString(), ["inputs"] = inputs, ["outputs"] = outputs },
            },
            new JsonObject { ["id"] = "review", ["type"] = "task", ["taskKind"] = "human", ["label"] = "Revisar" },
            new JsonObject { ["id"] = "end", ["type"] = "end", ["label"] = "Fim" },
        },
        ["flows"] = new JsonArray { Flow("f1", "start", "sub"), Flow("f2", "sub", "review"), Flow("f3", "review", "end") },
    };

    private static async Task<List<(string Code, string? ElementId)>> PublishErrorsAsync(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        return [.. problem.GetProperty("errors").EnumerateArray().Select(e => (e.GetProperty("code").GetString()!, e.GetProperty("elementId").GetString()))];
    }

    // 3. WF201

    [Theory]
    [InlineData("valor", "greaterThan", "text", "abc")]
    [InlineData("vencimento", "greaterOrEqual", null, "currentDateTime")]
    [InlineData("obs", "greaterThan", "text", "a")]
    public async Task Ill_typed_automatic_conditions_are_rejected_at_publish(string key, string op, string? literalType, string value)
    {
        var right = literalType is null ? new JsonObject { ["kind"] = "system", ["name"] = value } : Literal(literalType, value);
        var id = await _s.DraftAsync($"Gateway {key}", Gateway(Compare(Path(key), op, right)));

        var errors = await PublishErrorsAsync(await _s.TryPublishAsync(id));

        Assert.Equal([("WF201", "gw")], errors);
    }

    [Fact]
    public async Task Well_typed_and_unknown_conditions_publish()
    {
        await _s.PublishAsync("Valor alto", Gateway(Compare(Path("valor"), "greaterThan", Literal("number", "30000"))));
        await _s.PublishAsync("Vencido", Gateway(Compare(Path("vencimento"), "lessThan", new JsonObject { ["kind"] = "system", ["name"] = "currentDate" })));
        await _s.PublishAsync("Sem dado", Gateway(Compare(Path("inexistente"), "greaterThan", Literal("text", "abc")))); // TC-1
    }

    // 4. WF202, WF203

    [Fact]
    public async Task Sub_workflow_mappings_are_type_checked_against_the_child()
    {
        var child = await _s.PublishAsync("Análise de risco", Child());
        var draft = Parent(
            child,
            new JsonObject { ["valor"] = Literal("text", "abc"), ["prazo"] = Literal("number", "1"), ["vencimento"] = new JsonObject { ["kind"] = "system", ["name"] = "currentDate" } },
            new JsonObject
            {
                ["dobro"] = new JsonObject { ["kind"] = "arithmetic", ["op"] = "multiply", ["left"] = Path("score"), ["right"] = Literal("number", "2") },
                ["errado"] = new JsonObject { ["kind"] = "arithmetic", ["op"] = "multiply", ["left"] = Path("nota"), ["right"] = Literal("number", "2") },
            });
        var id = await _s.DraftAsync("Crédito com análise", draft);

        var errors = await PublishErrorsAsync(await _s.TryPublishAsync(id));

        Assert.Equal(
            [("WF202", "sub"), ("WF202", "sub"), ("WF203", "sub")],
            errors.OrderBy(e => e.Code, StringComparer.Ordinal));
    }

    // Regression #69: mapping a list<file> into a child's start-form file field published, and the parent then faulted with
    // subprocess_input_invalid every time, because the child's start form refuses files attached to the parent. Owner
    // decision, option A (2026-10-16): inputs carrying files are refused at publish (workflow-engine.md §14.1).

    [Fact]
    public async Task Sub_workflow_inputs_that_carry_files_are_rejected_at_publish()
    {
        var anexos = await _s.PublishFormAsync("Anexos", Form(
            new JsonObject { ["type"] = "file", ["key"] = "docs", ["label"] = "Documentos" },
            Field("number", "valor", required: true)));
        var withForm = Child();
        withForm["nodes"]![0]!["form"] = new JsonObject { ["formId"] = anexos.ToString() };
        var childWithForm = await _s.PublishAsync("Análise com anexos", withForm);
        var withoutForm = Child();
        withoutForm["nodes"]![0]!.AsObject().Remove("form");
        var childWithoutForm = await _s.PublishAsync("Análise livre", withoutForm);
        JsonObject WithAnexos(JsonObject parent)
        {
            parent["nodes"]![0]!["form"] = new JsonObject { ["formId"] = anexos.ToString() };
            return parent;
        }

        var intoFileField = await _s.DraftAsync("Repasse de anexos", WithAnexos(Parent(
            childWithForm, new JsonObject { ["docs"] = Path("docs"), ["valor"] = Path("valor") }, [])));
        var intoFreeChild = await _s.DraftAsync("Repasse livre", WithAnexos(Parent(childWithoutForm, new JsonObject { ["anexos"] = Path("docs") }, [])));

        Assert.Equal([("WF206", "sub")], await PublishErrorsAsync(await _s.TryPublishAsync(intoFileField)));
        Assert.Equal([("WF206", "sub")], await PublishErrorsAsync(await _s.TryPublishAsync(intoFreeChild)));
        var count = new JsonObject { ["kind"] = "call", ["function"] = "count", ["args"] = new JsonArray(Path("docs")) };
        await _s.PublishAsync("Repasse da contagem", WithAnexos(Parent(childWithoutForm, new JsonObject { ["quantos"] = count }, [])));
    }

    // Regression #203: a sub-workflow step that left a required field of the child's start form unmapped published, then faulted
    // with subprocess_input_invalid every time it ran. Publishing now refuses it (WF207), a required file field included.

    [Fact]
    public async Task A_step_that_leaves_a_required_start_field_unmapped_is_rejected_at_publish()
    {
        var child = await _s.PublishAsync("Análise de risco", Child()); // start form Proposta: valor and vencimento required, obs not
        var partial = await _s.DraftAsync("Crédito sem vencimento", Parent(child, new JsonObject { ["valor"] = Literal("number", "1000") }, []));

        Assert.Equal([("WF207", "sub")], await PublishErrorsAsync(await _s.TryPublishAsync(partial)));
        await _s.PublishAsync("Crédito completo", Parent(child, new JsonObject { ["valor"] = Literal("number", "1000"), ["vencimento"] = Literal("date", "2026-12-01") }, []));
    }

    [Fact]
    public async Task A_child_with_a_required_file_start_field_cannot_be_called()
    {
        var anexos = await _s.PublishFormAsync("Anexos obrigatórios", Form(
            new JsonObject { ["type"] = "file", ["key"] = "docs", ["label"] = "Documentos", ["validate"] = new JsonObject { ["required"] = true } }));
        var withForm = Child();
        withForm["nodes"]![0]!["form"] = new JsonObject { ["formId"] = anexos.ToString() };
        var child = await _s.PublishAsync("Análise com anexos obrigatórios", withForm);

        Assert.Equal([("WF207", "sub")], await PublishErrorsAsync(await _s.TryPublishAsync(await _s.DraftAsync("Repasse impossível", Parent(child, [], [])))));
    }

    [Fact]
    public async Task A_conditionally_required_start_field_may_be_left_unmapped()
    {
        var condition = Compare(Path("valor"), "greaterThan", Literal("number", "1000"));
        var shown = Field("text", "garantia", required: true);
        shown["visibleWhen"] = condition;
        var sometimes = Field("text", "justificativa", required: false);
        sometimes["requiredWhen"] = condition.DeepClone();
        var form = await _s.PublishFormAsync("Proposta condicional", Form(Field("number", "valor", required: true), shown, sometimes));
        var withForm = Child();
        withForm["nodes"]![0]!["form"] = new JsonObject { ["formId"] = form.ToString() };
        var child = await _s.PublishAsync("Análise condicional", withForm);

        await _s.PublishAsync("Crédito condicional", Parent(child, new JsonObject { ["valor"] = Literal("number", "500") }, []));
    }

    // 6. Catalog endpoint

    [Fact]
    public async Task The_catalog_endpoint_lists_the_data_each_step_sees()
    {
        var child = await _s.PublishAsync("Análise de risco", Child());
        var draft = Parent(
            child,
            new JsonObject { ["valor"] = Literal("number", "1000"), ["vencimento"] = Literal("date", "2026-12-01") },
            new JsonObject { ["score"] = Path("score"), ["nota"] = Path("nota") });
        draft["nodes"]![0]!["form"] = new JsonObject { ["formId"] = _proposta.ToString() };
        var id = await _s.DraftAsync("Crédito com análise", draft);

        var catalog = await _s.Admin.GetFromJsonAsync<JsonElement>($"/api/workflows/{id}/data-catalog");

        var nodes = catalog.GetProperty("nodes").EnumerateArray().ToDictionary(n => n.GetProperty("nodeId").GetString()!);
        Assert.Equal(["start", "sub", "review", "end"], nodes.Keys);
        Assert.Empty(nodes["start"].GetProperty("entries").EnumerateArray());
        var review = nodes["review"].GetProperty("entries").EnumerateArray()
            .ToDictionary(e => string.Join('.', e.GetProperty("path").EnumerateArray().Select(p => p.GetString())));
        Assert.Equal(["nota", "obs", "score", "valor", "vencimento"], review.Keys);
        Assert.Equal("number", review["score"].GetProperty("type").GetString());
        Assert.Equal("definite", review["score"].GetProperty("presence").GetString());
        Assert.Equal("optional", review["nota"].GetProperty("presence").GetString());
        Assert.Equal("date", review["vencimento"].GetProperty("type").GetString());
        Assert.Equal(["sub"], review["score"].GetProperty("sources").EnumerateArray().Select(s => s.GetString()));
        Assert.Equal(["start"], review["valor"].GetProperty("sources").EnumerateArray().Select(s => s.GetString()));

        Assert.Equal(HttpStatusCode.Forbidden, (await _s.Ana.GetAsync($"/api/workflows/{id}/data-catalog")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _s.Admin.GetAsync($"/api/workflows/{Guid.NewGuid()}/data-catalog")).StatusCode);
    }

    [Fact]
    public async Task A_version_contract_lists_its_start_form_fields_and_its_data_at_completion()
    {
        var childId = await _s.PublishAsync("Análise de risco", Child());

        var contract = await _s.Admin.GetFromJsonAsync<JsonElement>($"/api/workflows/{childId}/versions/1/contract");

        Assert.Equal(1, contract.GetProperty("versionNumber").GetInt32());
        Assert.Equal(
            [("valor", "number", true), ("vencimento", "date", true), ("obs", "text", false)],
            contract.GetProperty("inputs").EnumerateArray()
                .Select(i => (i.GetProperty("key").GetString(), i.GetProperty("type").GetString(), i.GetProperty("required").GetBoolean())));
        var outputs = contract.GetProperty("outputs").EnumerateArray()
            .ToDictionary(e => string.Join('.', e.GetProperty("path").EnumerateArray().Select(p => p.GetString())));
        Assert.Equal(["nota", "obs", "score", "valor", "vencimento"], outputs.Keys);
        Assert.Equal(("number", "definite"), (outputs["score"].GetProperty("type").GetString(), Presence(outputs["score"])));
        Assert.Equal(("text", "optional"), (outputs["nota"].GetProperty("type").GetString(), Presence(outputs["nota"])));

        Assert.Equal(HttpStatusCode.Forbidden, (await _s.Ana.GetAsync($"/api/workflows/{childId}/versions/1/contract")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _s.Admin.GetAsync($"/api/workflows/{childId}/versions/2/contract")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _s.Admin.GetAsync($"/api/workflows/{Guid.NewGuid()}/versions/1/contract")).StatusCode);
    }

    [Fact]
    public async Task A_version_without_a_start_form_takes_any_inputs()
    {
        var child = Child();
        child["nodes"]![0]!.AsObject().Remove("form");
        var childId = await _s.PublishAsync("Revisão livre", child);

        var contract = await _s.Admin.GetFromJsonAsync<JsonElement>($"/api/workflows/{childId}/versions/1/contract");

        Assert.Equal(JsonValueKind.Null, contract.GetProperty("inputs").ValueKind);
        Assert.Equal(
            ["nota", "score"],
            contract.GetProperty("outputs").EnumerateArray().Select(e => string.Join('.', e.GetProperty("path").EnumerateArray().Select(p => p.GetString()))));
    }

    [Fact]
    public async Task A_key_a_later_form_can_clear_is_optional_after_that_step_and_as_a_child_output()
    {
        var revisao = await _s.PublishFormAsync("Revisão", Form(Field("number", "valor", required: false)));
        var child = Child();
        child["nodes"]![1]!["form"] = new JsonObject { ["formId"] = revisao.ToString() };
        var childId = await _s.PublishAsync("Revisão de valor", child);
        var parentId = await _s.DraftAsync("Crédito revisado", Parent(
            childId,
            new JsonObject { ["valor"] = Literal("number", "1000"), ["vencimento"] = Literal("date", "2026-12-01") },
            new JsonObject { ["revisado"] = Path("valor"), ["prazo"] = Path("vencimento") }));

        var atChildEnd = await EntriesAsync(childId, "end");
        var atReview = await EntriesAsync(parentId, "review");

        // An empty answer at "risk" removes valor (decision B, card #86), so neither the child nor its parent can count on it.
        Assert.Equal(("optional", "optional"), (Presence(atChildEnd["valor"]), Presence(atReview["revisado"])));
        Assert.Equal(["risk", "start"], atChildEnd["valor"].GetProperty("sources").EnumerateArray().Select(s => s.GetString()));
        Assert.Equal(("definite", "definite"), (Presence(atChildEnd["vencimento"]), Presence(atReview["prazo"])));
    }

    /// <summary>The catalog entries a node of the workflow's draft sees, by dotted path.</summary>
    private async Task<Dictionary<string, JsonElement>> EntriesAsync(Guid workflowId, string nodeId)
    {
        var catalog = await _s.Admin.GetFromJsonAsync<JsonElement>($"/api/workflows/{workflowId}/data-catalog");
        return catalog.GetProperty("nodes").EnumerateArray().Single(n => n.GetProperty("nodeId").GetString() == nodeId)
            .GetProperty("entries").EnumerateArray()
            .ToDictionary(e => string.Join('.', e.GetProperty("path").EnumerateArray().Select(p => p.GetString())));
    }

    private static string? Presence(JsonElement entry) => entry.GetProperty("presence").GetString();
}
