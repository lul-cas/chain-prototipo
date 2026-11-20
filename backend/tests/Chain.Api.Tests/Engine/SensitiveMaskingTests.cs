using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Chain.Api.Tests.Infrastructure;
using Chain.Api.Tests.Mcp;
using Chain.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static Chain.Api.Tests.Engine.CreditScenario;

namespace Chain.Api.Tests.Engine;

/// <summary>Sensitive data S1b: who sees sensitive values, and how they are hidden (sensitive-data.md §4, §5; card #53).</summary>
[Collection(PostgresTestGroup.Name)]
public sealed class SensitiveMaskingTests(PostgresFixture postgres) : IAsyncLifetime, IDisposable
{
    /// <summary>A value that must never reach a caller who may not see it.</summary>
    private const string Canary = "CANARIO-529.982.247-25";

    private readonly ChainApiFactory _factory = new(postgres.ConnectionString);
    private CreditScenario _s = null!;
    private Guid _definition;
    private Guid _comercial;
    private Guid _auditoria;
    private Guid _sigilo;

    private HttpClient Gil => _s.Browsers["gil"];

    public async Task InitializeAsync()
    {
        await _factory.ResetDatabaseAsync();
        _s = await CreditScenario.CreateAsync(_factory);
        var proposta = await _s.PublishFormAsync("Proposta", Form(Text("cpf", sensitive: true), Number("valor")));
        var conferencia = await _s.PublishFormAsync("Conferência", Form(Text("cpf", sensitive: true, readOnly: true), Text("parecer")));
        _definition = await _s.PublishAsync("Crédito sigiloso", Document(_s.Analistas, proposta, conferencia));

        _comercial = await GroupOfAsync(_s.Ana);
        _auditoria = await GroupOfAsync(_s.Eva);
        _sigilo = await _s.GroupAsync("Sigilo");
        await _s.UserAsync("gil", _sigilo);
        await _s.GrantAsync(_definition, [(_comercial, "start"), (_auditoria, "view"), (_sigilo, "view"), (_sigilo, "viewSensitive")]);
    }

    public Task DisposeAsync() => Task.CompletedTask;

    public void Dispose()
    {
        _s.Dispose();
        _factory.Dispose();
    }

    private static async Task<Guid> GroupOfAsync(HttpClient client) =>
        Assert.Single((await client.GetFromJsonAsync<JsonElement>("/api/auth/me")).GetProperty("groups").EnumerateArray()).GetProperty("id").GetGuid();

    private static JsonObject Form(params JsonObject[] components) => new() { ["schemaVersion"] = 1, ["components"] = new JsonArray(components) };

    private static JsonObject Text(string key, bool sensitive = false, bool readOnly = false) => Field("text", key, sensitive, readOnly);

    private static JsonObject Number(string key) => Field("number", key, sensitive: false, readOnly: false);

    private static JsonObject Field(string type, string key, bool sensitive, bool readOnly)
    {
        var field = new JsonObject { ["type"] = type, ["key"] = key, ["label"] = key };
        if (sensitive)
        {
            field["sensitive"] = true;
        }

        if (readOnly)
        {
            field["readOnly"] = true;
        }

        return field;
    }

    /// <summary>start (Proposta) → "analyse" (Analistas, Conferência: the CPF read-only) → end.</summary>
    private static JsonObject Document(Guid analistas, Guid proposta, Guid conferencia) => new()
    {
        ["schemaVersion"] = 1,
        ["lanes"] = new JsonArray
        {
            new JsonObject { ["id"] = "lane_an", ["title"] = "Análise", ["group"] = new JsonObject { ["kind"] = "group", ["groupId"] = analistas.ToString() } },
        },
        ["nodes"] = new JsonArray
        {
            new JsonObject { ["id"] = "start", ["type"] = "start", ["label"] = "Início", ["form"] = new JsonObject { ["formId"] = proposta.ToString() } },
            new JsonObject
            {
                ["id"] = "analyse", ["type"] = "task", ["taskKind"] = "human", ["label"] = "Conferir", ["laneId"] = "lane_an",
                ["form"] = new JsonObject { ["formId"] = conferencia.ToString() },
            },
            new JsonObject { ["id"] = "end", ["type"] = "end", ["label"] = "Fim" },
        },
        ["flows"] = new JsonArray
        {
            new JsonObject { ["id"] = "f1", ["source"] = "start", ["target"] = "analyse" },
            new JsonObject { ["id"] = "f2", ["source"] = "analyse", ["target"] = "end" },
        },
    };

    private async Task<(Guid Instance, Guid Task, string Body)> StartAsync()
    {
        var response = await StartWithDataAsync(_s.Ana, _definition, new JsonObject { ["cpf"] = Canary, ["valor"] = 1000 });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        var view = JsonDocument.Parse(body).RootElement;
        var task = Assert.Single(view.GetProperty("openTasks").EnumerateArray()).GetProperty("id").GetGuid();
        return (view.GetProperty("id").GetGuid(), task, body);
    }

    private static async Task<string> BodyAsync(HttpClient client, string path)
    {
        var response = await client.GetAsync(path);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await response.Content.ReadAsStringAsync();
    }

    private static void AssertMasked(string body, string container = "data")
    {
        Assert.DoesNotContain(Canary, body, StringComparison.Ordinal);
        var root = JsonDocument.Parse(body).RootElement;
        Assert.False(root.GetProperty(container).TryGetProperty("cpf", out _));
        Assert.Equal(["cpf"], root.GetProperty("maskedKeys").EnumerateArray().Select(k => k.GetString()));
    }

    private static void AssertShown(string body, string container = "data")
    {
        var root = JsonDocument.Parse(body).RootElement;
        Assert.Equal(Canary, root.GetProperty(container).GetProperty("cpf").GetString());
        Assert.Empty(root.GetProperty("maskedKeys").EnumerateArray());
    }

    [Fact]
    public async Task The_requester_sends_a_sensitive_value_and_never_sees_it_again()
    {
        var (instance, _, startBody) = await StartAsync();

        AssertMasked(startBody);
        Assert.Equal(1000, JsonDocument.Parse(startBody).RootElement.GetProperty("data").GetProperty("valor").GetInt32());
        AssertMasked(await BodyAsync(_s.Ana, $"/api/instances/{instance}"));
    }

    [Fact]
    public async Task An_eligible_actor_sees_the_value_in_the_tasks_prefill_only()
    {
        var (instance, task, _) = await StartAsync();

        AssertShown(await BodyAsync(_s.Bruno, $"/api/tasks/{task}"), container: "prefill");
        AssertMasked(await BodyAsync(_s.Bruno, $"/api/instances/{instance}"));
    }

    [Fact]
    public async Task A_viewer_without_viewSensitive_sees_nothing_sensitive_in_the_request_or_its_task()
    {
        var (instance, task, _) = await StartAsync();

        AssertMasked(await BodyAsync(_s.Eva, $"/api/instances/{instance}"));
        AssertMasked(await BodyAsync(_s.Eva, $"/api/tasks/{task}"), container: "prefill");
    }

    [Fact]
    public async Task Holders_of_viewSensitive_and_admins_see_the_value()
    {
        var (instance, task, _) = await StartAsync();

        AssertShown(await BodyAsync(Gil, $"/api/instances/{instance}"));
        AssertShown(await BodyAsync(_s.Admin, $"/api/instances/{instance}"));
        AssertShown(await BodyAsync(_s.Admin, $"/api/tasks/{task}"), container: "prefill");
    }

    [Fact]
    public async Task A_command_answers_with_the_request_masked_for_whoever_sent_it()
    {
        var (_, task, _) = await StartAsync();

        var completed = await CompleteAsync(_s.Bruno, task, data: new JsonObject { ["parecer"] = "Conferido" });

        Assert.Equal(HttpStatusCode.OK, completed.StatusCode);
        AssertMasked(await completed.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task A_request_without_sensitive_values_lists_no_masked_keys()
    {
        var (instance, _, _) = await StartAsync();
        var plain = await (await CreditScenario.StartAsync(_s.Ana, _s.DefinitionId)).Content.ReadFromJsonAsync<JsonElement>();

        Assert.Empty(plain.GetProperty("maskedKeys").EnumerateArray());
        Assert.NotEqual(instance, plain.GetProperty("id").GetGuid());
    }

    [Fact]
    public async Task An_agent_gets_the_same_masking_through_MCP_and_the_HTTP_trigger()
    {
        var bot = await McpTestClient.CreateBotAsync(_s.Admin, "vendas-ia", groups: _comercial);
        await using var client = await _factory.ConnectAsync(bot.Token);

        var started = (await client.CallAsync("start_request", new { workflowId = _definition, data = new { cpf = Canary, valor = 1000 }, idempotencyKey = NewKey() })).Ok();
        AssertMasked(started.GetRawText());
        var fetched = (await client.CallAsync("get_request", new { requestId = started.GetProperty("id").GetGuid() })).Ok();
        AssertMasked(fetched.GetRawText());

        using var http = _factory.Http(bot.Token);
        using var trigger = new HttpRequestMessage(HttpMethod.Post, "/api/instances")
        {
            Content = JsonContent.Create(new { definitionId = _definition, data = new { cpf = Canary, valor = 1000 } }),
        };
        trigger.Headers.Add("Idempotency-Key", NewKey());
        var triggered = await http.SendAsync(trigger);
        Assert.Equal(HttpStatusCode.Created, triggered.StatusCode);
        AssertMasked(await triggered.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task A_corrected_sensitive_value_is_masked_in_the_timeline_for_whoever_may_not_see_it()
    {
        var pedido = await _s.PublishFormAsync("Pedido", Form(Text("prazo", sensitive: true)));
        var definition = await _s.PublishAsync("Pedido com prazo sigiloso", new JsonObject
        {
            ["schemaVersion"] = 1,
            ["lanes"] = new JsonArray
            {
                new JsonObject { ["id"] = "lane_an", ["title"] = "Análise", ["group"] = new JsonObject { ["kind"] = "group", ["groupId"] = _s.Analistas.ToString() } },
            },
            ["nodes"] = new JsonArray
            {
                new JsonObject { ["id"] = "start", ["type"] = "start", ["label"] = "Início", ["form"] = new JsonObject { ["formId"] = pedido.ToString() } },
                new JsonObject
                {
                    ["id"] = "gw", ["type"] = "gateway", ["label"] = "No prazo?", ["decisionMode"] = "automatic",
                    ["condition"] = new JsonObject
                    {
                        ["kind"] = "compare", ["left"] = new JsonObject { ["kind"] = "path", ["path"] = new JsonArray("prazo") },
                        ["operator"] = "greaterOrEqual", ["right"] = new JsonObject { ["kind"] = "literal", ["type"] = "date", ["value"] = "2026-01-01" },
                    },
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
        });
        await _s.GrantAsync(definition, [(_comercial, "start"), (_auditoria, "view")]);
        var faulted = await StartWithDataAsync(_s.Ana, definition, new JsonObject { ["prazo"] = "amanhã" }); // not a date: the gateway faults
        var instance = (await faulted.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var corrected = await CorrectAsync(_s.Admin, instance, await CurrentETagAsync(_s.Admin, instance),
            new { changes = new JsonObject { ["prazo"] = "2026-12-01" }, justification = "O prazo veio em texto" });
        Assert.Equal(HttpStatusCode.OK, corrected.StatusCode);

        static JsonElement Change(JsonElement view) =>
            Assert.Single(Assert.Single(view.GetProperty("timeline").EnumerateArray(), e => e.GetProperty("type").GetString() == "data.corrected")
                .GetProperty("details").GetProperty("changes").EnumerateArray());

        var hidden = await BodyAsync(_s.Eva, $"/api/instances/{instance}");
        Assert.DoesNotContain("amanhã", hidden, StringComparison.Ordinal);
        var incident = Assert.Single(JsonDocument.Parse(hidden).RootElement.GetProperty("incidents").EnumerateArray());
        Assert.Equal("type_mismatch", incident.GetProperty("code").GetString());
        Assert.Equal(JsonValueKind.Null, incident.GetProperty("message").ValueKind); // it quoted the value
        var masked = Change(JsonDocument.Parse(hidden).RootElement);
        Assert.Equal("prazo", masked.GetProperty("key").GetString());
        Assert.True(masked.GetProperty("masked").GetBoolean());
        Assert.False(masked.TryGetProperty("before", out _));

        var admin = await _s.Admin.GetFromJsonAsync<JsonElement>($"/api/instances/{instance}");
        Assert.Equal("'amanhã' is not a date.", Assert.Single(admin.GetProperty("incidents").EnumerateArray()).GetProperty("message").GetString());
        var shown = Change(admin);
        Assert.Equal("amanhã", shown.GetProperty("before").GetString());
        Assert.Equal("2026-12-01", shown.GetProperty("after").GetString());
    }

    /// <summary>The <c>sensitive.revealed</c> records as "actor request keys entryPoint".</summary>
    private Task<List<string>> RevealsAsync() => _factory.QueryAsync(
        "SELECT actor_id::text || ' ' || subject_id::text || ' ' || (details->>'keys') || ' ' || coalesce(details->>'entryPoint', '-') "
        + "FROM chain.audit_events WHERE action = 'sensitive.revealed' ORDER BY occurred_at, id");

    [Fact]
    public async Task Each_response_that_shows_a_sensitive_value_is_audited_without_the_value()
    {
        var (instance, task, _) = await StartAsync();
        await BodyAsync(_s.Eva, $"/api/instances/{instance}"); // hidden: not a reveal
        Assert.Empty(await RevealsAsync());

        await BodyAsync(Gil, $"/api/instances/{instance}");
        await BodyAsync(_s.Bruno, $"/api/tasks/{task}"); // the task rule

        Assert.Equal( // the test clock stands still, so the two records share a time
            new[] { $"{_s.UserIds["gil"]} {instance} cpf ui", $"{_s.UserIds["bruno"]} {instance} cpf ui" }.Order(),
            (await RevealsAsync()).Order());
        Assert.Equal(0, await _factory.CountAsync($"SELECT count(*) FROM chain.audit_events WHERE details::text LIKE '%{Canary}%'"));
    }

    [Fact]
    public async Task A_reveal_through_MCP_records_mcp_as_its_entry_point()
    {
        var (instance, _, _) = await StartAsync();
        var bot = await McpTestClient.CreateBotAsync(_s.Admin, "auditoria-ia", groups: _sigilo);
        await using var client = await _factory.ConnectAsync(bot.Token);

        var shown = (await client.CallAsync("get_request", new { requestId = instance })).Ok();

        Assert.Equal(Canary, shown.GetProperty("data").GetProperty("cpf").GetString());
        Assert.Equal([$"{bot.Id} {instance} cpf mcp"], await RevealsAsync());
    }

    [Fact]
    public async Task EF_logs_no_parameter_values_outside_development()
    {
        await using var scope = _factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ChainDbContext>();

        var options = db.GetService<IDbContextOptions>().FindExtension<CoreOptionsExtension>();

        Assert.False(options?.IsSensitiveDataLoggingEnabled ?? false);
    }
}
