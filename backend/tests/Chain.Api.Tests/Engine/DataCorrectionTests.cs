using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Chain.Api.Tests.Infrastructure;
using static Chain.Api.Tests.Engine.CreditScenario;

namespace Chain.Api.Tests.Engine;

/// <summary>Acceptance criteria of N5, admin data correction for faulted requests (workflow-engine.md §16.6).</summary>
[Collection(PostgresTestGroup.Name)]
public sealed class DataCorrectionTests(PostgresFixture postgres) : IAsyncLifetime, IDisposable
{
    private const string Justification = "Prazo digitado por extenso (chamado #123).";

    private readonly ChainApiFactory _factory = new(postgres.ConnectionString);
    private CreditScenario _s = null!;
    private Guid _definition;

    public async Task InitializeAsync()
    {
        await _factory.ResetDatabaseAsync();
        _s = await CreditScenario.CreateAsync(_factory);
        var pedido = await _s.PublishFormAsync("Pedido", new JsonObject
        {
            ["schemaVersion"] = 1,
            ["components"] = new JsonArray
            {
                Field("text", "prazo", new JsonObject { ["required"] = true }),
                Field("number", "valor", new JsonObject { ["required"] = true, ["min"] = 1000, ["max"] = 50000, ["decimalDigits"] = 2 }),
                Field("textarea", "obs", new JsonObject { ["maxLength"] = 20 }),
                new JsonObject
                {
                    ["type"] = "select", ["key"] = "tipo", ["label"] = "Tipo",
                    ["options"] = new JsonArray { new JsonObject { ["value"] = "pf", ["label"] = "PF" }, new JsonObject { ["value"] = "pj", ["label"] = "PJ" } },
                },
                new JsonObject
                {
                    ["type"] = "computed", ["key"] = "total", ["label"] = "Total",
                    ["expression"] = new JsonObject { ["kind"] = "arithmetic", ["op"] = "multiply", ["left"] = Path("valor"), ["right"] = Literal("number", "2") },
                },
                new JsonObject
                {
                    ["type"] = "group", ["key"] = "endereco", ["label"] = "Endereço",
                    ["components"] = new JsonArray { Field("text", "cep", new JsonObject { ["required"] = true, ["format"] = "cep" }) },
                },
            },
        });
        _definition = await _s.PublishAsync("Pedido com prazo", Document(_s.Analistas, pedido));
        var comercial = Id(Assert.Single((await _s.Ana.GetFromJsonAsync<JsonElement>("/api/auth/me")).GetProperty("groups").EnumerateArray()));
        await _s.GrantAsync(_definition, [(comercial, "start")]);
    }

    public Task DisposeAsync() => Task.CompletedTask;

    public void Dispose()
    {
        _s?.Dispose();
        _factory.Dispose();
    }

    /// <summary>start (Pedido) → "gw" (automatic: prazo ≥ 2026-01-01) → true: "analise" (Analistas) → end; false: end.</summary>
    private static JsonObject Document(Guid analistas, Guid pedido) => new()
    {
        ["schemaVersion"] = 1,
        ["lanes"] = new JsonArray
        {
            new JsonObject { ["id"] = "lane_an", ["title"] = "Análise", ["group"] = new JsonObject { ["kind"] = "group", ["groupId"] = analistas.ToString() } },
        },
        ["nodes"] = new JsonArray
        {
            new JsonObject { ["id"] = "start", ["type"] = "start", ["label"] = "Início", ["form"] = new JsonObject { ["formId"] = pedido.ToString() } },
            new JsonObject
            {
                ["id"] = "gw", ["type"] = "gateway", ["label"] = "No prazo?", ["decisionMode"] = "automatic",
                ["condition"] = new JsonObject { ["kind"] = "compare", ["left"] = Path("prazo"), ["operator"] = "greaterOrEqual", ["right"] = Literal("date", "2026-01-01") },
            },
            new JsonObject { ["id"] = "analise", ["type"] = "task", ["taskKind"] = "human", ["label"] = "Analisar", ["laneId"] = "lane_an" },
            new JsonObject { ["id"] = "end", ["type"] = "end", ["label"] = "Fim" },
        },
        ["flows"] = new JsonArray
        {
            new JsonObject { ["id"] = "f1", ["source"] = "start", ["target"] = "gw" },
            new JsonObject { ["id"] = "f2", ["source"] = "gw", ["target"] = "analise", ["branch"] = "true" },
            new JsonObject { ["id"] = "f3", ["source"] = "gw", ["target"] = "end", ["branch"] = "false" },
            new JsonObject { ["id"] = "f4", ["source"] = "analise", ["target"] = "end" },
        },
    };

    private static JsonObject Field(string type, string key, JsonObject validate) => new() { ["type"] = type, ["key"] = key, ["label"] = key, ["validate"] = validate };

    private static JsonObject Path(string key) => new() { ["kind"] = "path", ["path"] = new JsonArray(key) };

    private static JsonObject Literal(string type, string value) => new() { ["kind"] = "literal", ["type"] = type, ["value"] = value };

    /// <summary>"amanhã" is not a date, so the gateway faults with <c>type_mismatch</c>.</summary>
    private async Task<Guid> FaultedAsync(string prazo = "amanhã")
    {
        var response = await StartWithDataAsync(_s.Ana, _definition, new JsonObject
        {
            ["prazo"] = prazo, ["valor"] = 5000, ["obs"] = "x", ["endereco"] = new JsonObject { ["cep"] = "01310-100" },
        });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var instance = await response.Content.ReadFromJsonAsync<JsonElement>();
        return Id(instance);
    }

    private static object Body(JsonObject changes, string? justification = Justification) => new { changes, justification };

    private async Task<JsonElement> AdminGetAsync(Guid instanceId) => await _s.Admin.GetFromJsonAsync<JsonElement>($"/api/instances/{instanceId}");

    private static IEnumerable<string> Events(JsonElement instance) => instance.GetProperty("timeline").EnumerateArray().Select(e => e.GetProperty("type").GetString()!);

    private static string? Text(JsonElement value) => value.ValueKind == JsonValueKind.Null ? null : value.GetString();

    // AC 1–2: correct, record, then retry resumes

    [Fact]
    public async Task Admin_corrects_a_faulted_request_and_a_retry_resumes_it()
    {
        var instanceId = await FaultedAsync();
        var faulted = await AdminGetAsync(instanceId);
        Assert.Equal("faulted", faulted.GetProperty("status").GetString());
        var incidentId = Assert.Single(faulted.GetProperty("incidents").EnumerateArray()).GetProperty("id").GetGuid();
        var etag = await CurrentETagAsync(_s.Admin, instanceId);

        var response = await CorrectAsync(_s.Admin, instanceId, etag, Body(new JsonObject { ["prazo"] = "2026-12-01", ["obs"] = null, ["tipo"] = "pj" }));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var corrected = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("faulted", corrected.GetProperty("status").GetString()); // correction never moves the request on
        Assert.Null(Assert.Single(corrected.GetProperty("incidents").EnumerateArray()).GetProperty("resolvedAt").GetString());
        var data = corrected.GetProperty("data");
        Assert.Equal("2026-12-01", data.GetProperty("prazo").GetString());
        Assert.False(data.TryGetProperty("obs", out _));
        Assert.Equal("pj", data.GetProperty("tipo").GetString());
        Assert.Equal(10000m, data.GetProperty("total").GetDecimal()); // other keys are untouched

        Assert.NotEqual(etag, response.Headers.ETag!.Tag);
        Assert.Equal(response.Headers.ETag.Tag, $"\"{corrected.GetProperty("version").GetUInt32()}\"");
        var evt = corrected.GetProperty("timeline").EnumerateArray().Last();
        Assert.Equal("data.corrected", evt.GetProperty("type").GetString());
        Assert.Equal("admin", evt.GetProperty("actor").GetProperty("username").GetString());
        var details = evt.GetProperty("details");
        Assert.Equal(Justification, details.GetProperty("justification").GetString());
        Assert.Equal(incidentId, Assert.Single(details.GetProperty("incidentIds").EnumerateArray()).GetGuid());
        Assert.Equal(
            new (string, string?, string?)[] { ("prazo", "amanhã", "2026-12-01"), ("obs", "x", null), ("tipo", null, "pj") },
            details.GetProperty("changes").EnumerateArray().Select(c => (c.GetProperty("key").GetString()!, Text(c.GetProperty("before")), Text(c.GetProperty("after")))));
        Assert.Equal(
            [$"correction|{Justification}|{incidentId}"],
            await _factory.QueryAsync($"SELECT kind || '|' || justification || '|' || (incident_ids->>0) FROM chain.instance_submissions WHERE instance_id = '{instanceId}' AND kind = 'correction'"));

        var retried = await PostAsync(_s.Admin, $"/api/instances/{instanceId}/retry", null, NewKey());

        Assert.Equal(HttpStatusCode.OK, retried.StatusCode);
        var resumed = await retried.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("running", resumed.GetProperty("status").GetString());
        Assert.Equal("analise", Assert.Single(resumed.GetProperty("openTasks").EnumerateArray()).GetProperty("nodeId").GetString());
    }

    [Fact]
    public async Task Temporal_and_group_values_are_stored_as_a_submission_would_store_them()
    {
        var instanceId = await FaultedAsync();

        var response = await CorrectAsync(_s.Admin, instanceId, await CurrentETagAsync(_s.Admin, instanceId),
            Body(new JsonObject { ["valor"] = 7000.5, ["endereco"] = new JsonObject { ["cep"] = "01310200" } }));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var data = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("data");
        Assert.Equal(7000.5m, data.GetProperty("valor").GetDecimal());
        Assert.Equal("""{"cep":"01310200"}""", data.GetProperty("endereco").GetRawText()); // replaced as a whole
        Assert.Equal(10000m, data.GetProperty("total").GetDecimal()); // computed values are not recomputed
    }

    // AC 3: who and when

    [Fact]
    public async Task Only_admins_correct_and_only_faulted_requests()
    {
        var instanceId = await FaultedAsync();
        var etag = await CurrentETagAsync(_s.Admin, instanceId);
        var changes = Body(new JsonObject { ["prazo"] = "2026-12-01" });

        await (await CorrectAsync(_s.Ana, instanceId, etag, changes)).AssertProblemAsync(HttpStatusCode.Forbidden, "forbidden"); // the requester sees it
        await (await CorrectAsync(_s.Fabio, instanceId, etag, changes)).AssertProblemAsync(HttpStatusCode.NotFound, "not_found");

        var running = await FaultedAsync(prazo: "2026-12-01");
        Assert.Equal("running", (await AdminGetAsync(running)).GetProperty("status").GetString());
        await (await CorrectAsync(_s.Admin, running, await CurrentETagAsync(_s.Admin, running), changes)).AssertProblemAsync(HttpStatusCode.Conflict, "instance_not_faulted");

        Assert.Equal(HttpStatusCode.OK, (await CloseAsync(_s.Admin, instanceId, "Pedido duplicado")).StatusCode);
        await (await CorrectAsync(_s.Admin, instanceId, await CurrentETagAsync(_s.Admin, instanceId), changes)).AssertProblemAsync(HttpStatusCode.Conflict, "instance_not_faulted");
        Assert.Equal("amanhã", (await AdminGetAsync(instanceId)).GetProperty("data").GetProperty("prazo").GetString());
    }

    // AC 4: versions and replays

    [Fact]
    public async Task Corrections_need_the_current_version_and_replay_without_a_second_event()
    {
        var instanceId = await FaultedAsync();
        var etag = await CurrentETagAsync(_s.Admin, instanceId);
        var changes = Body(new JsonObject { ["obs"] = "revisado" });

        await (await CorrectAsync(_s.Admin, instanceId, null, changes)).AssertProblemAsync(HttpStatusCode.PreconditionRequired, "precondition_required");

        var key = NewKey();
        var first = await CorrectAsync(_s.Admin, instanceId, etag, changes, key);
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);

        var replay = await CorrectAsync(_s.Admin, instanceId, etag, changes, key);
        Assert.Equal(HttpStatusCode.OK, replay.StatusCode);
        Assert.Equal(first.Headers.ETag!.Tag, replay.Headers.ETag!.Tag);
        Assert.Single(Events(await AdminGetAsync(instanceId)), type => type == "data.corrected");

        await (await CorrectAsync(_s.Admin, instanceId, etag, Body(new JsonObject { ["obs"] = "outro" }), key)).AssertProblemAsync(HttpStatusCode.UnprocessableEntity, "idempotency_key_reused");
        await (await CorrectAsync(_s.Admin, instanceId, etag, Body(new JsonObject { ["obs"] = "outro" }))).AssertProblemAsync(HttpStatusCode.PreconditionFailed, "version_mismatch"); // stale
        Assert.Equal("revisado", (await AdminGetAsync(instanceId)).GetProperty("data").GetProperty("obs").GetString());
    }

    // AC 5: invalid corrections

    [Fact]
    public async Task Invalid_values_are_rejected_per_key_and_nothing_changes()
    {
        var instanceId = await FaultedAsync();
        var before = await AdminGetAsync(instanceId);

        var response = await CorrectAsync(_s.Admin, instanceId, await CurrentETagAsync(_s.Admin, instanceId), Body(new JsonObject
        {
            ["inexistente"] = 1,
            ["total"] = 7,
            ["valor"] = "muito",
            ["obs"] = "um texto bem maior que vinte caracteres",
            ["tipo"] = "zz",
            ["endereco"] = new JsonObject { ["cep"] = "abc" },
            ["prazo"] = null,
        }));

        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("correction_invalid", problem.GetProperty("code").GetString());
        Assert.Equal(
            [("inexistente", "unknown_field"), ("total", "computed_field"), ("valor", "type_mismatch"), ("obs", "too_long"),
             ("tipo", "invalid_option"), ("endereco.cep", "invalid_format"), ("prazo", "required")],
            problem.GetProperty("errors").EnumerateArray().Select(e => (e.GetProperty("key").GetString()!, e.GetProperty("code").GetString()!)));
        var after = await AdminGetAsync(instanceId);
        Assert.Equal(before.GetProperty("data").GetRawText(), after.GetProperty("data").GetRawText());
        Assert.DoesNotContain("data.corrected", Events(after));
        Assert.Equal(["0"], await _factory.QueryAsync($"SELECT count(*) FROM chain.instance_submissions WHERE instance_id = '{instanceId}' AND kind = 'correction'"));
    }

    // Regression #93: PostgreSQL jsonb cannot store the NUL character, so a corrected text with one was a 500.

    [Fact]
    public async Task A_corrected_text_with_the_NUL_character_is_a_field_error()
    {
        var instanceId = await FaultedAsync();
        var before = await AdminGetAsync(instanceId);

        var response = await CorrectAsync(_s.Admin, instanceId, await CurrentETagAsync(_s.Admin, instanceId), Body(new JsonObject { ["obs"] = "a\u0000b" }));

        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("correction_invalid", problem.GetProperty("code").GetString());
        var error = Assert.Single(problem.GetProperty("errors").EnumerateArray());
        Assert.Equal(("obs", "invalid_value"), (error.GetProperty("key").GetString(), error.GetProperty("code").GetString()));
        Assert.Equal(before.GetProperty("data").GetRawText(), (await AdminGetAsync(instanceId)).GetProperty("data").GetRawText());
    }

    [Fact]
    public async Task A_computed_key_is_rejected_even_with_its_stored_value()
    {
        var instanceId = await FaultedAsync();

        var response = await CorrectAsync(_s.Admin, instanceId, await CurrentETagAsync(_s.Admin, instanceId), Body(new JsonObject { ["total"] = 10000 }));

        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        var error = Assert.Single((await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("errors").EnumerateArray());
        Assert.Equal(("total", "computed_field"), (error.GetProperty("key").GetString(), error.GetProperty("code").GetString())); // Q-N6
    }

    [Fact]
    public async Task Keys_whose_writers_disagree_on_the_type_keep_the_current_type()
    {
        var instanceId = await ConflictingTypesAsync();

        var mismatched = await CorrectAsync(_s.Admin, instanceId, await CurrentETagAsync(_s.Admin, instanceId),
            Body(new JsonObject { ["codigo"] = 5, ["nota"] = "boa" }));

        Assert.Equal(HttpStatusCode.UnprocessableEntity, mismatched.StatusCode);
        Assert.Equal(
            [("codigo", "type_mismatch"), ("nota", "untyped_key")],
            (await mismatched.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("errors").EnumerateArray()
                .Select(e => (e.GetProperty("key").GetString()!, e.GetProperty("code").GetString()!)));

        var kept = await CorrectAsync(_s.Admin, instanceId, await CurrentETagAsync(_s.Admin, instanceId), Body(new JsonObject { ["codigo"] = "XYZ" }));
        Assert.Equal(HttpStatusCode.OK, kept.StatusCode);
        Assert.Equal("XYZ", (await kept.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("data").GetProperty("codigo").GetString());
    }

    // Regression #129: a value that no form field checks is stored as sent, and PostgreSQL jsonb cannot store the NUL character,
    // so this was a 500. The same holds for a child's inputs (EngineE3Tests) and sub-workflow outputs.

    [Fact]
    public async Task A_value_stored_as_sent_with_the_NUL_character_is_a_field_error()
    {
        var instanceId = await ConflictingTypesAsync();
        var before = await AdminGetAsync(instanceId);

        var response = await CorrectAsync(_s.Admin, instanceId, await CurrentETagAsync(_s.Admin, instanceId), Body(new JsonObject { ["codigo"] = "X\u0000Y" }));

        await AssertSingleFieldErrorAsync(response, "codigo", "invalid_value");
        Assert.Equal(before.GetProperty("data").GetRawText(), (await AdminGetAsync(instanceId)).GetProperty("data").GetRawText());
    }

    /// <summary>
    /// A faulted instance whose start form writes "codigo" and "nota" as text while the task form writes them as numbers, so the
    /// catalog can't type them (TC-3). "codigo" holds "ABC"; "nota" has no value.
    /// </summary>
    private async Task<Guid> ConflictingTypesAsync()
    {
        var inicio = await _s.PublishFormAsync("Início misto", new JsonObject
        {
            ["schemaVersion"] = 1,
            ["components"] = new JsonArray
            {
                Field("text", "prazo", new JsonObject { ["required"] = true }),
                Field("text", "codigo", new JsonObject { ["required"] = true }),
                Field("text", "nota", new JsonObject()),
            },
        });
        var analise = await _s.PublishFormAsync("Análise mista", new JsonObject
        {
            ["schemaVersion"] = 1,
            ["components"] = new JsonArray { Field("number", "codigo", new JsonObject()), Field("number", "nota", new JsonObject()) },
        });
        var document = Document(_s.Analistas, inicio);
        document["nodes"]![2]!["form"] = new JsonObject { ["formId"] = analise.ToString() };
        var definition = await _s.PublishAsync("Tipos em conflito", document);
        await _s.GrantAsync(definition, [(Id(Assert.Single((await _s.Ana.GetFromJsonAsync<JsonElement>("/api/auth/me")).GetProperty("groups").EnumerateArray())), "start")]);
        var started = await StartWithDataAsync(_s.Ana, definition, new JsonObject { ["prazo"] = "amanhã", ["codigo"] = "ABC" });
        return Id(await started.Content.ReadFromJsonAsync<JsonElement>());
    }

    [Theory]
    [InlineData("{}", "Justificativa", "changes_required")]
    [InlineData("null", "Justificativa", "changes_required")]
    [InlineData("{\"obs\":\"a\"}", null, "justification_required")]
    [InlineData("{\"obs\":\"a\"}", "   ", "justification_required")]
    public async Task A_correction_needs_changes_and_a_justification(string changes, string? justification, string error)
    {
        var instanceId = await FaultedAsync();

        var response = await CorrectAsync(_s.Admin, instanceId, await CurrentETagAsync(_s.Admin, instanceId),
            new { changes = JsonNode.Parse(changes), justification });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("validation_failed", problem.GetProperty("code").GetString());
        Assert.Equal(error, Assert.Single(problem.GetProperty("errors").EnumerateArray()).GetString());
    }

    [Fact]
    public async Task A_key_given_twice_is_rejected()
    {
        var instanceId = await FaultedAsync();
        using var request = new HttpRequestMessage(HttpMethod.Patch, $"/api/instances/{instanceId}/data")
        {
            Content = new StringContent("""{"changes":{"obs":"a","obs":"b"},"justification":"Duas vezes."}""", System.Text.Encoding.UTF8, "application/json"),
        };
        request.Headers.Add("Idempotency-Key", NewKey());
        request.Headers.TryAddWithoutValidation("If-Match", await CurrentETagAsync(_s.Admin, instanceId));

        var response = await _s.Admin.SendAsync(request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("duplicate_key", Assert.Single((await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("errors").EnumerateArray()).GetString());
    }

    [Fact]
    public async Task A_justification_longer_than_two_thousand_characters_is_rejected()
    {
        var instanceId = await FaultedAsync();

        var response = await CorrectAsync(_s.Admin, instanceId, await CurrentETagAsync(_s.Admin, instanceId),
            Body(new JsonObject { ["obs"] = "a" }, new string('j', 2001)));

        await response.AssertProblemAsync(HttpStatusCode.BadRequest, "validation_failed");
    }

    // Regression #129: PostgreSQL jsonb cannot store the NUL character, and an unpaired surrogate (\ud800) made the Idempotency-Key
    // fingerprint throw while it re-serialized the body, so these were 500s. A serializer writes a lone surrogate as U+FFFD, so
    // the escape is sent as JSON text written by hand.

    [Fact]
    public async Task A_justification_with_the_NUL_character_is_invalid()
    {
        var instanceId = await FaultedAsync();

        var response = await CorrectAsync(_s.Admin, instanceId, await CurrentETagAsync(_s.Admin, instanceId),
            Body(new JsonObject { ["prazo"] = "2026-12-01" }, "Prazo\u0000corrigido."));

        await response.AssertValidationFailedAsync("invalid_justification");
        Assert.Equal("amanhã", (await AdminGetAsync(instanceId)).GetProperty("data").GetProperty("prazo").GetString());
    }

    [Fact]
    public async Task A_key_with_the_NUL_character_is_a_field_error()
    {
        var instanceId = await FaultedAsync();
        var before = await AdminGetAsync(instanceId);

        var response = await CorrectAsync(_s.Admin, instanceId, await CurrentETagAsync(_s.Admin, instanceId),
            Body(new JsonObject { ["prazo"] = "2026-12-01", ["x\u0000y"] = 1 }));

        await AssertSingleFieldErrorAsync(response, string.Empty, "invalid_value");
        Assert.Equal(before.GetProperty("data").GetRawText(), (await AdminGetAsync(instanceId)).GetProperty("data").GetRawText());
    }

    [Fact]
    public async Task Changes_with_an_unpaired_surrogate_are_a_field_error()
    {
        var instanceId = await FaultedAsync();
        var before = await AdminGetAsync(instanceId);
        using var request = new HttpRequestMessage(HttpMethod.Patch, $"/api/instances/{instanceId}/data")
        {
            Content = ApiTestSession.RawJson("""{"changes":{"obs":"a\ud800b"},"justification":"Observação corrigida."}"""),
        };
        request.Headers.Add("Idempotency-Key", NewKey());
        request.Headers.TryAddWithoutValidation("If-Match", await CurrentETagAsync(_s.Admin, instanceId));

        var response = await _s.Admin.SendAsync(request);

        await AssertSingleFieldErrorAsync(response, string.Empty, "invalid_value");
        Assert.Equal(before.GetProperty("data").GetRawText(), (await AdminGetAsync(instanceId)).GetProperty("data").GetRawText());
    }

    /// <summary>Asserts a 422 <c>correction_invalid</c> whose only error is <paramref name="code"/> at <paramref name="key"/>.</summary>
    private static async Task AssertSingleFieldErrorAsync(HttpResponseMessage response, string key, string code)
    {
        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("correction_invalid", problem.GetProperty("code").GetString());
        var error = Assert.Single(problem.GetProperty("errors").EnumerateArray());
        Assert.Equal((key, code), (error.GetProperty("key").GetString(), error.GetProperty("code").GetString()));
    }

    // AC 7: racing commands

    [Fact]
    public async Task A_correction_racing_a_close_or_a_retry_never_fails_with_a_server_error()
    {
        for (var round = 0; round < 4; round++)
        {
            var instanceId = await FaultedAsync();
            var etag = await CurrentETagAsync(_s.Admin, instanceId);
            var correction = CorrectAsync(_s.Admin, instanceId, etag, Body(new JsonObject { ["prazo"] = "2026-12-01" }));
            var other = round % 2 == 0
                ? CloseAsync(_s.Admin, instanceId, "Corrida")
                : PostAsync(_s.Admin, $"/api/instances/{instanceId}/retry", null, NewKey());

            var statuses = (await Task.WhenAll(correction, other)).Select(r => r.StatusCode).ToList();

            Assert.All(statuses, status => Assert.Contains(status, new[] { HttpStatusCode.OK, HttpStatusCode.Conflict, HttpStatusCode.PreconditionFailed }));
        }
    }
}
