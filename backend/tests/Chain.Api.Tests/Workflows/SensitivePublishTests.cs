using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Chain.Api.Tests.Engine;
using Chain.Api.Tests.Infrastructure;

namespace Chain.Api.Tests.Workflows;

/// <summary>Sensitive data S1c: the publish rules WF208–WF210 (sensitive-data.md §7, card #53).</summary>
[Collection(PostgresTestGroup.Name)]
public sealed class SensitivePublishTests(PostgresFixture postgres) : IAsyncLifetime, IDisposable
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

    private static JsonObject PathTo(string key) => new() { ["kind"] = "path", ["path"] = new JsonArray(key) };

    private static JsonObject Text(string key, bool sensitive = false, bool readOnly = false, string? visibleWhenFilled = null)
    {
        var field = new JsonObject { ["type"] = "text", ["key"] = key, ["label"] = key };
        if (sensitive)
        {
            field["sensitive"] = true;
        }

        if (readOnly)
        {
            field["readOnly"] = true;
        }

        if (visibleWhenFilled is not null)
        {
            field["visibleWhen"] = new JsonObject { ["kind"] = "compare", ["left"] = PathTo(visibleWhenFilled), ["operator"] = "isNotEmpty" };
        }

        return field;
    }

    private static JsonObject Copy(string key, string from, bool sensitive)
    {
        var field = new JsonObject { ["type"] = "computed", ["key"] = key, ["label"] = key, ["expression"] = PathTo(from) };
        if (sensitive)
        {
            field["sensitive"] = true;
        }

        return field;
    }

    private static JsonObject Flow(string id, string source, string target) => new() { ["id"] = id, ["source"] = source, ["target"] = target };

    private static JsonObject FormRef(Guid form) => new() { ["formId"] = form.ToString() };

    /// <summary>start (<paramref name="startForm"/>) → "fill" (<paramref name="fillForm"/>) → end.</summary>
    private static JsonObject Workflow(Guid startForm, Guid fillForm) => new()
    {
        ["schemaVersion"] = 1,
        ["lanes"] = new JsonArray(),
        ["nodes"] = new JsonArray
        {
            new JsonObject { ["id"] = "start", ["type"] = "start", ["label"] = "Início", ["form"] = FormRef(startForm) },
            new JsonObject { ["id"] = "fill", ["type"] = "task", ["taskKind"] = "human", ["label"] = "Completar", ["form"] = FormRef(fillForm) },
            new JsonObject { ["id"] = "end", ["type"] = "end", ["label"] = "Fim" },
        },
        ["flows"] = new JsonArray { Flow("f1", "start", "fill"), Flow("f2", "fill", "end") },
    };

    /// <summary>A child: start (<paramref name="startForm"/>) → end.</summary>
    private static JsonObject Child(Guid startForm) => new()
    {
        ["schemaVersion"] = 1,
        ["lanes"] = new JsonArray(),
        ["nodes"] = new JsonArray
        {
            new JsonObject { ["id"] = "start", ["type"] = "start", ["label"] = "Início", ["form"] = FormRef(startForm) },
            new JsonObject { ["id"] = "end", ["type"] = "end", ["label"] = "Fim" },
        },
        ["flows"] = new JsonArray { Flow("f1", "start", "end") },
    };

    /// <summary>A parent: start (<paramref name="startForm"/>) → "sub" (the child) → "review" (<paramref name="reviewForm"/>) → end.</summary>
    private static JsonObject Parent(Guid? startForm, Guid child, JsonObject inputs, JsonObject outputs, Guid? reviewForm = null)
    {
        var start = new JsonObject { ["id"] = "start", ["type"] = "start", ["label"] = "Início" };
        if (startForm is { } form)
        {
            start["form"] = FormRef(form);
        }

        var review = new JsonObject { ["id"] = "review", ["type"] = "task", ["taskKind"] = "human", ["label"] = "Revisar" };
        if (reviewForm is { } reviewed)
        {
            review["form"] = FormRef(reviewed);
        }

        return new JsonObject
        {
            ["schemaVersion"] = 1,
            ["lanes"] = new JsonArray(),
            ["nodes"] = new JsonArray
            {
                start,
                new JsonObject
                {
                    ["id"] = "sub", ["type"] = "task", ["taskKind"] = "subprocess", ["label"] = "Consultar",
                    ["workflow"] = new JsonObject { ["workflowId"] = child.ToString(), ["inputs"] = inputs, ["outputs"] = outputs },
                },
                review,
                new JsonObject { ["id"] = "end", ["type"] = "end", ["label"] = "Fim" },
            },
            ["flows"] = new JsonArray { Flow("f1", "start", "sub"), Flow("f2", "sub", "review"), Flow("f3", "review", "end") },
        };
    }

    private static async Task<List<(string Code, string? ElementId)>> PublishErrorsAsync(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        return [.. problem.GetProperty("errors").EnumerateArray().Select(e => (e.GetProperty("code").GetString()!, e.GetProperty("elementId").GetString()))];
    }

    [Fact]
    public async Task WF208_a_form_condition_can_read_a_sensitive_key_only_if_the_form_has_that_field()
    {
        var proposta = await _s.PublishFormAsync("Proposta", Form(Text("cpf", sensitive: true)));
        var complemento = await _s.PublishFormAsync("Complemento", Form(Text("obs", visibleWhenFilled: "cpf")));
        var id = await _s.DraftAsync("Crédito sigiloso", Workflow(proposta, complemento));

        Assert.Contains(("WF208", "fill"), await PublishErrorsAsync(await _s.TryPublishAsync(id)));

        await _s.RepublishFormAsync(complemento, Form(Text("cpf", sensitive: true, readOnly: true), Text("obs", visibleWhenFilled: "cpf")));
        Assert.Equal(HttpStatusCode.Created, (await _s.TryPublishAsync(id)).StatusCode);
    }

    [Fact]
    public async Task A_form_condition_reading_its_own_sensitive_field_publishes()
    {
        var proposta = await _s.PublishFormAsync("Proposta", Form(Text("cpf", sensitive: true), Text("obs", visibleWhenFilled: "cpf")));
        var complemento = await _s.PublishFormAsync("Complemento", Form(Text("renda")));

        await _s.PublishAsync("Crédito sigiloso", Workflow(proposta, complemento));
    }

    [Fact]
    public async Task WF209_a_computed_field_that_reads_a_sensitive_key_must_be_sensitive()
    {
        var proposta = await _s.PublishFormAsync("Proposta", Form(Text("cpf", sensitive: true), Copy("copia", from: "cpf", sensitive: false)));
        var complemento = await _s.PublishFormAsync("Complemento", Form(Text("renda")));
        var id = await _s.DraftAsync("Crédito sigiloso", Workflow(proposta, complemento));

        Assert.Contains(("WF209", "start"), await PublishErrorsAsync(await _s.TryPublishAsync(id)));

        await _s.RepublishFormAsync(proposta, Form(Text("cpf", sensitive: true), Copy("copia", from: "cpf", sensitive: true)));
        Assert.Equal(HttpStatusCode.Created, (await _s.TryPublishAsync(id)).StatusCode);
    }

    [Fact]
    public async Task WF210_a_sensitive_value_goes_into_a_sub_workflow_only_through_a_sensitive_key()
    {
        var documento = await _s.PublishFormAsync("Documento", Form(Text("documento")));
        var child = await _s.PublishAsync("Consulta", Child(documento));
        var proposta = await _s.PublishFormAsync("Proposta", Form(Text("cpf", sensitive: true)));
        var id = await _s.DraftAsync("Crédito sigiloso", Parent(proposta, child, new JsonObject { ["documento"] = PathTo("cpf") }, []));

        Assert.Contains(("WF210", "sub"), await PublishErrorsAsync(await _s.TryPublishAsync(id)));

        await _s.RepublishFormAsync(documento, Form(Text("documento", sensitive: true)));
        Assert.Equal(HttpStatusCode.Created, (await _s.TryPublishAsync(child)).StatusCode); // the child's next version marks it
        Assert.Equal(HttpStatusCode.Created, (await _s.TryPublishAsync(id)).StatusCode);
    }

    [Fact]
    public async Task WF210_a_sensitive_value_comes_back_from_a_sub_workflow_only_into_a_sensitive_key()
    {
        var documento = await _s.PublishFormAsync("Documento", Form(Text("documento", sensitive: true)));
        var child = await _s.PublishAsync("Consulta", Child(documento));
        var literal = new JsonObject { ["kind"] = "literal", ["type"] = "text", ["value"] = "529.982.247-25" };
        var outputs = new JsonObject { ["copia"] = PathTo("documento") };
        var id = await _s.DraftAsync("Crédito sigiloso", Parent(null, child, new JsonObject { ["documento"] = literal }, outputs));

        Assert.Contains(("WF210", "sub"), await PublishErrorsAsync(await _s.TryPublishAsync(id)));

        var revisao = await _s.PublishFormAsync("Revisão", Form(Text("copia", sensitive: true, readOnly: true)));
        await _s.SaveDraftAsync(id, Parent(null, child, new JsonObject { ["documento"] = literal.DeepClone() }, (JsonObject)outputs.DeepClone(), reviewForm: revisao));
        Assert.Equal(HttpStatusCode.Created, (await _s.TryPublishAsync(id)).StatusCode);
    }
}
