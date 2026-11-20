using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Chain.Api.Tests.Infrastructure;
using static Chain.Api.Tests.Engine.CreditScenario;

namespace Chain.Api.Tests.Engine;

/// <summary>Acceptance criteria of engine increment E2 (workflow-engine.md §13).</summary>
[Collection(PostgresTestGroup.Name)]
public sealed class EngineE2Tests(PostgresFixture postgres) : IAsyncLifetime, IDisposable
{
    private readonly ChainApiFactory _factory = new(postgres.ConnectionString);
    private CreditScenario _s = null!;

    public async Task InitializeAsync()
    {
        await _factory.ResetDatabaseAsync();
        _s = await CreditScenario.CreateAsync(_factory, async s =>
        {
            var proposta = await s.PublishFormAsync("Proposta", new JsonObject
            {
                ["schemaVersion"] = 1,
                ["components"] = new JsonArray
                {
                    new JsonObject { ["type"] = "text", ["key"] = "cpf", ["label"] = "CPF", ["validate"] = new JsonObject { ["required"] = true, ["format"] = "cpf" } },
                    new JsonObject { ["type"] = "number", ["key"] = "valor", ["label"] = "Valor", ["validate"] = new JsonObject { ["required"] = true, ["min"] = 1000 } },
                    new JsonObject { ["type"] = "textarea", ["key"] = "observacao", ["label"] = "Observação" },
                },
            });
            var analise = await s.PublishFormAsync("Análise", new JsonObject
            {
                ["schemaVersion"] = 1,
                ["components"] = new JsonArray
                {
                    new JsonObject { ["type"] = "textarea", ["key"] = "parecer", ["label"] = "Parecer", ["validate"] = new JsonObject { ["required"] = true } },
                },
            });
            return Document(s.Analistas, proposta, analise);
        });
    }

    public Task DisposeAsync() => Task.CompletedTask;

    public void Dispose()
    {
        _s?.Dispose();
        _factory.Dispose();
    }

    /// <summary>start (Proposta) → analyse (Análise) → big? (automatic: valor &gt; 30000) true → approve? (human) / false → end; approve? false → analyse.</summary>
    private static JsonObject Document(Guid analistas, Guid proposta, Guid analise) => new()
    {
        ["schemaVersion"] = 1,
        ["lanes"] = new JsonArray
        {
            new JsonObject { ["id"] = "lane_an", ["title"] = "Análise", ["group"] = new JsonObject { ["kind"] = "group", ["groupId"] = analistas.ToString() } },
        },
        ["nodes"] = new JsonArray
        {
            new JsonObject { ["id"] = "start", ["type"] = "start", ["label"] = "Início", ["form"] = new JsonObject { ["formId"] = proposta.ToString() } },
            new JsonObject { ["id"] = "analyse", ["type"] = "task", ["taskKind"] = "human", ["label"] = "Analisar", ["laneId"] = "lane_an", ["form"] = new JsonObject { ["formId"] = analise.ToString() } },
            new JsonObject
            {
                ["id"] = "big", ["type"] = "gateway", ["label"] = "Valor alto?", ["laneId"] = "lane_an", ["decisionMode"] = "automatic",
                ["condition"] = new JsonObject
                {
                    ["kind"] = "compare", ["left"] = new JsonObject { ["kind"] = "path", ["path"] = new JsonArray("valor") },
                    ["operator"] = "greaterThan", ["right"] = new JsonObject { ["kind"] = "literal", ["type"] = "number", ["value"] = "30000" },
                },
            },
            new JsonObject { ["id"] = "approve", ["type"] = "gateway", ["label"] = "Aprovar?", ["laneId"] = "lane_an", ["decisionMode"] = "human", ["question"] = "Aprovar a proposta?" },
            new JsonObject { ["id"] = "end", ["type"] = "end", ["label"] = "Fim" },
        },
        ["flows"] = new JsonArray
        {
            new JsonObject { ["id"] = "f1", ["source"] = "start", ["target"] = "analyse" },
            new JsonObject { ["id"] = "f2", ["source"] = "analyse", ["target"] = "big" },
            new JsonObject { ["id"] = "f3", ["source"] = "big", ["target"] = "approve", ["branch"] = "true" },
            new JsonObject { ["id"] = "f4", ["source"] = "big", ["target"] = "end", ["branch"] = "false" },
            new JsonObject { ["id"] = "f5", ["source"] = "approve", ["target"] = "end", ["branch"] = "true" },
            new JsonObject { ["id"] = "f6", ["source"] = "approve", ["target"] = "analyse", ["branch"] = "false" },
        },
    };

    private static JsonObject Proposal(decimal valor) => new() { ["cpf"] = "529.982.247-25", ["valor"] = valor };

    private async Task<Guid> StartAsync(decimal valor)
    {
        var response = await StartWithDataAsync(_s.Ana, _s.DefinitionId, Proposal(valor));
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return Id(await response.Content.ReadFromJsonAsync<JsonElement>());
    }

    // 1. Start form

    [Fact]
    public async Task Start_form_is_validated_and_stored()
    {
        var invalid = await StartWithDataAsync(_s.Ana, _s.DefinitionId, new JsonObject { ["cpf"] = "111.111.111-11", ["valor"] = 10 });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, invalid.StatusCode);
        var problem = await invalid.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("submission_invalid", problem.GetProperty("code").GetString());
        var errors = problem.GetProperty("errors").EnumerateArray().Select(e => (e.GetProperty("key").GetString(), e.GetProperty("code").GetString())).ToList();
        Assert.Contains(("cpf", "invalid_format"), errors);
        Assert.Contains(("valor", "too_small"), errors);
        Assert.Equal(0, await _factory.CountAsync("SELECT count(*) FROM chain.instances"));

        var instanceId = await StartAsync(15000);

        var instance = await _s.Ana.GetFromJsonAsync<JsonElement>($"/api/instances/{instanceId}");
        Assert.Equal("529.982.247-25", instance.GetProperty("data").GetProperty("cpf").GetString());
        Assert.Contains(instance.GetProperty("timeline").EnumerateArray(), e => e.GetProperty("type").GetString() == "form.submitted");
        Assert.Equal(1, await _factory.CountAsync($"SELECT count(*) FROM chain.instance_submissions WHERE instance_id = '{instanceId}' AND task_id IS NULL AND form_version = 1"));
    }

    // 2. Task forms

    [Fact]
    public async Task Task_form_is_validated_merged_and_recorded()
    {
        var instanceId = await StartAsync(15000);
        var analyse = Id(await OpenTaskAsync(_s.Bruno, instanceId));

        var missing = await CompleteAsync(_s.Bruno, analyse, data: new JsonObject());
        Assert.Equal(HttpStatusCode.UnprocessableEntity, missing.StatusCode);
        Assert.Equal("analyse", (await OpenTaskAsync(_s.Bruno, instanceId)).GetProperty("nodeId").GetString());

        var done = await CompleteAsync(_s.Bruno, analyse, data: new JsonObject { ["parecer"] = "Documentação completa." });
        Assert.Equal(HttpStatusCode.OK, done.StatusCode);

        var instance = await done.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("Documentação completa.", instance.GetProperty("data").GetProperty("parecer").GetString());
        Assert.Equal(15000m, instance.GetProperty("data").GetProperty("valor").GetDecimal());
        Assert.Equal(2, await _factory.CountAsync($"SELECT count(*) FROM chain.instance_submissions WHERE instance_id = '{instanceId}'"));
    }

    [Fact]
    public async Task Data_on_a_step_without_form_is_rejected()
    {
        var plainScenarioWorkflow = await _s.PublishAsync("Sem formulário", CreditScenario.Document(_s.Analistas));
        await _s.GrantAsync(plainScenarioWorkflow, [(await AnaGroupAsync(), "start")]);
        var instanceId = Id(await (await StartWithDataAsync(_s.Ana, plainScenarioWorkflow, [])).Content.ReadFromJsonAsync<JsonElement>());
        var fill = Id(await OpenTaskAsync(_s.Ana, instanceId));

        await (await CompleteAsync(_s.Ana, fill, data: new JsonObject { ["x"] = 1 })).AssertProblemAsync(HttpStatusCode.UnprocessableEntity, "submission_invalid");
        await (await StartWithDataAsync(_s.Ana, plainScenarioWorkflow, new JsonObject { ["x"] = 1 })).AssertProblemAsync(HttpStatusCode.UnprocessableEntity, "submission_invalid");
    }

    // 3. Prefill

    [Fact]
    public async Task Reopened_step_is_prefilled_with_earlier_values()
    {
        var instanceId = await StartAsync(50000);
        await CompleteAsync(_s.Bruno, Id(await OpenTaskAsync(_s.Bruno, instanceId)), data: new JsonObject { ["parecer"] = "Primeira análise" });
        await DecideAsync(_s.Bruno, Id(await OpenTaskAsync(_s.Bruno, instanceId)), false);

        var again = Id(await OpenTaskAsync(_s.Bruno, instanceId));
        var detail = await _s.Bruno.GetFromJsonAsync<JsonElement>($"/api/tasks/{again}");

        Assert.Equal("analyse", detail.GetProperty("task").GetProperty("nodeId").GetString());
        Assert.Equal("Primeira análise", detail.GetProperty("prefill").GetProperty("parecer").GetString());
        Assert.Equal("parecer", detail.GetProperty("form").GetProperty("document").GetProperty("components")[0].GetProperty("key").GetString());
        Assert.Equal(1, detail.GetProperty("form").GetProperty("version").GetInt32());
    }

    // 4. Automatic gateways

    [Theory]
    [InlineData(15000, "completed")]
    [InlineData(50000, "running")]
    public async Task Automatic_gateway_follows_its_condition(int valor, string status)
    {
        var instanceId = await StartAsync(valor);
        var instance = await (await CompleteAsync(_s.Bruno, Id(await OpenTaskAsync(_s.Bruno, instanceId)), data: new JsonObject { ["parecer"] = "ok" }))
            .Content.ReadFromJsonAsync<JsonElement>();

        Assert.Equal(status, instance.GetProperty("status").GetString());
        var evaluated = instance.GetProperty("timeline").EnumerateArray().Single(e => e.GetProperty("type").GetString() == "gateway.evaluated");
        Assert.Equal(valor > 30000, evaluated.GetProperty("details").GetProperty("outcome").GetBoolean());
        Assert.Equal("big|Valor alto?", $"{evaluated.GetProperty("details").GetProperty("nodeId")}|{evaluated.GetProperty("details").GetProperty("label")}"); // card #219
    }

    // 5. Faults and incidents

    [Fact]
    public async Task Evaluation_error_faults_with_an_incident_and_admins_can_cancel()
    {
        // Division by zero fails regardless of data, and is well typed, so it passes the publish-time type check (WF201).
        var broken = await PublishFaultyAsync(new JsonObject
        {
            ["kind"] = "compare",
            ["left"] = new JsonObject
            {
                ["kind"] = "arithmetic", ["op"] = "divide",
                ["left"] = new JsonObject { ["kind"] = "literal", ["type"] = "number", ["value"] = "1" },
                ["right"] = new JsonObject { ["kind"] = "literal", ["type"] = "number", ["value"] = "0" },
            },
            ["operator"] = "greaterThan",
            ["right"] = new JsonObject { ["kind"] = "literal", ["type"] = "number", ["value"] = "1" },
        });
        var instanceId = Id(await (await StartWithDataAsync(_s.Ana, broken, [])).Content.ReadFromJsonAsync<JsonElement>());

        var faulted = await _s.Ana.GetFromJsonAsync<JsonElement>($"/api/instances/{instanceId}");
        Assert.Equal("faulted", faulted.GetProperty("status").GetString());
        var incident = Assert.Single(faulted.GetProperty("incidents").EnumerateArray());
        Assert.Equal("division_by_zero", incident.GetProperty("code").GetString());
        Assert.Equal("gw", incident.GetProperty("nodeId").GetString());
        var fault = faulted.GetProperty("timeline").EnumerateArray().Single(e => e.GetProperty("type").GetString() == "instance.faulted").GetProperty("details");
        Assert.Equal("gw|Teste|division_by_zero", $"{fault.GetProperty("nodeId")}|{fault.GetProperty("label")}|{fault.GetProperty("code")}"); // card #219

        await (await PostAsync(_s.Ana, $"/api/instances/{instanceId}/retry", null, NewKey())).AssertProblemAsync(HttpStatusCode.Forbidden, "forbidden");
        await (await PostAsync(_s.Admin, $"/api/instances/{instanceId}/retry", null, NewKey())).AssertProblemAsync(HttpStatusCode.Conflict, "retry_failed");
        var afterRetry = await _s.Admin.GetFromJsonAsync<JsonElement>($"/api/instances/{instanceId}");
        Assert.Equal("faulted", afterRetry.GetProperty("status").GetString()); // the failed retry changed nothing
        Assert.Single(afterRetry.GetProperty("incidents").EnumerateArray());

        Assert.Equal(HttpStatusCode.OK, (await CloseAsync(_s.Admin, instanceId, "Modelo com erro")).StatusCode);
        Assert.Equal("cancelled", (await _s.Admin.GetFromJsonAsync<JsonElement>($"/api/instances/{instanceId}")).GetProperty("status").GetString());
    }

    // Regression #68: .NET's \d matched non-ASCII digits, then int.Parse threw, so these were 500s.

    [Fact]
    public async Task Datetime_with_non_ascii_digits_is_a_field_error()
    {
        var form = await _s.PublishFormAsync("Agenda", new JsonObject
        {
            ["schemaVersion"] = 1,
            ["components"] = new JsonArray
            {
                new JsonObject { ["type"] = "datetime", ["key"] = "quando", ["label"] = "Quando", ["validate"] = new JsonObject { ["required"] = true } },
            },
        });
        var id = await PublishFaultyAsync(AfterNewYear("quando"), form);

        var response = await StartWithDataAsync(_s.Ana, id, new JsonObject { ["quando"] = "\u0662\u0660\u0662\u0666-10-15T13:00:00Z" });

        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("submission_invalid", problem.GetProperty("code").GetString());
        var error = Assert.Single(problem.GetProperty("errors").EnumerateArray());
        Assert.Equal(("quando", "type_mismatch"), (error.GetProperty("key").GetString(), error.GetProperty("code").GetString()));
        Assert.Equal(0, await _factory.CountAsync("SELECT count(*) FROM chain.instances"));
    }

    [Fact]
    public async Task Text_with_non_ascii_digits_compared_as_a_datetime_faults_with_an_incident()
    {
        var form = await _s.PublishFormAsync("Prazo", new JsonObject
        {
            ["schemaVersion"] = 1,
            ["components"] = new JsonArray
            {
                new JsonObject { ["type"] = "text", ["key"] = "prazo", ["label"] = "Prazo", ["validate"] = new JsonObject { ["required"] = true } },
            },
        });
        var id = await PublishFaultyAsync(AfterNewYear("prazo"), form); // text beside a datetime passes WF201 (TC-4)

        var response = await StartWithDataAsync(_s.Ana, id, new JsonObject { ["prazo"] = "\u0662\u0660\u0662\u0666-10-15T13:00:00Z" });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var instance = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("faulted", instance.GetProperty("status").GetString());
        var incident = Assert.Single(instance.GetProperty("incidents").EnumerateArray());
        Assert.Equal(("type_mismatch", "gw"), (incident.GetProperty("code").GetString(), incident.GetProperty("nodeId").GetString()));
    }

    // Regression #86: an empty value stored nothing, so a later step couldn't clear a key. An unchecked box stayed true.

    [Fact]
    public async Task An_empty_value_clears_the_stored_one_and_the_history_keeps_both()
    {
        var id = await PublishReviewAsync();
        var started = await StartWithDataAsync(_s.Ana, id, new JsonObject
        {
            ["aceite"] = true, ["obs"] = "Primeira análise", ["modalidade"] = "pf", ["protocolo"] = "P-1", ["segredo"] = "s",
        });
        Assert.Equal(HttpStatusCode.Created, started.StatusCode);
        var instanceId = Id(await started.Content.ReadFromJsonAsync<JsonElement>());

        var done = await CompleteAsync(_s.Bruno, Id(await OpenTaskAsync(_s.Bruno, instanceId)), data: new JsonObject
        {
            ["aceite"] = false, ["obs"] = "", ["modalidade"] = null, ["protocolo"] = "", ["segredo"] = "",
        });

        Assert.Equal(HttpStatusCode.OK, done.StatusCode);
        var data = (await done.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("data");
        Assert.False(data.TryGetProperty("aceite", out _), $"The unchecked box is still stored: {data}");
        Assert.False(data.TryGetProperty("obs", out _));
        Assert.False(data.TryGetProperty("modalidade", out _));
        Assert.Equal("P-1", data.GetProperty("protocolo").GetString()); // read-only
        Assert.Equal("s", data.GetProperty("segredo").GetString()); // hidden

        var start = JsonNode.Parse(Assert.Single(await _factory.QueryAsync(
            $"SELECT \"values\"::text FROM chain.instance_submissions WHERE instance_id = '{instanceId}' AND task_id IS NULL")))!.AsObject();
        var review = JsonNode.Parse(Assert.Single(await _factory.QueryAsync(
            $"SELECT \"values\"::text FROM chain.instance_submissions WHERE instance_id = '{instanceId}' AND task_id IS NOT NULL")))!.AsObject();
        Assert.True((bool)start["aceite"]!); // the earlier row keeps the old value
        Assert.Equal("Primeira análise", (string?)start["obs"]);
        Assert.All(["aceite", "obs", "modalidade"], key => Assert.True(review.ContainsKey(key) && review[key] is null, $"{key} in {review.ToJsonString()}"));
        Assert.False(review.ContainsKey("protocolo"));
        Assert.False(review.ContainsKey("segredo"));
    }

    // Regression #93: PostgreSQL jsonb cannot store the NUL character, so text with one was a 500 when the submission was stored.

    [Fact]
    public async Task Start_text_with_the_NUL_character_is_a_field_error()
    {
        var data = Proposal(15000);
        data["observacao"] = "Cliente\u0000antigo";

        var response = await StartWithDataAsync(_s.Ana, _s.DefinitionId, data);

        await AssertSingleFieldErrorAsync(response, "observacao", "invalid_value");
        Assert.Equal(0, await _factory.CountAsync("SELECT count(*) FROM chain.instances"));
    }

    [Fact]
    public async Task Task_text_with_the_NUL_character_is_a_field_error()
    {
        var instanceId = await StartAsync(15000);
        var analyse = Id(await OpenTaskAsync(_s.Bruno, instanceId));

        var response = await CompleteAsync(_s.Bruno, analyse, data: new JsonObject { ["parecer"] = "Documentação\u0000completa." });

        await AssertSingleFieldErrorAsync(response, "parecer", "invalid_value");
        Assert.Equal("analyse", (await OpenTaskAsync(_s.Bruno, instanceId)).GetProperty("nodeId").GetString()); // the task stays open
    }

    // Regression #129: an unpaired surrogate (\ud800) made the Idempotency-Key fingerprint throw while it re-serialized the body,
    // and unknown_field echoed a key with NUL into the result stored for replay, which jsonb cannot store. Both were 500s. A
    // serializer writes a lone surrogate as U+FFFD, so the escape is sent as JSON text written by hand.

    [Fact]
    public async Task Start_data_with_an_unpaired_surrogate_is_a_field_error()
    {
        var response = await PostTextAsync(_s.Ana, "/api/instances",
            $$$"""{"definitionId":"{{{_s.DefinitionId}}}","data":{"cpf":"529.982.247-25","valor":15000,"observacao":"Cliente\ud800"}}""");

        await AssertSingleFieldErrorAsync(response, string.Empty, "invalid_value");
        Assert.Equal(0, await _factory.CountAsync("SELECT count(*) FROM chain.instances"));
    }

    [Fact]
    public async Task Task_data_with_an_unpaired_surrogate_is_a_field_error()
    {
        var instanceId = await StartAsync(15000);
        var analyse = Id(await OpenTaskAsync(_s.Bruno, instanceId));

        var response = await PostTextAsync(_s.Bruno, $"/api/tasks/{analyse}/complete", """{"data":{"parecer\udc00":"Documentação completa."}}""");

        await AssertSingleFieldErrorAsync(response, string.Empty, "invalid_value");
        Assert.Equal("analyse", (await OpenTaskAsync(_s.Bruno, instanceId)).GetProperty("nodeId").GetString()); // the task stays open
    }

    // Card #153: a body whose bytes are not UTF-8 is not JSON, wherever it is sent (identity.md I1). In data, such bytes got the
    // 422 above; now every endpoint gives them the malformed-JSON answer.

    [Fact]
    public async Task Start_data_whose_bytes_are_not_UTF8_is_malformed_json()
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/instances")
        {
            Content = ApiTestSession.NotUtf8Json($$$"""{"definitionId":"{{{_s.DefinitionId}}}","data":{"cpf":"529.982.247-25","valor":15000,"observacao":"ClienteNOT_UTF8"}}"""),
        };
        request.Headers.Add("Idempotency-Key", NewKey());

        var response = await _s.Ana.SendAsync(request);

        await response.AssertMalformedJsonAsync(_s.Ana, HttpMethod.Post, "/api/instances");
        Assert.Equal(0, await _factory.CountAsync("SELECT count(*) FROM chain.instances"));
    }

    [Fact]
    public async Task A_key_with_the_NUL_character_is_a_field_error_that_replays()
    {
        var data = Proposal(15000);
        data["x\u0000y"] = 1;
        var key = NewKey();

        var response = await PostAsync(_s.Ana, "/api/instances", new { definitionId = _s.DefinitionId, data }, key);
        var replay = await PostAsync(_s.Ana, "/api/instances", new { definitionId = _s.DefinitionId, data }, key);

        await AssertSingleFieldErrorAsync(response, string.Empty, "invalid_value");
        await AssertSingleFieldErrorAsync(replay, string.Empty, "invalid_value"); // the stored result
        Assert.Equal(0, await _factory.CountAsync("SELECT count(*) FROM chain.instances"));
    }

    // 6. Loop guard

    [Fact]
    public async Task Endless_automatic_loop_faults_with_step_limit()
    {
        var always = new JsonObject { ["kind"] = "compare", ["left"] = new JsonObject { ["kind"] = "path", ["path"] = new JsonArray("nada") }, ["operator"] = "isEmpty" };
        var document = new JsonObject
        {
            ["schemaVersion"] = 1,
            ["lanes"] = new JsonArray(),
            ["nodes"] = new JsonArray
            {
                new JsonObject { ["id"] = "start", ["type"] = "start", ["label"] = "Início" },
                new JsonObject { ["id"] = "a", ["type"] = "gateway", ["label"] = "A", ["decisionMode"] = "automatic", ["condition"] = always.DeepClone() },
                new JsonObject { ["id"] = "b", ["type"] = "gateway", ["label"] = "B", ["decisionMode"] = "automatic", ["condition"] = always.DeepClone() },
                new JsonObject { ["id"] = "end", ["type"] = "end", ["label"] = "Fim" },
            },
            ["flows"] = new JsonArray
            {
                new JsonObject { ["id"] = "f1", ["source"] = "start", ["target"] = "a" },
                new JsonObject { ["id"] = "f2", ["source"] = "a", ["target"] = "b", ["branch"] = "true" },
                new JsonObject { ["id"] = "f3", ["source"] = "a", ["target"] = "end", ["branch"] = "false" },
                new JsonObject { ["id"] = "f4", ["source"] = "b", ["target"] = "a", ["branch"] = "true" },
                new JsonObject { ["id"] = "f5", ["source"] = "b", ["target"] = "end", ["branch"] = "false" },
            },
        };
        var looping = await _s.PublishAsync("Loop", document);
        await _s.GrantAsync(looping, [(await AnaGroupAsync(), "start")]);

        var instance = await (await StartWithDataAsync(_s.Ana, looping, [])).Content.ReadFromJsonAsync<JsonElement>();

        Assert.Equal("faulted", instance.GetProperty("status").GetString());
        Assert.Equal("step_limit", Assert.Single(instance.GetProperty("incidents").EnumerateArray()).GetProperty("code").GetString());
    }

    // Helpers

    /// <summary>
    /// start (with <paramref name="startForm"/>, if any) → gw (automatic, <paramref name="condition"/>) → end either way;
    /// startable by Ana's group.
    /// </summary>
    private async Task<Guid> PublishFaultyAsync(JsonObject condition, Guid? startForm = null)
    {
        var start = new JsonObject { ["id"] = "start", ["type"] = "start", ["label"] = "Início" };
        if (startForm is { } formId)
        {
            start["form"] = new JsonObject { ["formId"] = formId.ToString() };
        }

        var document = new JsonObject
        {
            ["schemaVersion"] = 1,
            ["lanes"] = new JsonArray(),
            ["nodes"] = new JsonArray
            {
                start,
                new JsonObject { ["id"] = "gw", ["type"] = "gateway", ["label"] = "Teste", ["decisionMode"] = "automatic", ["condition"] = condition },
                new JsonObject { ["id"] = "end", ["type"] = "end", ["label"] = "Fim" },
            },
            ["flows"] = new JsonArray
            {
                new JsonObject { ["id"] = "f1", ["source"] = "start", ["target"] = "gw" },
                new JsonObject { ["id"] = "f2", ["source"] = "gw", ["target"] = "end", ["branch"] = "true" },
                new JsonObject { ["id"] = "f3", ["source"] = "gw", ["target"] = "end", ["branch"] = "false" },
            },
        };
        var id = await _s.PublishAsync("Com defeito", document);
        await _s.GrantAsync(id, [(await AnaGroupAsync(), "start")]);
        return id;
    }

    /// <summary>
    /// start (Cadastro) → review (Revisão, lane "lane_an") → end; startable by Ana's group. Revisão shows the same keys, with
    /// "protocolo" read-only and "segredo" hidden.
    /// </summary>
    private async Task<Guid> PublishReviewAsync()
    {
        JsonObject Text(string key) => new() { ["type"] = "text", ["key"] = key, ["label"] = key };
        JsonObject Fields(JsonObject protocolo, JsonObject segredo) => new()
        {
            ["schemaVersion"] = 1,
            ["components"] = new JsonArray
            {
                new JsonObject { ["type"] = "checkbox", ["key"] = "aceite", ["label"] = "Aceite" },
                Text("obs"),
                new JsonObject
                {
                    ["type"] = "select", ["key"] = "modalidade", ["label"] = "Modalidade",
                    ["options"] = new JsonArray { new JsonObject { ["value"] = "pf", ["label"] = "PF" }, new JsonObject { ["value"] = "pj", ["label"] = "PJ" } },
                },
                protocolo,
                segredo,
            },
        };

        var cadastro = await _s.PublishFormAsync("Cadastro", Fields(Text("protocolo"), Text("segredo")));
        var protocolo = Text("protocolo");
        protocolo["readOnly"] = true;
        var segredo = Text("segredo");
        segredo["visibleWhen"] = new JsonObject
        {
            ["kind"] = "compare", ["left"] = new JsonObject { ["kind"] = "path", ["path"] = new JsonArray("nunca") },
            ["operator"] = "equals", ["right"] = new JsonObject { ["kind"] = "literal", ["type"] = "text", ["value"] = "sim" },
        };
        var revisao = await _s.PublishFormAsync("Revisão", Fields(protocolo, segredo));

        var id = await _s.PublishAsync("Revisão de cadastro", new JsonObject
        {
            ["schemaVersion"] = 1,
            ["lanes"] = new JsonArray
            {
                new JsonObject { ["id"] = "lane_an", ["title"] = "Análise", ["group"] = new JsonObject { ["kind"] = "group", ["groupId"] = _s.Analistas.ToString() } },
            },
            ["nodes"] = new JsonArray
            {
                new JsonObject { ["id"] = "start", ["type"] = "start", ["label"] = "Início", ["form"] = new JsonObject { ["formId"] = cadastro.ToString() } },
                new JsonObject { ["id"] = "review", ["type"] = "task", ["taskKind"] = "human", ["label"] = "Revisar", ["laneId"] = "lane_an", ["form"] = new JsonObject { ["formId"] = revisao.ToString() } },
                new JsonObject { ["id"] = "end", ["type"] = "end", ["label"] = "Fim" },
            },
            ["flows"] = new JsonArray
            {
                new JsonObject { ["id"] = "f1", ["source"] = "start", ["target"] = "review" },
                new JsonObject { ["id"] = "f2", ["source"] = "review", ["target"] = "end" },
            },
        });
        await _s.GrantAsync(id, [(await AnaGroupAsync(), "start")]);
        return id;
    }

    /// <summary><c>data.<paramref name="key"/> ≥ 2026-01-01T00:00:00Z</c>.</summary>
    private static JsonObject AfterNewYear(string key) => new()
    {
        ["kind"] = "compare",
        ["left"] = new JsonObject { ["kind"] = "path", ["path"] = new JsonArray(key) },
        ["operator"] = "greaterOrEqual",
        ["right"] = new JsonObject { ["kind"] = "literal", ["type"] = "datetime", ["value"] = "2026-01-01T00:00:00Z" },
    };

    private async Task<Guid> AnaGroupAsync() =>
        Id(Assert.Single((await _s.Ana.GetFromJsonAsync<JsonElement>("/api/auth/me")).GetProperty("groups").EnumerateArray()));

    /// <summary>Asserts a 422 <c>submission_invalid</c> whose only error is <paramref name="code"/> at <paramref name="key"/>.</summary>
    private static async Task AssertSingleFieldErrorAsync(HttpResponseMessage response, string key, string code)
    {
        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("submission_invalid", problem.GetProperty("code").GetString());
        var error = Assert.Single(problem.GetProperty("errors").EnumerateArray());
        Assert.Equal((key, code), (error.GetProperty("key").GetString(), error.GetProperty("code").GetString()));
    }
}
