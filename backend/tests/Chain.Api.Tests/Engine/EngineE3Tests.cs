using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Chain.Api.Tests.Infrastructure;
using static Chain.Api.Tests.Engine.CreditScenario;

namespace Chain.Api.Tests.Engine;

/// <summary>Acceptance criteria of engine increment E3, sub-workflows (workflow-engine.md §14).</summary>
[Collection(PostgresTestGroup.Name)]
public sealed class EngineE3Tests(PostgresFixture postgres) : IAsyncLifetime, IDisposable
{
    private readonly ChainApiFactory _factory = new(postgres.ConnectionString);
    private CreditScenario _s = null!;
    private Guid _proposta;
    private Guid _child;
    private Guid _comercial;

    public async Task InitializeAsync()
    {
        await _factory.ResetDatabaseAsync();
        _s = await CreditScenario.CreateAsync(_factory);
        _comercial = Id(Assert.Single((await _s.Ana.GetFromJsonAsync<JsonElement>("/api/auth/me")).GetProperty("groups").EnumerateArray()));
        _proposta = await _s.PublishFormAsync("Proposta", new JsonObject
        {
            ["schemaVersion"] = 1,
            ["components"] = new JsonArray
            {
                new JsonObject { ["type"] = "number", ["key"] = "valor", ["label"] = "Valor", ["validate"] = new JsonObject { ["required"] = true } },
            },
        });
        _child = await _s.PublishAsync("Análise de risco", ChildDocument(_s.Analistas)); // no grants: only parents start it
    }

    public Task DisposeAsync() => Task.CompletedTask;

    public void Dispose()
    {
        _s?.Dispose();
        _factory.Dispose();
    }

    /// <summary>Child: start → "Avaliar risco" (Analistas) → automatic "valor &gt; 30000?" → end either way.</summary>
    private static JsonObject ChildDocument(Guid analistas) => new()
    {
        ["schemaVersion"] = 1,
        ["lanes"] = new JsonArray
        {
            new JsonObject { ["id"] = "lane_an", ["title"] = "Análise", ["group"] = new JsonObject { ["kind"] = "group", ["groupId"] = analistas.ToString() } },
        },
        ["nodes"] = new JsonArray
        {
            new JsonObject { ["id"] = "start", ["type"] = "start", ["label"] = "Início" },
            new JsonObject { ["id"] = "risk", ["type"] = "task", ["taskKind"] = "human", ["label"] = "Avaliar risco", ["laneId"] = "lane_an" },
            new JsonObject
            {
                ["id"] = "gw", ["type"] = "gateway", ["label"] = "Alto?", ["laneId"] = "lane_an", ["decisionMode"] = "automatic",
                ["condition"] = new JsonObject
                {
                    ["kind"] = "compare", ["left"] = Path("valor"), ["operator"] = "greaterThan",
                    ["right"] = new JsonObject { ["kind"] = "literal", ["type"] = "number", ["value"] = "30000" },
                },
            },
            new JsonObject { ["id"] = "end", ["type"] = "end", ["label"] = "Fim" },
        },
        ["flows"] = new JsonArray
        {
            new JsonObject { ["id"] = "f1", ["source"] = "start", ["target"] = "risk" },
            new JsonObject { ["id"] = "f2", ["source"] = "risk", ["target"] = "gw" },
            new JsonObject { ["id"] = "f3", ["source"] = "gw", ["target"] = "end", ["branch"] = "true" },
            new JsonObject { ["id"] = "f4", ["source"] = "gw", ["target"] = "end", ["branch"] = "false" },
        },
    };

    /// <summary>Parent: start (Proposta) → "sub" (child, with <paramref name="valorInput"/>) → "Revisar" (Analistas) → end.</summary>
    private async Task<Guid> PublishParentAsync(JsonObject valorInput)
    {
        var document = new JsonObject
        {
            ["schemaVersion"] = 1,
            ["lanes"] = new JsonArray
            {
                new JsonObject { ["id"] = "lane_an", ["title"] = "Análise", ["group"] = new JsonObject { ["kind"] = "group", ["groupId"] = _s.Analistas.ToString() } },
            },
            ["nodes"] = new JsonArray
            {
                new JsonObject { ["id"] = "start", ["type"] = "start", ["label"] = "Início", ["form"] = new JsonObject { ["formId"] = _proposta.ToString() } },
                new JsonObject
                {
                    ["id"] = "sub", ["type"] = "task", ["taskKind"] = "subprocess", ["label"] = "Análise de risco",
                    ["workflow"] = new JsonObject
                    {
                        ["workflowId"] = _child.ToString(),
                        ["inputs"] = new JsonObject { ["valor"] = valorInput },
                        ["outputs"] = new JsonObject
                        {
                            ["limite"] = new JsonObject { ["kind"] = "arithmetic", ["op"] = "multiply", ["left"] = Path("valor"), ["right"] = Number("2") },
                        },
                    },
                },
                new JsonObject { ["id"] = "review", ["type"] = "task", ["taskKind"] = "human", ["label"] = "Revisar", ["laneId"] = "lane_an" },
                new JsonObject { ["id"] = "end", ["type"] = "end", ["label"] = "Fim" },
            },
            ["flows"] = new JsonArray
            {
                new JsonObject { ["id"] = "f1", ["source"] = "start", ["target"] = "sub" },
                new JsonObject { ["id"] = "f2", ["source"] = "sub", ["target"] = "review" },
                new JsonObject { ["id"] = "f3", ["source"] = "review", ["target"] = "end" },
            },
        };
        var id = await _s.PublishAsync($"Crédito com risco {Guid.NewGuid():N}", document);
        await _s.GrantAsync(id, [(_comercial, "start")]);
        return id;
    }

    private static JsonObject Path(string key) => new() { ["kind"] = "path", ["path"] = new JsonArray(key) };

    private static JsonObject Number(string value) => new() { ["kind"] = "literal", ["type"] = "number", ["value"] = value };

    private async Task<(Guid Parent, Guid Child)> StartParentAsync(Guid definition, decimal valor)
    {
        var response = await StartWithDataAsync(_s.Ana, definition, new JsonObject { ["valor"] = valor });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var parent = await response.Content.ReadFromJsonAsync<JsonElement>();
        return (Id(parent), Id(parent.GetProperty("children").EnumerateArray().Last()));
    }

    private static Task<JsonElement> GetAsync(HttpClient client, Guid instanceId) => client.GetFromJsonAsync<JsonElement>($"/api/instances/{instanceId}");

    private static string Status(JsonElement instance) => instance.GetProperty("status").GetString()!;

    private static IEnumerable<string> Events(JsonElement instance) => instance.GetProperty("timeline").EnumerateArray().Select(e => e.GetProperty("type").GetString()!);

    // 1. Inputs, waiting, outputs

    [Fact]
    public async Task Child_runs_with_mapped_inputs_and_returns_mapped_outputs()
    {
        var definition = await PublishParentAsync(Path("valor"));
        var (parentId, childId) = await StartParentAsync(definition, 50000);

        var parent = await GetAsync(_s.Ana, parentId);
        Assert.Equal("running", Status(parent));
        Assert.Equal("sub", parent.GetProperty("currentNodeId").GetString());
        Assert.Empty(parent.GetProperty("openTasks").EnumerateArray());
        Assert.Contains("subprocess.started", Events(parent));

        var child = await GetAsync(_s.Ana, childId);
        Assert.Equal(parentId, child.GetProperty("parent").GetProperty("id").GetGuid());
        Assert.Equal("sub", child.GetProperty("parent").GetProperty("nodeId").GetString());
        Assert.Equal("ana", child.GetProperty("requester").GetProperty("username").GetString()); // S-1
        Assert.Equal(50000m, child.GetProperty("data").GetProperty("valor").GetDecimal());

        var done = await CompleteAsync(_s.Bruno, Id(await OpenTaskAsync(_s.Bruno, childId)));
        Assert.Equal("completed", Status(await done.Content.ReadFromJsonAsync<JsonElement>()));

        parent = await GetAsync(_s.Ana, parentId);
        Assert.Equal("running", Status(parent));
        Assert.Equal(100000m, parent.GetProperty("data").GetProperty("limite").GetDecimal());
        Assert.False(parent.GetProperty("data").TryGetProperty("risk", out _));
        Assert.Equal("review", Assert.Single(parent.GetProperty("openTasks").EnumerateArray()).GetProperty("nodeId").GetString());
        Assert.Contains("subprocess.completed", Events(parent));
        Assert.Equal("completed", Assert.Single(parent.GetProperty("children").EnumerateArray()).GetProperty("status").GetString());
    }

    [Fact]
    public async Task Parent_viewers_see_the_child()
    {
        var definition = await PublishParentAsync(Path("valor"));
        var (_, childId) = await StartParentAsync(definition, 50000);

        var leitores = await _s.GroupAsync("Leitores");
        await _s.UserAsync("gil", leitores);
        await _s.GrantAsync(definition, [(_comercial, "start"), (leitores, "view")]); // view on the parent only

        Assert.Equal(HttpStatusCode.OK, (await _s.Browsers["gil"].GetAsync($"/api/instances/{childId}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _s.Fabio.GetAsync($"/api/instances/{childId}")).StatusCode);
    }

    // 2. Faults (E-6)

    [Fact]
    public async Task Child_fault_faults_the_parent_and_cancelling_the_parent_cancels_the_child()
    {
        var definition = await PublishParentAsync(new JsonObject { ["kind"] = "literal", ["type"] = "text", ["value"] = "abc" });
        var (parentId, childId) = await StartParentAsync(definition, 50000);

        await CompleteAsync(_s.Bruno, Id(await OpenTaskAsync(_s.Bruno, childId))); // text > number: the child's gateway fails

        Assert.Equal("faulted", Status(await GetAsync(_s.Admin, childId)));
        var parent = await GetAsync(_s.Admin, parentId);
        Assert.Equal("faulted", Status(parent));
        Assert.Equal("subprocess_faulted", Assert.Single(parent.GetProperty("incidents").EnumerateArray()).GetProperty("code").GetString());
        var fault = parent.GetProperty("timeline").EnumerateArray().Single(e => e.GetProperty("type").GetString() == "instance.faulted").GetProperty("details");
        Assert.Equal("sub|Análise de risco|subprocess_faulted", $"{fault.GetProperty("nodeId")}|{fault.GetProperty("label")}|{fault.GetProperty("code")}"); // card #219

        var retry = await PostAsync(_s.Admin, $"/api/instances/{parentId}/retry", null, NewKey());
        await retry.AssertProblemAsync(HttpStatusCode.Conflict, "retry_failed");

        Assert.Equal(HttpStatusCode.OK, (await CloseAsync(_s.Admin, parentId, "Proposta descartada")).StatusCode);
        Assert.Equal("cancelled", Status(await GetAsync(_s.Admin, parentId)));
        var child = await GetAsync(_s.Admin, childId);
        Assert.Equal("cancelled", Status(child));
        Assert.All(child.GetProperty("incidents").EnumerateArray(), i => Assert.Equal("cancelled", i.GetProperty("resolution").GetString()));
    }

    [Fact]
    public async Task Fixed_child_resumes_and_completes_the_waiting_parent()
    {
        var definition = await PublishParentAsync(new JsonObject { ["kind"] = "literal", ["type"] = "text", ["value"] = "abc" });
        var (parentId, childId) = await StartParentAsync(definition, 50000);
        await CompleteAsync(_s.Bruno, Id(await OpenTaskAsync(_s.Bruno, childId)));

        // The child has no start form, so "valor" came from the parent's inputs and takes any value (workflow-engine.md §16, Q-N10).
        var corrected = await CorrectAsync(_s.Admin, childId, await CurrentETagAsync(_s.Admin, childId),
            new { changes = new JsonObject { ["valor"] = 7 }, justification = "Valor de risco informado como texto." });
        Assert.Equal(HttpStatusCode.OK, corrected.StatusCode);
        var retried = await PostAsync(_s.Admin, $"/api/instances/{childId}/retry", null, NewKey());
        Assert.Equal(HttpStatusCode.OK, retried.StatusCode);

        var parent = await GetAsync(_s.Admin, parentId);
        Assert.Equal("running", Status(parent));
        Assert.Equal(14m, parent.GetProperty("data").GetProperty("limite").GetDecimal());
        Assert.Equal("child_completed", Assert.Single(parent.GetProperty("incidents").EnumerateArray()).GetProperty("resolution").GetString());
        Assert.Equal("review", Assert.Single(parent.GetProperty("openTasks").EnumerateArray()).GetProperty("nodeId").GetString());
    }

    // Regression #129: a child's inputs take any value and are stored as sent, and PostgreSQL jsonb cannot store the NUL
    // character, so correcting one with it was a 500.

    [Fact]
    public async Task A_child_input_corrected_with_the_NUL_character_is_a_field_error()
    {
        var definition = await PublishParentAsync(new JsonObject { ["kind"] = "literal", ["type"] = "text", ["value"] = "abc" });
        var (_, childId) = await StartParentAsync(definition, 50000);
        await CompleteAsync(_s.Bruno, Id(await OpenTaskAsync(_s.Bruno, childId)));

        var corrected = await CorrectAsync(_s.Admin, childId, await CurrentETagAsync(_s.Admin, childId),
            new { changes = new JsonObject { ["valor"] = "sete\u0000" }, justification = "Valor de risco informado como texto." });

        Assert.Equal(HttpStatusCode.UnprocessableEntity, corrected.StatusCode);
        var problem = await corrected.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("correction_invalid", problem.GetProperty("code").GetString());
        var error = Assert.Single(problem.GetProperty("errors").EnumerateArray());
        Assert.Equal(("valor", "invalid_value"), (error.GetProperty("key").GetString(), error.GetProperty("code").GetString()));
        Assert.Equal("abc", (await GetAsync(_s.Admin, childId)).GetProperty("data").GetProperty("valor").GetString());
    }

    [Fact]
    public async Task Cancelled_child_faults_the_parent_and_a_retry_starts_a_new_child()
    {
        var definition = await PublishParentAsync(Path("valor"));
        var (parentId, childId) = await StartParentAsync(definition, 50000);

        Assert.Equal(HttpStatusCode.OK, (await CloseAsync(_s.Ana, childId, "Desisti da análise")).StatusCode);
        var parent = await GetAsync(_s.Ana, parentId);
        Assert.Equal("faulted", Status(parent));
        Assert.Equal("subprocess_cancelled", Assert.Single(parent.GetProperty("incidents").EnumerateArray()).GetProperty("code").GetString());

        var retried = await PostAsync(_s.Admin, $"/api/instances/{parentId}/retry", null, NewKey());
        Assert.Equal(HttpStatusCode.OK, retried.StatusCode);

        parent = await GetAsync(_s.Admin, parentId);
        Assert.Equal("running", Status(parent));
        var children = parent.GetProperty("children").EnumerateArray().ToList();
        Assert.Equal(["cancelled", "running"], children.Select(Status));
        Assert.Equal(50000m, (await GetAsync(_s.Admin, Id(children[1]))).GetProperty("data").GetProperty("valor").GetDecimal());
    }

    [Fact]
    public async Task Invalid_inputs_fault_the_parent_before_starting_a_child()
    {
        var withForm = ChildDocument(_s.Analistas);
        withForm["nodes"]![0]!["form"] = new JsonObject { ["formId"] = _proposta.ToString() };
        _child = await _s.PublishAsync("Análise com formulário", withForm);
        var definition = await PublishParentAsync(Path("prazo")); // missing in the parent: the start form's required "valor" is absent at runtime

        var response = await StartWithDataAsync(_s.Ana, definition, new JsonObject { ["valor"] = 50000 });
        var parent = await response.Content.ReadFromJsonAsync<JsonElement>();

        Assert.Equal("faulted", Status(parent));
        Assert.Equal("subprocess_input_invalid", Assert.Single(parent.GetProperty("incidents").EnumerateArray()).GetProperty("code").GetString());
        Assert.Empty(parent.GetProperty("children").EnumerateArray());
    }

    // 3. Data correction (workflow-engine.md §16.5)

    [Fact]
    public async Task Corrected_parent_data_feeds_the_inputs_of_a_new_child()
    {
        var faixa = await _s.PublishFormAsync("Faixa", new JsonObject
        {
            ["schemaVersion"] = 1,
            ["components"] = new JsonArray
            {
                new JsonObject { ["type"] = "number", ["key"] = "valor", ["label"] = "Valor", ["validate"] = new JsonObject { ["required"] = true, ["min"] = 10000 } },
            },
        });
        var withForm = ChildDocument(_s.Analistas);
        withForm["nodes"]![0]!["form"] = new JsonObject { ["formId"] = faixa.ToString() };
        _child = await _s.PublishAsync("Análise de faixa", withForm);
        var definition = await PublishParentAsync(Path("valor"));
        var response = await StartWithDataAsync(_s.Ana, definition, new JsonObject { ["valor"] = 500 }); // below the child's minimum
        var parentId = Id(await response.Content.ReadFromJsonAsync<JsonElement>());
        Assert.Equal("subprocess_input_invalid", Assert.Single((await GetAsync(_s.Admin, parentId)).GetProperty("incidents").EnumerateArray()).GetProperty("code").GetString());

        var corrected = await CorrectAsync(_s.Admin, parentId, await CurrentETagAsync(_s.Admin, parentId),
            new { changes = new JsonObject { ["valor"] = 20000 }, justification = "Valor em milhares." });
        Assert.Equal(HttpStatusCode.OK, corrected.StatusCode);
        var retried = await PostAsync(_s.Admin, $"/api/instances/{parentId}/retry", null, NewKey());

        Assert.Equal(HttpStatusCode.OK, retried.StatusCode);
        var parent = await retried.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("running", Status(parent));
        var child = await GetAsync(_s.Admin, Id(Assert.Single(parent.GetProperty("children").EnumerateArray())));
        Assert.Equal(20000m, child.GetProperty("data").GetProperty("valor").GetDecimal());
    }

    [Fact]
    public async Task Corrected_completed_child_lets_the_parent_merge_its_outputs()
    {
        // The child ends right after its task, so "abc" reaches the parent's output "valor × 2", which fails.
        var straight = ChildDocument(_s.Analistas);
        straight["nodes"]!.AsArray().RemoveAt(2);
        straight["flows"] = new JsonArray
        {
            new JsonObject { ["id"] = "f1", ["source"] = "start", ["target"] = "risk" },
            new JsonObject { ["id"] = "f2", ["source"] = "risk", ["target"] = "end" },
        };
        _child = await _s.PublishAsync("Análise direta", straight);
        var definition = await PublishParentAsync(new JsonObject { ["kind"] = "literal", ["type"] = "text", ["value"] = "abc" });
        var (parentId, childId) = await StartParentAsync(definition, 50000);
        await CompleteAsync(_s.Bruno, Id(await OpenTaskAsync(_s.Bruno, childId)));
        Assert.Equal("completed", Status(await GetAsync(_s.Admin, childId)));
        Assert.Equal("subprocess_output_invalid", Assert.Single((await GetAsync(_s.Admin, parentId)).GetProperty("incidents").EnumerateArray()).GetProperty("code").GetString());

        // The parent can't fix this: its retry re-reads the child's data.
        var parentCorrection = await CorrectAsync(_s.Admin, parentId, await CurrentETagAsync(_s.Admin, parentId),
            new { changes = new JsonObject { ["limite"] = 1 }, justification = "Tentativa no pai." });
        Assert.Equal(HttpStatusCode.OK, parentCorrection.StatusCode);
        await (await PostAsync(_s.Admin, $"/api/instances/{parentId}/retry", null, NewKey())).AssertProblemAsync(HttpStatusCode.Conflict, "retry_failed");

        var corrected = await CorrectAsync(_s.Admin, childId, await CurrentETagAsync(_s.Admin, childId),
            new { changes = new JsonObject { ["valor"] = 21 }, justification = "Valor de risco informado como texto." });
        Assert.Equal(HttpStatusCode.OK, corrected.StatusCode);
        Assert.Equal("completed", Status(await corrected.Content.ReadFromJsonAsync<JsonElement>())); // the child stays completed

        var retried = await PostAsync(_s.Admin, $"/api/instances/{parentId}/retry", null, NewKey());
        Assert.Equal(HttpStatusCode.OK, retried.StatusCode);
        var parent = await retried.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("running", Status(parent));
        Assert.Equal(42m, parent.GetProperty("data").GetProperty("limite").GetDecimal());
        Assert.Equal("review", Assert.Single(parent.GetProperty("openTasks").EnumerateArray()).GetProperty("nodeId").GetString());

        // Now that the parent no longer waits on it, the completed child can't be corrected (Q-N8).
        await (await CorrectAsync(_s.Admin, childId, await CurrentETagAsync(_s.Admin, childId),
            new { changes = new JsonObject { ["valor"] = 22 }, justification = "De novo." })).AssertProblemAsync(HttpStatusCode.Conflict, "instance_not_faulted");
    }

    [Fact]
    public async Task Only_the_child_the_parent_faulted_on_can_be_corrected_once_completed()
    {
        // Parent: start → "sub1" (valid input) → "sub2" (text input, so its output fails) → end; both children end after one task.
        var straight = ChildDocument(_s.Analistas);
        straight["nodes"]!.AsArray().RemoveAt(2);
        straight["flows"] = new JsonArray
        {
            new JsonObject { ["id"] = "f1", ["source"] = "start", ["target"] = "risk" },
            new JsonObject { ["id"] = "f2", ["source"] = "risk", ["target"] = "end" },
        };
        _child = await _s.PublishAsync("Análise direta", straight);
        JsonObject Call(string id, JsonObject input) => new()
        {
            ["id"] = id, ["type"] = "task", ["taskKind"] = "subprocess", ["label"] = id,
            ["workflow"] = new JsonObject
            {
                ["workflowId"] = _child.ToString(),
                ["inputs"] = new JsonObject { ["valor"] = input },
                ["outputs"] = new JsonObject { [$"limite_{id}"] = new JsonObject { ["kind"] = "arithmetic", ["op"] = "multiply", ["left"] = Path("valor"), ["right"] = Number("2") } },
            },
        };
        var parentDocument = new JsonObject
        {
            ["schemaVersion"] = 1,
            ["lanes"] = new JsonArray(),
            ["nodes"] = new JsonArray
            {
                new JsonObject { ["id"] = "start", ["type"] = "start", ["label"] = "Início", ["form"] = new JsonObject { ["formId"] = _proposta.ToString() } },
                Call("sub1", Path("valor")),
                Call("sub2", new JsonObject { ["kind"] = "literal", ["type"] = "text", ["value"] = "abc" }),
                new JsonObject { ["id"] = "end", ["type"] = "end", ["label"] = "Fim" },
            },
            ["flows"] = new JsonArray
            {
                new JsonObject { ["id"] = "f1", ["source"] = "start", ["target"] = "sub1" },
                new JsonObject { ["id"] = "f2", ["source"] = "sub1", ["target"] = "sub2" },
                new JsonObject { ["id"] = "f3", ["source"] = "sub2", ["target"] = "end" },
            },
        };
        var definition = await _s.PublishAsync("Duas análises", parentDocument);
        await _s.GrantAsync(definition, [(_comercial, "start")]);
        var (parentId, firstChild) = await StartParentAsync(definition, 50000);
        await CompleteAsync(_s.Bruno, Id(await OpenTaskAsync(_s.Bruno, firstChild)));
        var secondChild = Id((await GetAsync(_s.Admin, parentId)).GetProperty("children").EnumerateArray().Last());
        await CompleteAsync(_s.Bruno, Id(await OpenTaskAsync(_s.Bruno, secondChild)));
        Assert.Equal("subprocess_output_invalid", Assert.Single((await GetAsync(_s.Admin, parentId)).GetProperty("incidents").EnumerateArray()).GetProperty("code").GetString());

        var body = new { changes = new JsonObject { ["valor"] = 3 }, justification = "Correção." };
        await (await CorrectAsync(_s.Admin, firstChild, await CurrentETagAsync(_s.Admin, firstChild), body)).AssertProblemAsync(HttpStatusCode.Conflict, "instance_not_faulted");
        Assert.Equal(HttpStatusCode.OK, (await CorrectAsync(_s.Admin, secondChild, await CurrentETagAsync(_s.Admin, secondChild), body)).StatusCode);
    }

    [Fact]
    public async Task Concurrent_parent_close_and_child_completion_do_not_deadlock()
    {
        var definition = await PublishParentAsync(Path("valor"));
        for (var round = 0; round < 5; round++)
        {
            var (parentId, childId) = await StartParentAsync(definition, 50000);
            var task = Id(await OpenTaskAsync(_s.Bruno, childId));

            var responses = await Task.WhenAll(CloseAsync(_s.Ana, parentId, "Cancelado"), CompleteAsync(_s.Bruno, task));

            // Losing the race is a clean refusal (409, or 404 once Bruno's only reason to see the child, its open task, is gone); never a 500.
            Assert.All(responses, r => Assert.True(r.StatusCode is HttpStatusCode.OK or HttpStatusCode.Conflict or HttpStatusCode.NotFound, $"{r.StatusCode}"));
            Assert.Equal(HttpStatusCode.OK, responses[0].StatusCode);
            Assert.Equal("cancelled", Status(await GetAsync(_s.Ana, parentId)));
            Assert.True(Status(await GetAsync(_s.Ana, childId)) is "cancelled" or "completed");
        }
    }

    // 3. Depth guard

    [Fact]
    public async Task Nesting_deeper_than_ten_levels_faults()
    {
        var empty = new JsonObject
        {
            ["schemaVersion"] = 1,
            ["lanes"] = new JsonArray(),
            ["nodes"] = new JsonArray
            {
                new JsonObject { ["id"] = "start", ["type"] = "start", ["label"] = "Início" },
                new JsonObject { ["id"] = "end", ["type"] = "end", ["label"] = "Fim" },
            },
            ["flows"] = new JsonArray { new JsonObject { ["id"] = "f1", ["source"] = "start", ["target"] = "end" } },
        };
        var levels = new List<Guid> { await _s.PublishAsync("Nível 0", empty) };
        for (var level = 1; level <= 11; level++)
        {
            var calling = new JsonObject
            {
                ["schemaVersion"] = 1,
                ["lanes"] = new JsonArray(),
                ["nodes"] = new JsonArray
                {
                    new JsonObject { ["id"] = "start", ["type"] = "start", ["label"] = "Início" },
                    new JsonObject { ["id"] = "sub", ["type"] = "task", ["taskKind"] = "subprocess", ["label"] = "Chamar", ["workflow"] = new JsonObject { ["workflowId"] = levels[^1].ToString() } },
                    new JsonObject { ["id"] = "end", ["type"] = "end", ["label"] = "Fim" },
                },
                ["flows"] = new JsonArray
                {
                    new JsonObject { ["id"] = "f1", ["source"] = "start", ["target"] = "sub" },
                    new JsonObject { ["id"] = "f2", ["source"] = "sub", ["target"] = "end" },
                },
            };
            var id = await _s.PublishAsync($"Nível {level}", calling);
            await _s.GrantAsync(id, [(_comercial, "start")]);
            levels.Add(id);
        }

        var ten = await (await StartAsync(_s.Ana, levels[10])).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("completed", Status(ten)); // ten nested children, all finishing in the same command

        var eleven = await (await StartAsync(_s.Ana, levels[11])).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("faulted", Status(eleven));
        var deepest = await _factory.QueryAsync("SELECT i.id FROM chain.instance_incidents i WHERE i.code = 'depth_limit'");
        Assert.Single(deepest);
    }
}
