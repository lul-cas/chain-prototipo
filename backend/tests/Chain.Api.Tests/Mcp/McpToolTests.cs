using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Chain.Api.Tests.Engine;
using Chain.Api.Tests.Infrastructure;
using ModelContextProtocol;
using ModelContextProtocol.Client;

namespace Chain.Api.Tests.Mcp;

/// <summary>
/// The tools of the first release through the official SDK client (ADR-0015 §6–§8; mcp.md §2–§6), over the credit scenario:
/// "vendas-ia" is a bot in Comercial (start), "analista-ia" a bot in Analistas.
/// </summary>
[Collection(PostgresTestGroup.Name)]
public sealed class McpToolTests(PostgresFixture postgres) : IAsyncLifetime, IDisposable
{
    private static readonly string[] ToolNames =
    [
        "list_startable_workflows", "get_start_form", "start_request", "list_my_requests", "get_request", "list_my_tasks",
        "get_task", "start_working_on_task", "take_over_task", "complete_task", "decide_task", "add_comment",
    ];

    private static readonly string[] LosingCodes = ["concurrency_conflict", "task_not_open", "task_assigned"];

    private readonly ChainApiFactory _factory = new(postgres.ConnectionString);
    private CreditScenario _s = null!;
    private McpBot _seller = null!;
    private McpBot _analyst = null!;

    public async Task InitializeAsync()
    {
        await _factory.ResetDatabaseAsync();
        _s = await CreditScenario.CreateAsync(_factory);
        _seller = await McpTestClient.CreateBotAsync(_s.Admin, "vendas-ia", groups: await GroupIdAsync("Comercial"));
        _analyst = await McpTestClient.CreateBotAsync(_s.Admin, "analista-ia", groups: _s.Analistas);
    }

    public Task DisposeAsync() => Task.CompletedTask;

    public void Dispose()
    {
        _s.Dispose();
        _factory.Dispose();
    }

    // 1. Discovery and contract

    [Fact]
    public async Task Tools_are_listed_in_a_fixed_order_with_strict_schemas_and_hints()
    {
        await using var client = await _factory.ConnectAsync(_seller.Token);

        var tools = await client.ListToolsAsync();

        Assert.Equal(ToolNames, tools.Select(t => t.Name));
        Assert.Equal(ToolNames, (await client.ListToolsAsync()).Select(t => t.Name));
        foreach (var tool in tools.Select(t => t.ProtocolTool))
        {
            Assert.Equal("object", tool.InputSchema.GetProperty("type").GetString());
            Assert.False(tool.InputSchema.GetProperty("additionalProperties").GetBoolean());
            Assert.False(tool.Annotations!.OpenWorldHint);
            Assert.False(string.IsNullOrWhiteSpace(tool.Description));
            Assert.Null(tool.OutputSchema);
        }

        var hints = tools.ToDictionary(t => t.Name, t => t.ProtocolTool.Annotations!);
        Assert.All(["list_startable_workflows", "get_start_form", "list_my_requests", "get_request", "list_my_tasks", "get_task"], name =>
            Assert.True(hints[name].ReadOnlyHint));
        Assert.All(["start_request", "start_working_on_task", "add_comment"], name =>
            Assert.Equal((false, false, true), (hints[name].ReadOnlyHint!.Value, hints[name].DestructiveHint!.Value, hints[name].IdempotentHint!.Value)));
        Assert.All(["take_over_task", "complete_task", "decide_task"], name =>
            Assert.Equal((false, true, true), (hints[name].ReadOnlyHint!.Value, hints[name].DestructiveHint!.Value, hints[name].IdempotentHint!.Value)));

        var required = tools.ToDictionary(t => t.Name, t => Required(t.ProtocolTool.InputSchema));
        Assert.Equal(["workflowId", "idempotencyKey"], required["start_request"]);
        Assert.Equal(["taskId", "idempotencyKey"], required["complete_task"]);
        Assert.Equal(["taskId", "outcome", "idempotencyKey"], required["decide_task"]);
        Assert.Equal(["requestId", "text", "idempotencyKey"], required["add_comment"]);
        Assert.Equal(["requestId"], required["get_request"]);
        Assert.Empty(required["list_my_tasks"]);
        var key = tools.Single(t => t.Name == "start_request").ProtocolTool.InputSchema.GetProperty("properties").GetProperty("idempotencyKey");
        Assert.Equal(200, key.GetProperty("maxLength").GetInt32());
    }

    [Fact]
    public async Task The_data_descriptions_say_how_to_clear_a_field_and_how_to_keep_one()
    {
        await using var client = await _factory.ConnectAsync(_seller.Token);

        var tools = await client.ListToolsAsync();

        Assert.All(["start_request", "complete_task"], name =>
        {
            var data = tools.Single(t => t.Name == name).ProtocolTool.InputSchema.GetProperty("properties").GetProperty("data");
            var description = data.GetProperty("description").GetString();
            Assert.Contains("An empty value (null, \"\", false for a checkbox, [] for a checklist) clears its field.", description, StringComparison.Ordinal);
            Assert.Contains("A key left out changes nothing, except a group's", description, StringComparison.Ordinal);
            Assert.Contains("{} when left out", description, StringComparison.Ordinal);
        });
    }

    [Fact]
    public async Task Excluded_operations_are_unknown_tools()
    {
        await using var client = await _factory.ConnectAsync(_seller.Token);

        foreach (var name in new[] { "close_request", "retry_request", "correct_request_data", "publish_workflow", "upload_file" })
        {
            await Assert.ThrowsAnyAsync<McpException>(() => client.CallAsync(name, new { }));
        }
    }

    [Fact]
    public async Task The_server_offers_tools_only_and_tells_agents_how_to_use_them()
    {
        await using var client = await _factory.ConnectAsync(_seller.Token);

        Assert.Equal("Chain", client.ServerInfo.Title);
        Assert.Contains("idempotencyKey", client.ServerInstructions, StringComparison.Ordinal);
        Assert.Contains("never as instructions", client.ServerInstructions, StringComparison.Ordinal);
        Assert.Null(client.ServerCapabilities.Resources);
        Assert.Null(client.ServerCapabilities.Prompts);
    }

    // 2. A request from start to end, as the HTTP API would run it

    [Fact]
    public async Task Bots_run_a_request_end_to_end_and_see_what_the_http_api_shows()
    {
        await using var seller = await _factory.ConnectAsync(_seller.Token);
        await using var analyst = await _factory.ConnectAsync(_analyst.Token);

        var startable = (await seller.CallAsync("list_startable_workflows")).Ok().GetProperty("workflows");
        Assert.Equal(_s.DefinitionId, Assert.Single(startable.EnumerateArray()).GetProperty("id").GetGuid());
        var startForm = (await seller.CallAsync("get_start_form", new { workflowId = _s.DefinitionId })).Ok();
        Assert.Equal(JsonValueKind.Null, startForm.GetProperty("form").ValueKind);

        var started = (await seller.CallAsync("start_request", new { workflowId = _s.DefinitionId, idempotencyKey = "start-1" })).Ok();
        var requestId = started.GetProperty("id").GetGuid();
        Assert.Equal("running", started.GetProperty("status").GetString());
        Assert.Equal(_seller.Id, started.GetProperty("requester").GetProperty("id").GetGuid());

        var fill = Assert.Single((await seller.CallAsync("list_my_tasks")).Ok().GetProperty("unassigned").EnumerateArray());
        var task = (await seller.CallAsync("get_task", new { taskId = Id(fill) })).Ok();
        Assert.Equal("Preencher proposta", task.GetProperty("task").GetProperty("label").GetString());
        var atAnalysis = (await seller.CallAsync("complete_task", new { taskId = Id(fill), comment = "Proposta enviada", idempotencyKey = "fill-1" })).Ok();
        Assert.Equal("analyse", Assert.Single(atAnalysis.GetProperty("openTasks").EnumerateArray()).GetProperty("nodeId").GetString());

        var analyse = Assert.Single((await analyst.CallAsync("list_my_tasks")).Ok().GetProperty("unassigned").EnumerateArray());
        var working = (await analyst.CallAsync("start_working_on_task", new { taskId = Id(analyse), idempotencyKey = "work-1" })).Ok();
        Assert.Equal(_analyst.Id, working.GetProperty("assignee").GetProperty("id").GetGuid());
        var atDecision = (await analyst.CallAsync("complete_task", new { taskId = Id(analyse), idempotencyKey = "analyse-1" })).Ok();
        var decision = Assert.Single(atDecision.GetProperty("openTasks").EnumerateArray());
        var done = (await analyst.CallAsync("decide_task", new { taskId = Id(decision), outcome = true, justification = "Documentos ok", idempotencyKey = "decide-1" })).Ok();
        Assert.Equal("completed", done.GetProperty("status").GetString());

        var throughMcp = (await seller.CallAsync("get_request", new { requestId })).Ok();
        using var http = _factory.Http(_seller.Token);
        var throughHttp = await http.GetFromJsonAsync<JsonElement>($"/api/instances/{requestId}");
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(throughHttp.GetRawText()), JsonNode.Parse(throughMcp.GetRawText())), "MCP and HTTP show the same request");
        var actors = throughMcp.GetProperty("timeline").EnumerateArray()
            .Where(e => e.GetProperty("actor").ValueKind == JsonValueKind.Object)
            .Select(e => e.GetProperty("actor").GetProperty("username").GetString()).Distinct().Order();
        Assert.Equal(["analista-ia", "vendas-ia"], actors);
        Assert.All(throughMcp.GetProperty("timeline").EnumerateArray(), e => Assert.Equal("mcp", e.GetProperty("channel").GetString())); // card #83, N9b-1
        var mine = (await seller.CallAsync("list_my_requests", new { status = "completed" })).Ok().GetProperty("requests");
        Assert.Equal(requestId, Assert.Single(mine.EnumerateArray()).GetProperty("id").GetGuid());
    }

    [Fact]
    public async Task A_bot_takes_over_a_task_a_person_is_working_on()
    {
        await using var analyst = await _factory.ConnectAsync(_analyst.Token);
        var analyse = await AtAnalysisAsync();
        Assert.Equal(HttpStatusCode.OK, (await CreditScenario.StartWorkingAsync(_s.Bruno, analyse)).StatusCode);

        (await analyst.CallAsync("complete_task", new { taskId = analyse, idempotencyKey = "too-soon" })).Error("task_assigned");
        var taken = (await analyst.CallAsync("take_over_task", new { taskId = analyse, idempotencyKey = "take-1" })).Ok();

        Assert.Equal(_analyst.Id, taken.GetProperty("assignee").GetProperty("id").GetGuid());
        var request = (await analyst.CallAsync("get_request", new { requestId = taken.GetProperty("instanceId").GetGuid() })).Ok();
        Assert.Contains(request.GetProperty("timeline").EnumerateArray(), e => e.GetProperty("type").GetString() == "task.taken_over");
    }

    [Fact]
    public async Task Concurrent_completions_succeed_once_and_the_others_get_a_code()
    {
        var analyse = await AtAnalysisAsync();
        var second = await McpTestClient.CreateBotAsync(_s.Admin, "analista-ia-2", groups: _s.Analistas);
        await using var one = await _factory.ConnectAsync(_analyst.Token);
        await using var two = await _factory.ConnectAsync(second.Token);

        var results = await Task.WhenAll(
            one.CallAsync("complete_task", new { taskId = analyse, idempotencyKey = "a" }),
            two.CallAsync("complete_task", new { taskId = analyse, idempotencyKey = "b" }),
            one.CallAsync("complete_task", new { taskId = analyse, idempotencyKey = "c" }),
            two.CallAsync("complete_task", new { taskId = analyse, idempotencyKey = "d" }));

        Assert.Single(results, r => r.IsError is null or false);
        Assert.All(results.Where(r => r.IsError == true), r =>
            Assert.Contains(r.StructuredContent!.Value.GetProperty("code").GetString(), LosingCodes));
    }

    [Fact]
    public async Task A_database_conflict_is_concurrency_conflict_as_on_http()
    {
        await using var seller = await _factory.ConnectAsync(_seller.Token);
        using var http = _factory.Http(_seller.Token);
        var requestId = (await seller.CallAsync("start_request", new { workflowId = _s.DefinitionId, idempotencyKey = "start-1" })).Ok().GetProperty("id").GetGuid();
        // A concurrent writer is simulated by a trigger that raises unique_violation, which the store reports as a conflict.
        await _factory.QueryAsync("""
            CREATE FUNCTION chain.test_simulated_conflict() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF NEW.details->>'text' = 'conflito simulado' THEN
                    RAISE EXCEPTION 'simulated concurrent write' USING ERRCODE = 'unique_violation';
                END IF;
                RETURN NEW;
            END $$;
            CREATE TRIGGER test_simulated_conflict BEFORE INSERT ON chain.instance_events
                FOR EACH ROW EXECUTE FUNCTION chain.test_simulated_conflict();
            """);
        try
        {
            (await seller.CallAsync("add_comment", new { requestId, text = "conflito simulado", idempotencyKey = "comment-1" })).Error("concurrency_conflict");

            var response = await CreditScenario.PostAsync(http, $"/api/instances/{requestId}/comments", new { text = "conflito simulado" }, "comment-2");
            await response.AssertProblemAsync(HttpStatusCode.Conflict, "concurrency_conflict");
        }
        finally
        {
            await _factory.QueryAsync("DROP TRIGGER test_simulated_conflict ON chain.instance_events; DROP FUNCTION chain.test_simulated_conflict();");
        }

        (await seller.CallAsync("add_comment", new { requestId, text = "conflito simulado", idempotencyKey = "comment-1" })).Ok();
    }

    [Fact]
    public async Task Comments_go_to_the_timeline()
    {
        await using var seller = await _factory.ConnectAsync(_seller.Token);
        var requestId = (await seller.CallAsync("start_request", new { workflowId = _s.DefinitionId, idempotencyKey = "start-1" })).Ok().GetProperty("id").GetGuid();

        var commented = (await seller.CallAsync("add_comment", new { requestId, text = "Cliente pediu urgência", idempotencyKey = "comment-1" })).Ok();

        var comment = commented.GetProperty("timeline").EnumerateArray().Single(e => e.GetProperty("type").GetString() == "comment.added");
        Assert.Equal("vendas-ia", comment.GetProperty("actor").GetProperty("username").GetString());
        var empty = (await seller.CallAsync("add_comment", new { requestId, text = "  ", idempotencyKey = "comment-2" })).Error("validation_failed");
        Assert.Equal(["comment_empty"], Details(empty));
    }

    // Regression #129: the timeline stores comments in jsonb, which cannot store the NUL character. The call failed in the
    // database and the SDK answered "An error occurred invoking 'add_comment'." The service now refuses it, for every entry point.

    [Fact]
    public async Task A_comment_with_the_NUL_character_is_a_validation_error()
    {
        await using var seller = await _factory.ConnectAsync(_seller.Token);
        var requestId = (await seller.CallAsync("start_request", new { workflowId = _s.DefinitionId, idempotencyKey = "start-1" })).Ok().GetProperty("id").GetGuid();

        var refused = (await seller.CallAsync("add_comment", new { requestId, text = "Cliente\u0000pediu urgência", idempotencyKey = "comment-1" })).Error("validation_failed");

        Assert.Equal(["invalid_comment"], Details(refused));
        Assert.Equal(0, await _factory.CountAsync("SELECT count(*) FROM chain.instance_events WHERE type = 'comment.added'"));
    }

    // 3. Errors

    [Fact]
    public async Task Business_errors_are_tool_errors_with_the_http_codes()
    {
        await using var seller = await _factory.ConnectAsync(_seller.Token);
        var outsider = await McpTestClient.CreateBotAsync(_s.Admin, "sem-grupo");
        await using var nobody = await _factory.ConnectAsync(outsider.Token);

        (await seller.CallAsync("get_request", new { requestId = Guid.NewGuid() })).Error("not_found");
        (await nobody.CallAsync("start_request", new { workflowId = _s.DefinitionId, idempotencyKey = "k1" })).Error("forbidden");
        var invalid = (await seller.CallAsync("start_request", new { workflowId = _s.DefinitionId, data = new { valor = 10 }, idempotencyKey = "k2" })).Error("submission_invalid");
        var field = Assert.Single(invalid.GetProperty("fieldErrors").EnumerateArray());
        Assert.Equal((string.Empty, "unexpected_data"), (field.GetProperty("key").GetString(), field.GetProperty("code").GetString()));

        var requestId = (await seller.CallAsync("start_request", new { workflowId = _s.DefinitionId, idempotencyKey = "k3" })).Ok().GetProperty("id").GetGuid();
        (await nobody.CallAsync("get_request", new { requestId })).Error("not_found");
        var fill = Assert.Single((await seller.CallAsync("list_my_tasks")).Ok().GetProperty("unassigned").EnumerateArray());
        (await seller.CallAsync("decide_task", new { taskId = Id(fill), outcome = true, idempotencyKey = "k4" })).Error("wrong_task_kind");
    }

    [Fact]
    public async Task Malformed_arguments_are_validation_errors_that_name_the_problem()
    {
        await using var seller = await _factory.ConnectAsync(_seller.Token);

        Assert.Equal(["invalid_request_id"], Details((await seller.CallAsync("get_request", new { requestId = "42" })).Error("validation_failed")));
        Assert.Equal(["invalid_request_id"], Details((await seller.CallAsync("get_request")).Error("validation_failed")));
        Assert.Equal(["invalid_task_id", "outcome_required"], Details((await seller.CallAsync("decide_task", new { taskId = 7, outcome = "sim", idempotencyKey = "k" })).Error("validation_failed")));
        Assert.Equal(["invalid_scope", "invalid_status"], Details((await seller.CallAsync("list_my_requests", new { scope = "all", status = "Running" })).Error("validation_failed")));
        Assert.Equal(["invalid_comment"], Details((await seller.CallAsync("complete_task", new { taskId = Guid.NewGuid(), comment = 1, idempotencyKey = "k" })).Error("validation_failed")));

        var unknown = (await seller.CallAsync("get_task", new { task_id = Guid.NewGuid() })).Error("validation_failed");
        Assert.Equal(["unknown_argument", "invalid_task_id"], Details(unknown));
        Assert.Contains("This tool takes: taskId.", unknown.GetProperty("message").GetString(), StringComparison.Ordinal);
    }

    // Regression #205: the SDK reads tool arguments by throwing on text that is not Unicode, so an unpaired surrogate (\ud800) in
    // any argument answered JSON-RPC -32603 "An error occurred.". Each argument now gets its own validation error, data gets the
    // HTTP API's invalid_value, and nothing is stored (mcp.md §3).

    [Fact]
    public async Task An_argument_with_an_unpaired_surrogate_gets_its_own_validation_error()
    {
        using var http = _factory.Http(_seller.Token);
        var id = Guid.NewGuid();

        Assert.Equal(["invalid_text"], Details((await http.RawCallAsync("add_comment", $$"""{"requestId":"{{id}}","text":"Oi\ud800","idempotencyKey":"k1"}""")).RawError("validation_failed")));
        Assert.Equal(["invalid_comment"], Details((await http.RawCallAsync("complete_task", $$"""{"taskId":"{{id}}","comment":"Oi\udc00","idempotencyKey":"k2"}""")).RawError("validation_failed")));
        Assert.Equal(["invalid_justification"], Details((await http.RawCallAsync("decide_task", $$"""{"taskId":"{{id}}","outcome":true,"justification":"\ud800","idempotencyKey":"k3"}""")).RawError("validation_failed")));
        Assert.Equal(["invalid_request_id"], Details((await http.RawCallAsync("get_request", """{"requestId":"\ud800"}""")).RawError("validation_failed")));
        Assert.Equal(["invalid_scope", "invalid_status"], Details((await http.RawCallAsync("list_my_requests", """{"scope":"\ud800","status":"x\udfff"}""")).RawError("validation_failed")));
        Assert.Equal(["invalid_idempotency_key"], Details((await http.RawCallAsync("add_comment", $$"""{"requestId":"{{id}}","text":"Oi","idempotencyKey":"k\ud800"}""")).RawError("validation_failed")));

        foreach (var data in new[] { """{"cliente":"Ana\ud800"}""", """{"cliente\ud800":"Ana"}""", """{"itens":[{"nome":"\ud800"}]}""" })
        {
            var field = Assert.Single((await http.RawCallAsync("start_request", $$"""{"workflowId":"{{_s.DefinitionId}}","data":{{data}},"idempotencyKey":"k4"}"""))
                .RawError("submission_invalid").GetProperty("fieldErrors").EnumerateArray());
            Assert.Equal((string.Empty, "invalid_value"), (field.GetProperty("key").GetString(), field.GetProperty("code").GetString()));
        }

        var name = (await http.RawCallAsync("get_request", $$"""{"requestId":"{{id}}","x\ud800":1}""")).RawError("validation_failed");
        Assert.Equal(["unknown_argument"], Details(name));
        Assert.Contains("This tool takes: requestId.", name.GetProperty("message").GetString(), StringComparison.Ordinal);

        Assert.Equal(0, await _factory.CountAsync("SELECT count(*) FROM chain.instances"));
        Assert.Equal(0, await _factory.CountAsync("SELECT count(*) FROM chain.idempotency_keys"));
    }

    // Card #205: an idempotencyKey is stored as text, which PostgreSQL refuses with NUL (22021). The tool failed with a generic
    // error; the key is now refused like any argument that cannot be stored (identity.md I1).

    [Fact]
    public async Task An_idempotency_key_with_the_NUL_character_is_a_validation_error()
    {
        await using var seller = await _factory.ConnectAsync(_seller.Token);

        var error = (await seller.CallAsync("start_request", new { workflowId = _s.DefinitionId, idempotencyKey = "pedido\u0000" })).Error("validation_failed");

        Assert.Equal(["invalid_idempotency_key"], Details(error));
        Assert.Equal(0, await _factory.CountAsync("SELECT count(*) FROM chain.instances"));
    }

    // 4. Idempotency (mcp.md §4)

    [Fact]
    public async Task Write_tools_replay_by_key_and_refuse_a_key_reused_for_another_call()
    {
        await using var seller = await _factory.ConnectAsync(_seller.Token);

        var first = (await seller.CallAsync("start_request", new { workflowId = _s.DefinitionId, idempotencyKey = "pedido-1" })).Ok();
        var replay = (await seller.CallAsync("start_request", new { workflowId = _s.DefinitionId, idempotencyKey = "pedido-1" })).Ok();
        Assert.Equal(first.GetProperty("id").GetGuid(), replay.GetProperty("id").GetGuid());
        Assert.Equal(1, await _factory.CountAsync("SELECT count(*) FROM chain.instances"));

        (await seller.CallAsync("start_request", new { workflowId = _s.DefinitionId, data = new { }, idempotencyKey = "pedido-1" })).Error("idempotency_key_reused");
        (await seller.CallAsync("add_comment", new { requestId = first.GetProperty("id").GetGuid(), text = "x", idempotencyKey = "pedido-1" })).Error("idempotency_key_reused");
        Assert.Equal(["idempotency_key_required"], Details((await seller.CallAsync("start_request", new { workflowId = _s.DefinitionId })).Error("validation_failed")));
        Assert.Equal(["idempotency_key_required"], Details((await seller.CallAsync("start_request", new { workflowId = _s.DefinitionId, idempotencyKey = " " })).Error("validation_failed")));
        Assert.Equal(["idempotency_key_too_long"], Details((await seller.CallAsync("start_request", new { workflowId = _s.DefinitionId, idempotencyKey = new string('k', 201) })).Error("validation_failed")));
        Assert.Equal(1, await _factory.CountAsync("SELECT count(*) FROM chain.instances"));
    }

    [Fact]
    public async Task A_key_belongs_to_one_tool_even_when_the_arguments_match()
    {
        await using var analyst = await _factory.ConnectAsync(_analyst.Token);
        var analyse = await AtAnalysisAsync();

        (await analyst.CallAsync("start_working_on_task", new { taskId = analyse, idempotencyKey = "tarefa-1" })).Ok();

        (await analyst.CallAsync("take_over_task", new { taskId = analyse, idempotencyKey = "tarefa-1" })).Error("idempotency_key_reused");
    }

    [Fact]
    public async Task Mcp_and_http_share_the_bots_key_space()
    {
        await using var seller = await _factory.ConnectAsync(_seller.Token);
        using var http = _factory.Http(_seller.Token);
        Assert.Equal(HttpStatusCode.Created, (await CreditScenario.StartAsync(http, _s.DefinitionId, key: "compartilhada")).StatusCode);

        (await seller.CallAsync("start_request", new { workflowId = _s.DefinitionId, idempotencyKey = "compartilhada" })).Error("idempotency_key_reused");

        Assert.Equal(1, await _factory.CountAsync("SELECT count(*) FROM chain.instances"));
    }

    // 5. Rate limit (mcp.md §5)

    [Fact]
    public async Task Sixty_calls_a_minute_then_rate_limited_without_effect_until_the_next_minute()
    {
        await using var seller = await _factory.ConnectAsync(_seller.Token);
        await using var analyst = await _factory.ConnectAsync(_analyst.Token);
        Assert.NotEmpty(await seller.ListToolsAsync()); // listing is not a call

        for (var i = 0; i < 60; i++)
        {
            (await seller.CallAsync("list_my_tasks")).Ok();
        }

        var limited = (await seller.CallAsync("start_request", new { workflowId = _s.DefinitionId, idempotencyKey = "over" })).Error("rate_limited");
        Assert.Equal(60, limited.GetProperty("retryAfterSeconds").GetInt32()); // the fake clock sits on a minute boundary
        Assert.Equal(0, await _factory.CountAsync("SELECT count(*) FROM chain.instances"));
        (await analyst.CallAsync("list_my_tasks")).Ok(); // limits are per bot

        _factory.Time.Advance(TimeSpan.FromSeconds(45));
        Assert.Equal(15, (await seller.CallAsync("list_my_tasks")).Error("rate_limited").GetProperty("retryAfterSeconds").GetInt32());
        _factory.Time.Advance(TimeSpan.FromSeconds(15));
        (await seller.CallAsync("start_request", new { workflowId = _s.DefinitionId, idempotencyKey = "over" })).Ok();
    }

    // Helpers

    private async Task<Guid> GroupIdAsync(string name) =>
        (await _s.Admin.GetFromJsonAsync<JsonElement>("/api/admin/groups")).EnumerateArray()
            .Single(g => g.GetProperty("name").GetString() == name).GetProperty("id").GetGuid();

    /// <summary>A request started by Ana and filled in, waiting at "Analisar"; returns that task's id.</summary>
    private async Task<Guid> AtAnalysisAsync()
    {
        var instanceId = await CreditScenario.StartedInstanceAsync(_s.Ana, _s.DefinitionId);
        Assert.Equal(HttpStatusCode.OK, (await CreditScenario.CompleteAsync(_s.Ana, CreditScenario.Id(await CreditScenario.OpenTaskAsync(_s.Ana, instanceId)))).StatusCode);
        return CreditScenario.Id(await CreditScenario.OpenTaskAsync(_s.Bruno, instanceId));
    }

    private static Guid Id(JsonElement element) => element.GetProperty("id").GetGuid();

    private static List<string> Required(JsonElement schema) =>
        schema.TryGetProperty("required", out var required) ? [.. required.EnumerateArray().Select(r => r.GetString()!)] : [];

    private static List<string> Details(JsonElement error) => [.. error.GetProperty("details").EnumerateArray().Select(d => d.GetString()!)];
}
