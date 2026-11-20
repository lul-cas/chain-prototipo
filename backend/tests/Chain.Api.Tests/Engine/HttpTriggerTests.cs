using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Chain.Api.Tests.Infrastructure;
using static Chain.Api.Tests.Engine.CreditScenario;

namespace Chain.Api.Tests.Engine;

/// <summary>
/// Acceptance criteria of increment N7: HTTP triggers (workflow-engine.md §15.6). A bot in the group "Integrações",
/// which holds <c>start</c>, opens "Pedido via API": start (form Pedido: cpf, valor ≥ 1000) → "Analisar" (Analistas) → end.
/// </summary>
[Collection(PostgresTestGroup.Name)]
public sealed class HttpTriggerTests(PostgresFixture postgres) : IAsyncLifetime, IDisposable
{
    private readonly ChainApiFactory _factory = new(postgres.ConnectionString);
    private CreditScenario _s = null!;
    private Guid _integracoes;
    private Guid _pedido;
    private Guid _bot;
    private Guid _tokenId;
    private HttpClient _client = null!;

    public async Task InitializeAsync()
    {
        await _factory.ResetDatabaseAsync();
        _s = await CreditScenario.CreateAsync(_factory, async s =>
        {
            var pedido = _pedido = await s.PublishFormAsync("Pedido", new JsonObject
            {
                ["schemaVersion"] = 1,
                ["components"] = new JsonArray
                {
                    new JsonObject { ["type"] = "text", ["key"] = "cpf", ["label"] = "CPF", ["validate"] = new JsonObject { ["required"] = true, ["format"] = "cpf" } },
                    new JsonObject { ["type"] = "number", ["key"] = "valor", ["label"] = "Valor", ["validate"] = new JsonObject { ["required"] = true, ["min"] = 1000 } },
                },
            });
            return GroupLaneDocument(s.Analistas, pedido);
        });

        _integracoes = await _s.GroupAsync("Integrações");
        await _s.GrantAsync(_s.DefinitionId, [(_integracoes, "start")]);
        (_bot, _tokenId, var token) = await BotAsync("integracao-erp", _integracoes);
        _client = BearerClient(token);
    }

    public Task DisposeAsync() => Task.CompletedTask;

    public void Dispose()
    {
        _client?.Dispose();
        _s?.Dispose();
        _factory.Dispose();
    }

    private static JsonObject GroupLaneDocument(Guid analistas, Guid pedido) => new()
    {
        ["schemaVersion"] = 1,
        ["lanes"] = new JsonArray
        {
            new JsonObject { ["id"] = "lane_an", ["title"] = "Análise", ["group"] = new JsonObject { ["kind"] = "group", ["groupId"] = analistas.ToString() } },
        },
        ["nodes"] = new JsonArray
        {
            new JsonObject { ["id"] = "start", ["type"] = "start", ["label"] = "Início", ["form"] = new JsonObject { ["formId"] = pedido.ToString() } },
            new JsonObject { ["id"] = "analyse", ["type"] = "task", ["taskKind"] = "human", ["label"] = "Analisar", ["laneId"] = "lane_an" },
            new JsonObject { ["id"] = "end", ["type"] = "end", ["label"] = "Fim" },
        },
        ["flows"] = new JsonArray
        {
            new JsonObject { ["id"] = "f1", ["source"] = "start", ["target"] = "analyse" },
            new JsonObject { ["id"] = "f2", ["source"] = "analyse", ["target"] = "end" },
        },
    };

    private static JsonObject Pedido(decimal valor = 5000) => new() { ["cpf"] = "529.982.247-25", ["valor"] = valor };

    private Task<HttpResponseMessage> TriggerAsync(HttpClient client, string key, JsonObject? data = null, Guid? definitionId = null) =>
        PostAsync(client, "/api/instances", new { definitionId = definitionId ?? _s.DefinitionId, data = data ?? Pedido() }, key);

    private Task<long> InstanceCountAsync() => _factory.CountAsync("SELECT count(*) FROM chain.instances");

    // 1. A bot starts a request

    [Fact]
    public async Task A_bot_with_start_opens_a_request_with_its_token_and_no_origin()
    {
        var response = await TriggerAsync(_client, NewKey());

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var view = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal($"/api/instances/{Id(view)}", response.Headers.Location?.OriginalString);
        Assert.Equal(_bot, view.GetProperty("requester").GetProperty("id").GetGuid());
        Assert.Equal(5000m, view.GetProperty("data").GetProperty("valor").GetDecimal());
        var started = view.GetProperty("timeline").EnumerateArray().Single(e => e.GetProperty("type").GetString() == "instance.started");
        Assert.Equal(_bot, started.GetProperty("actor").GetProperty("id").GetGuid());

        var task = await OpenTaskAsync(_s.Bruno, Id(view)); // the first task goes to the lane's group
        Assert.Equal("analyse", task.GetProperty("nodeId").GetString());
        var followed = await _client.GetFromJsonAsync<JsonElement>($"/api/instances/{Id(view)}"); // the requester follows it
        Assert.Equal("running", followed.GetProperty("status").GetString());
    }

    // Card #83 (N9b-1): each event records the way in of the request that recorded it (workflow-engine.md §8). The bot's call
    // with its token is the API, and the steps the engine takes in that call share it; Bruno works in the web app, with a session.

    [Fact]
    public async Task Each_event_records_the_channel_it_came_through()
    {
        var started = await TriggerAsync(_client, NewKey());
        var instance = Id(await started.Content.ReadFromJsonAsync<JsonElement>());
        var task = await OpenTaskAsync(_s.Bruno, instance);
        Assert.Equal(HttpStatusCode.OK, (await CompleteAsync(_s.Bruno, Id(task))).StatusCode);

        var timeline = (await _s.Bruno.GetFromJsonAsync<JsonElement>($"/api/instances/{instance}")).GetProperty("timeline").EnumerateArray()
            .Select(e => $"{e.GetProperty("type").GetString()}|{e.GetProperty("channel").GetString()}");

        Assert.Equal(["instance.started|api", "form.submitted|api", "task.created|api", "task.assigned|ui", "task.completed|ui", "instance.completed|ui"], timeline);
    }

    [Fact]
    public async Task A_bearer_request_with_a_foreign_origin_is_not_rejected()
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/instances") { Content = JsonContent.Create(new { definitionId = _s.DefinitionId, data = Pedido() }) };
        request.Headers.Add("Idempotency-Key", NewKey());
        request.Headers.Add("Origin", "https://evil.test");

        Assert.Equal(HttpStatusCode.Created, (await _client.SendAsync(request)).StatusCode);
    }

    // 2. Unauthenticated callers

    [Fact]
    public async Task Unknown_revoked_and_deactivated_bot_tokens_and_missing_credentials_get_401()
    {
        using var forged = BearerClient("chn_abcdefgh_" + new string('A', 43));
        using var anonymous = _factory.CreateClient(new() { BaseAddress = new Uri("https://localhost") });
        await (await TriggerAsync(forged, NewKey())).AssertProblemAsync(HttpStatusCode.Unauthorized, "unauthenticated");
        await (await TriggerAsync(anonymous, NewKey())).AssertProblemAsync(HttpStatusCode.Forbidden, "origin_not_allowed"); // no bearer: Origin-checked
        anonymous.DefaultRequestHeaders.Add("Origin", ChainApiFactory.FrontendOrigin);
        await (await TriggerAsync(anonymous, NewKey())).AssertProblemAsync(HttpStatusCode.Unauthorized, "unauthenticated");

        Assert.Equal(HttpStatusCode.NoContent, (await _s.Admin.PostAsync($"/api/admin/bots/{_bot}/deactivate", null)).StatusCode);
        await (await TriggerAsync(_client, NewKey())).AssertProblemAsync(HttpStatusCode.Unauthorized, "unauthenticated");
        await _s.Admin.PostAsync($"/api/admin/bots/{_bot}/activate", null);

        Assert.Equal(HttpStatusCode.NoContent, (await _s.Admin.PostAsync($"/api/admin/bots/{_bot}/tokens/{_tokenId}/revoke", null)).StatusCode);
        await (await TriggerAsync(_client, NewKey())).AssertProblemAsync(HttpStatusCode.Unauthorized, "unauthenticated");

        Assert.Equal(0, await InstanceCountAsync());
    }

    // 3. Missing capability

    [Fact]
    public async Task A_bot_without_start_gets_403_whether_grouplessClientungrantedClientor_archived()
    {
        var (_, _, groupless) = await BotAsync("sem-grupo", group: null);
        var semPermissao = await _s.GroupAsync("Sem permissão");
        var (_, _, ungranted) = await BotAsync("sem-permissao", semPermissao);
        using var grouplessClient = BearerClient(groupless);
        using var ungrantedClient = BearerClient(ungranted);

        await (await TriggerAsync(grouplessClient, NewKey())).AssertProblemAsync(HttpStatusCode.Forbidden, "forbidden");
        await (await TriggerAsync(ungrantedClient, NewKey())).AssertProblemAsync(HttpStatusCode.Forbidden, "forbidden");

        Assert.Equal(HttpStatusCode.NoContent, (await _s.Admin.PostAsync($"/api/admin/groups/{_integracoes}/archive", null)).StatusCode);
        await (await TriggerAsync(_client, NewKey())).AssertProblemAsync(HttpStatusCode.Forbidden, "forbidden");

        Assert.Equal(0, await InstanceCountAsync());
    }

    [Fact]
    public async Task Removing_the_bot_from_its_group_takes_effect_on_the_next_call()
    {
        Assert.Equal(HttpStatusCode.Created, (await TriggerAsync(_client, NewKey())).StatusCode);

        await _s.Admin.DeleteAsync($"/api/admin/groups/{_integracoes}/members/{_bot}");

        await (await TriggerAsync(_client, NewKey())).AssertProblemAsync(HttpStatusCode.Forbidden, "forbidden");
    }

    // 4. Invalid payload

    [Fact]
    public async Task Invalid_start_data_returns_422_with_field_errors_and_creates_nothing()
    {
        var response = await TriggerAsync(_client, NewKey(), new JsonObject { ["cpf"] = "111.111.111-11", ["valor"] = 10, ["extra"] = true });

        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("submission_invalid", problem.GetProperty("code").GetString());
        var errors = problem.GetProperty("errors").EnumerateArray().Select(e => $"{e.GetProperty("key").GetString()}:{e.GetProperty("code").GetString()}").Order().ToList();
        Assert.Equal(["cpf:invalid_format", "extra:unknown_field", "valor:too_small"], errors);
        Assert.Equal(0, await InstanceCountAsync());
    }

    [Fact]
    public async Task Missing_idempotency_key_or_malformed_json_returns_400()
    {
        await (await PostAsync(_client, "/api/instances", new { definitionId = _s.DefinitionId, data = Pedido() }, key: null))
            .AssertProblemAsync(HttpStatusCode.BadRequest, "idempotency_key_required");

        using var malformed = new HttpRequestMessage(HttpMethod.Post, "/api/instances") { Content = new StringContent("{ not json", System.Text.Encoding.UTF8, "application/json") };
        malformed.Headers.Add("Idempotency-Key", NewKey());
        Assert.Equal(HttpStatusCode.BadRequest, (await _client.SendAsync(malformed)).StatusCode);

        Assert.Equal(0, await InstanceCountAsync());
    }

    // 5. Idempotency

    [Fact]
    public async Task Replaying_a_key_returns_the_same_request_and_another_body_is_rejected()
    {
        var key = NewKey();
        var first = await TriggerAsync(_client, key);
        var replay = await TriggerAsync(_client, key);

        Assert.Equal(HttpStatusCode.Created, replay.StatusCode);
        Assert.Equal(Id(await first.Content.ReadFromJsonAsync<JsonElement>()), Id(await replay.Content.ReadFromJsonAsync<JsonElement>()));
        Assert.Equal(1, await InstanceCountAsync());

        await (await TriggerAsync(_client, key, Pedido(9000))).AssertProblemAsync(HttpStatusCode.UnprocessableEntity, "idempotency_key_reused");
        Assert.Equal(1, await InstanceCountAsync());
    }

    [Fact]
    public async Task Concurrent_calls_with_one_key_start_one_request()
    {
        var key = NewKey();

        var results = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => TriggerAsync(_client, key)));

        Assert.All(results, r => Assert.Equal(HttpStatusCode.Created, r.StatusCode));
        var ids = await Task.WhenAll(results.Select(async r => Id(await r.Content.ReadFromJsonAsync<JsonElement>())));
        Assert.Single(ids.Distinct());
        Assert.Equal(1, await InstanceCountAsync());
    }

    [Fact]
    public async Task Keys_are_scoped_per_actor()
    {
        var (_, _, other) = await BotAsync("outro-robo", _integracoes);
        using var otherClient = BearerClient(other);
        var key = NewKey();

        var mine = await TriggerAsync(_client, key);
        var theirs = await TriggerAsync(otherClient, key, Pedido(9000));

        Assert.Equal(HttpStatusCode.Created, theirs.StatusCode);
        Assert.NotEqual(Id(await mine.Content.ReadFromJsonAsync<JsonElement>()), Id(await theirs.Content.ReadFromJsonAsync<JsonElement>()));
    }

    [Fact]
    public async Task A_stored_rejection_is_replayed_until_a_new_key_is_used()
    {
        var key = NewKey();
        await (await TriggerAsync(_client, key, Pedido(10))).AssertProblemAsync(HttpStatusCode.UnprocessableEntity, "submission_invalid");

        await (await TriggerAsync(_client, key, Pedido(10))).AssertProblemAsync(HttpStatusCode.UnprocessableEntity, "submission_invalid");
        await (await TriggerAsync(_client, key, Pedido(5000))).AssertProblemAsync(HttpStatusCode.UnprocessableEntity, "idempotency_key_reused");
        Assert.Equal(HttpStatusCode.Created, (await TriggerAsync(_client, NewKey(), Pedido(5000))).StatusCode);
    }

    [Fact]
    public async Task A_key_is_replayed_for_24_hours_and_then_starts_a_new_request()
    {
        var key = NewKey();
        var first = Id(await (await TriggerAsync(_client, key)).Content.ReadFromJsonAsync<JsonElement>());

        _factory.Time.Advance(TimeSpan.FromHours(23));
        Assert.Equal(first, Id(await (await TriggerAsync(_client, key)).Content.ReadFromJsonAsync<JsonElement>()));

        _factory.Time.Advance(TimeSpan.FromHours(1) + TimeSpan.FromSeconds(1));
        var later = await TriggerAsync(_client, key, Pedido(9000)); // after the window the key is free, even with another body

        Assert.Equal(HttpStatusCode.Created, later.StatusCode);
        Assert.NotEqual(first, Id(await later.Content.ReadFromJsonAsync<JsonElement>()));
        Assert.Equal(2, await InstanceCountAsync());
    }

    // 6. Requester tasks done by the bot itself (T-1, accepted 2026-10-16)

    /// <summary>
    /// start (requesters) → "Preencher" (requesters, form Pedido) → "Enviar?" (requesters, human) true → "Analisar" (Analistas) → end;
    /// "Enviar?" false → back to start.
    /// </summary>
    private async Task<Guid> PublishRequesterWorkflowAsync()
    {
        var id = await _s.PublishAsync("Pedido com etapas do solicitante", new JsonObject
        {
            ["schemaVersion"] = 1,
            ["lanes"] = new JsonArray
            {
                new JsonObject { ["id"] = "lane_req", ["title"] = "Solicitantes", ["group"] = new JsonObject { ["kind"] = "requesters" } },
                new JsonObject { ["id"] = "lane_an", ["title"] = "Análise", ["group"] = new JsonObject { ["kind"] = "group", ["groupId"] = _s.Analistas.ToString() } },
            },
            ["nodes"] = new JsonArray
            {
                new JsonObject { ["id"] = "start", ["type"] = "start", ["label"] = "Início", ["laneId"] = "lane_req" },
                new JsonObject { ["id"] = "fill", ["type"] = "task", ["taskKind"] = "human", ["label"] = "Preencher", ["laneId"] = "lane_req", ["form"] = new JsonObject { ["formId"] = _pedido.ToString() } },
                new JsonObject { ["id"] = "send", ["type"] = "gateway", ["label"] = "Enviar?", ["laneId"] = "lane_req", ["decisionMode"] = "human", ["question"] = "Enviar para análise?" },
                new JsonObject { ["id"] = "analyse", ["type"] = "task", ["taskKind"] = "human", ["label"] = "Analisar", ["laneId"] = "lane_an" },
                new JsonObject { ["id"] = "end", ["type"] = "end", ["label"] = "Fim", ["laneId"] = "lane_an" },
            },
            ["flows"] = new JsonArray
            {
                new JsonObject { ["id"] = "f1", ["source"] = "start", ["target"] = "fill" },
                new JsonObject { ["id"] = "f2", ["source"] = "fill", ["target"] = "send" },
                new JsonObject { ["id"] = "f3", ["source"] = "send", ["target"] = "analyse", ["branch"] = "true" },
                new JsonObject { ["id"] = "f4", ["source"] = "send", ["target"] = "start", ["branch"] = "false" },
                new JsonObject { ["id"] = "f5", ["source"] = "analyse", ["target"] = "end" },
            },
        });
        var auditoria = (await _s.Admin.GetFromJsonAsync<JsonElement>("/api/admin/groups")).EnumerateArray()
            .Single(g => g.GetProperty("name").GetString() == "Auditoria").GetProperty("id").GetGuid();
        await _s.GrantAsync(id, [(_integracoes, "start"), (auditoria, "view")]);
        return id;
    }

    private async Task<(Guid Instance, Guid Fill)> BotStartedAtFillAsync()
    {
        var definition = await PublishRequesterWorkflowAsync();
        var started = await PostAsync(_client, "/api/instances", new { definitionId = definition }, NewKey());
        Assert.Equal(HttpStatusCode.Created, started.StatusCode);
        var instance = Id(await started.Content.ReadFromJsonAsync<JsonElement>());
        var fill = await OpenTaskAsync(_client, instance);
        Assert.Equal("fill", fill.GetProperty("nodeId").GetString());
        Assert.Equal(JsonValueKind.Null, fill.GetProperty("group").ValueKind); // a requester task
        return (instance, Id(fill));
    }

    [Fact]
    public async Task A_bot_completes_and_decides_its_requester_steps_and_the_request_advances()
    {
        var (instance, fill) = await BotStartedAtFillAsync();

        var task = await _client.GetFromJsonAsync<JsonElement>($"/api/tasks/{fill}"); // the bot reads the form with its token
        Assert.Equal(_pedido, task.GetProperty("form").GetProperty("formId").GetGuid());
        var inbox = await _client.GetFromJsonAsync<JsonElement>("/api/tasks");
        Assert.Contains(inbox.GetProperty("unassigned").EnumerateArray(), t => Id(t) == fill);

        Assert.Equal(HttpStatusCode.OK, (await CompleteAsync(_client, fill, data: Pedido(7000))).StatusCode);
        var send = await OpenTaskAsync(_client, instance);
        Assert.Equal("send", send.GetProperty("nodeId").GetString());
        Assert.Equal(HttpStatusCode.OK, (await DecideAsync(_client, Id(send), true)).StatusCode);

        var view = await _s.Bruno.GetFromJsonAsync<JsonElement>($"/api/instances/{instance}");
        Assert.Equal("analyse", Assert.Single(view.GetProperty("openTasks").EnumerateArray()).GetProperty("nodeId").GetString());
        Assert.Equal(7000m, view.GetProperty("data").GetProperty("valor").GetDecimal());
        var actors = view.GetProperty("timeline").EnumerateArray()
            .Where(e => e.GetProperty("type").GetString() is "task.completed" or "gateway.decided")
            .Select(e => e.GetProperty("actor").GetProperty("id").GetGuid()).ToList();
        Assert.Equal([_bot, _bot], actors);
    }

    [Fact]
    public async Task Invalid_data_on_a_requester_task_returns_422_and_the_task_stays_open()
    {
        var (instance, fill) = await BotStartedAtFillAsync();

        var response = await CompleteAsync(_client, fill, data: Pedido(10));

        await response.AssertProblemAsync(HttpStatusCode.UnprocessableEntity, "submission_invalid");
        Assert.Equal(fill, Id(await OpenTaskAsync(_client, instance)));
    }

    [Fact]
    public async Task Only_the_requesting_bot_can_act_on_its_requester_task()
    {
        var (instance, fill) = await BotStartedAtFillAsync();
        var (_, _, other) = await BotAsync("outro-robo", _integracoes);
        using var otherBot = BearerClient(other);

        await (await CompleteAsync(otherBot, fill, data: Pedido())).AssertProblemAsync(HttpStatusCode.NotFound, "not_found");  // can't see it
        await (await CompleteAsync(_s.Bruno, fill, data: Pedido())).AssertProblemAsync(HttpStatusCode.NotFound, "not_found"); // can't see it
        await (await CompleteAsync(_s.Eva, fill, data: Pedido())).AssertProblemAsync(HttpStatusCode.Forbidden, "forbidden");  // sees it (view), not the requester
        await (await CompleteAsync(_s.Admin, fill, data: Pedido())).AssertProblemAsync(HttpStatusCode.Forbidden, "forbidden"); // E-1

        Assert.Equal(fill, Id(await OpenTaskAsync(_client, instance)));
    }

    [Fact]
    public async Task A_loop_back_to_start_returns_to_the_bot_and_prefills_its_earlier_answers()
    {
        var (instance, fill) = await BotStartedAtFillAsync();
        await CompleteAsync(_client, fill, data: Pedido(7000));
        Assert.Equal(HttpStatusCode.OK, (await DecideAsync(_client, Id(await OpenTaskAsync(_client, instance)), false)).StatusCode);

        var start = await OpenTaskAsync(_client, instance);
        Assert.Equal("start", start.GetProperty("nodeId").GetString());
        Assert.Equal(HttpStatusCode.OK, (await CompleteAsync(_client, Id(start))).StatusCode);

        var again = await OpenTaskAsync(_client, instance);
        Assert.Equal("fill", again.GetProperty("nodeId").GetString());
        Assert.NotEqual(fill, Id(again));
        var detail = await _client.GetFromJsonAsync<JsonElement>($"/api/tasks/{Id(again)}");
        Assert.Equal(7000m, detail.GetProperty("prefill").GetProperty("valor").GetDecimal());
    }

    // Helpers

    private async Task<(Guid Bot, Guid TokenId, string Token)> BotAsync(string name, Guid? group)
    {
        var created = await _s.Admin.PostAsJsonAsync("/api/admin/bots", new { name, displayName = name });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var bot = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        if (group is { } groupId)
        {
            Assert.Equal(HttpStatusCode.NoContent, (await _s.Admin.PutAsync($"/api/admin/groups/{groupId}/members/{bot}", null)).StatusCode);
        }

        var token = await (await _s.Admin.PostAsJsonAsync($"/api/admin/bots/{bot}/tokens", new { label = "teste" })).Content.ReadFromJsonAsync<JsonElement>();
        return (bot, token.GetProperty("token").GetProperty("id").GetGuid(), token.GetProperty("value").GetString()!);
    }

    private HttpClient BearerClient(string token)
    {
        var client = _factory.CreateClient(new() { BaseAddress = new Uri("https://localhost") });
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return client;
    }
}
