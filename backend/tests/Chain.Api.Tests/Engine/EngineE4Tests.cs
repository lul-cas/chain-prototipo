using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Chain.Api.Tests.Infrastructure;
using Chain.Workflows.Application.Engine;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using static Chain.Api.Tests.Engine.CreditScenario;

namespace Chain.Api.Tests.Engine;

/// <summary>
/// Engine increment E4a step 4b: a token reaching an automation step dispatches a work request in the same command (automation.md
/// §6.1), faults when it cannot (§6.4), and closing the request cancels it (§6.5). The scenario is the shared contract fixture's.
/// </summary>
[Collection(PostgresTestGroup.Name)]
public sealed partial class EngineE4Tests(PostgresFixture postgres) : IAsyncLifetime, IDisposable
{
    private const string Destinations = "/api/admin/automation/destinations";
    private const string Secrets = "/api/admin/automation/secrets";
    private static readonly string[] Erp = ["erp"];
    private static readonly JsonElement Fixture =
        JsonDocument.Parse(File.ReadAllText(System.IO.Path.Combine(AppContext.BaseDirectory, "contract", "work-request.json"))).RootElement;

    private readonly ChainApiFactory _factory = new(postgres.ConnectionString);
    private CreditScenario _s = null!;
    private Guid _automation;
    private Guid _proposta;
    private Guid _cadastro;
    private Guid _comercial;
    private Guid _supervisores;

    public async Task InitializeAsync()
    {
        await _factory.ResetDatabaseAsync();
        _s = await CreditScenario.CreateAsync(_factory);
        _comercial = await OnlyGroupAsync(_s.Ana);
        _supervisores = await OnlyGroupAsync(_s.Diego);
        Assert.Equal(HttpStatusCode.Created, (await _s.Admin.PostAsJsonAsync(Destinations, new { name = "erp", host = "api.erp.example", pathPrefix = "/v1" })).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await _s.Admin.PostAsJsonAsync(Secrets, new { name = "erp_api_key", value = "s3cret-value", allowedDestinations = Erp })).StatusCode);
        _automation = await PublishAutomationAsync();
        _proposta = await _s.PublishFormAsync("Proposta", new JsonObject
        {
            ["schemaVersion"] = 1,
            ["components"] = new JsonArray
            {
                new JsonObject { ["type"] = "text", ["key"] = "cpf", ["label"] = "CPF" },
                new JsonObject { ["type"] = "number", ["key"] = "valor", ["label"] = "Valor" },
            },
        });
        _cadastro = await _s.PublishAsync("Cadastro", CadastroDocument());
        await _s.GrantAsync(_cadastro, [(_comercial, "start"), (_supervisores, "close")]);
    }

    public Task DisposeAsync() => Task.CompletedTask;

    public void Dispose()
    {
        _s?.Dispose();
        _factory.Dispose();
    }

    // Dispatch (§6.1)

    [Fact]
    public async Task Reaching_an_automation_step_writes_the_fixture_work_request_and_waits_without_a_task()
    {
        var instanceId = await StartAsync(Fixture.GetProperty("scenario").GetProperty("instanceData"));

        var view = await _s.Admin.GetFromJsonAsync<JsonElement>($"/api/instances/{instanceId}");
        Assert.Equal("running|task_cpf|0", $"{view.GetProperty("status")}|{view.GetProperty("currentNodeId")}|{view.GetProperty("openTasks").GetArrayLength()}");
        var requestId = Guid.Parse(Assert.Single(await _factory.QueryAsync(
            "select id::text from chain.automation_work_requests where kind = 'execute' and status = 'pending' and node_id = 'task_cpf' and activation = 1 and idempotency_key = id::text")));

        var payload = JsonNode.Parse(Assert.Single(await _factory.QueryAsync("select payload::text from chain.automation_work_requests")))!.AsObject();
        var expected = JsonNode.Parse(Fixture.GetProperty("expected").GetRawText())!.AsObject();
        Assert.Equal(requestId.ToString(), Take(payload, "requestId"));
        Assert.Equal(instanceId.ToString(), Take(payload, "instanceId"));
        Assert.Equal(_automation.ToString(), Take(payload, "automation.id"));
        Assert.Equal(requestId.ToString(), Take(payload, "idempotency.key"));
        Assert.Matches(TraceId(), Take(payload, "correlationId"));
        var traceparent = Take(payload, "traceparent");
        Assert.True(traceparent is null || TraceParent().IsMatch(traceparent), traceparent);
        Assert.Equal("2026-10-15T12:16:30Z", Take(payload, "deadlineAt")); // the test clock + 990 s
        foreach (var path in new[] { "requestId", "instanceId", "automation.id", "idempotency.key", "correlationId", "traceparent", "deadlineAt" })
        {
            Take(expected, path);
        }

        Assert.True(JsonNode.DeepEquals(expected, payload), payload.ToJsonString());

        var requested = Event(view, "automation.requested");
        Assert.Equal($"task_cpf|Consultar CPF|{requestId}|{_automation}|1|1|2026-10-15T12:16:30Z", string.Join('|', // the label: card #139
            requested.GetProperty("nodeId"), requested.GetProperty("label"), requested.GetProperty("requestId"), requested.GetProperty("automationId"),
            requested.GetProperty("automationVersion"), requested.GetProperty("activation"), requested.GetProperty("deadlineAt")));
        Assert.Equal(["execute"], await _factory.QueryAsync($"select kind from chain.automation_dispatch_v1 where request_id = '{requestId}' and payload is not null"));
    }

    [Fact]
    public async Task Inputs_that_break_the_contract_fault_the_step_and_a_retry_dispatches_after_correction()
    {
        var instanceId = await StartAsync(JsonDocument.Parse("""{"valor":1500}""").RootElement);

        var faulted = await _s.Admin.GetFromJsonAsync<JsonElement>($"/api/instances/{instanceId}");
        Assert.Equal("faulted|task_cpf", $"{faulted.GetProperty("status")}|{faulted.GetProperty("currentNodeId")}");
        var incident = Assert.Single(faulted.GetProperty("incidents").EnumerateArray());
        Assert.Equal("automation_input_invalid|The input 'cpf' is required.", $"{incident.GetProperty("code")}|{incident.GetProperty("message")}");
        Assert.Equal(["0"], await _factory.QueryAsync("select count(*) from chain.automation_work_requests"));

        var corrected = await CorrectAsync(_s.Admin, instanceId, await CurrentETagAsync(_s.Admin, instanceId),
            new { changes = new JsonObject { ["cpf"] = "123.456.789-09" }, justification = "CPF informado pelo cliente por telefone." });
        Assert.Equal(HttpStatusCode.OK, corrected.StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await PostAsync(_s.Admin, $"/api/instances/{instanceId}/retry", null, NewKey())).StatusCode);

        var resumed = await _s.Admin.GetFromJsonAsync<JsonElement>($"/api/instances/{instanceId}");
        Assert.Equal("running", resumed.GetProperty("status").GetString());
        Assert.Equal(["execute|pending|1|https://api.erp.example/v1/clientes/123.456.789-09/consultas?origem=chain&valor=1500"],
            await _factory.QueryAsync("select kind || '|' || status || '|' || activation || '|' || (payload #>> '{request,url}') from chain.automation_work_requests"));
    }

    [Fact]
    public async Task A_destination_deleted_since_publishing_faults_the_step_as_unavailable()
    {
        Assert.Equal(HttpStatusCode.NoContent, (await _s.Admin.DeleteAsync($"{Destinations}/erp?force=true")).StatusCode);

        var instanceId = await StartAsync(Fixture.GetProperty("scenario").GetProperty("instanceData"));

        var faulted = await _s.Admin.GetFromJsonAsync<JsonElement>($"/api/instances/{instanceId}");
        var incident = Assert.Single(faulted.GetProperty("incidents").EnumerateArray());
        Assert.Equal("faulted|automation_unavailable|The destination 'erp' no longer exists.",
            $"{faulted.GetProperty("status")}|{incident.GetProperty("code")}|{incident.GetProperty("message")}");
        Assert.Equal(["0"], await _factory.QueryAsync("select count(*) from chain.automation_work_requests"));
    }

    // Cancellation (§6.5)

    [Fact]
    public async Task Closing_a_waiting_request_cancels_its_work_request_and_asks_Elixir_to_cancel()
    {
        var instanceId = await StartAsync(Fixture.GetProperty("scenario").GetProperty("instanceData"));
        var requestId = Assert.Single(await _factory.QueryAsync("select id::text from chain.automation_work_requests"));

        Assert.Equal(HttpStatusCode.OK, (await CloseAsync(_s.Diego, instanceId, "O cliente desistiu do cadastro.")).StatusCode);

        Assert.Equal(
            [$"execute|cancelled|-|false|task_cpf|1|true|990", $"cancel|pending|{requestId}|true|task_cpf|1|false|86400"],
            await _factory.QueryAsync("""
                select kind || '|' || status || '|' || coalesce(cancels_request_id::text, '-') || '|' || (payload is null)::text || '|' ||
                       node_id || '|' || activation || '|' || (closed_at is not null)::text || '|' || extract(epoch from deadline_at - created_at)::int
                from chain.automation_work_requests order by kind desc
                """));
        Assert.Equal([$"cancel|{requestId}"], await _factory.QueryAsync("select kind || '|' || cancels_request_id from chain.automation_dispatch_v1"));
        var cancelled = Event(await _s.Admin.GetFromJsonAsync<JsonElement>($"/api/instances/{instanceId}"), "automation.cancelled");
        Assert.Equal($"task_cpf|Consultar CPF|{requestId}", $"{cancelled.GetProperty("nodeId")}|{cancelled.GetProperty("label")}|{cancelled.GetProperty("requestId")}");
    }

    [Fact]
    public async Task A_child_waiting_at_an_automation_step_is_cancelled_with_its_parent()
    {
        var child = await _s.PublishAsync("Consulta de CPF", ChildDocument());
        var parent = await _s.PublishAsync("Cadastro com consulta", ParentDocument(child));
        await _s.GrantAsync(parent, [(_comercial, "start"), (_supervisores, "close")]);
        var parentId = await StartAsync(Fixture.GetProperty("scenario").GetProperty("instanceData"), parent);
        var childId = Assert.Single(await _factory.QueryAsync($"select id::text from chain.instances where parent_instance_id = '{parentId}'"));
        Assert.Equal([$"{childId}|pending"], await _factory.QueryAsync("select instance_id || '|' || status from chain.automation_work_requests"));

        Assert.Equal(HttpStatusCode.OK, (await CloseAsync(_s.Diego, parentId, "Cadastro cancelado pelo cliente.")).StatusCode);

        Assert.Equal(["cancel|pending", "execute|cancelled"],
            await _factory.QueryAsync($"select kind || '|' || status from chain.automation_work_requests where instance_id = '{childId}' order by kind"));
    }

    // Timeouts (§6.7) and the retry key (§8.3)

    [Fact]
    public async Task The_watchdog_times_out_a_request_past_its_deadline_and_a_retry_reuses_its_key()
    {
        var instanceId = await StartAsync(Fixture.GetProperty("scenario").GetProperty("instanceData"));
        var first = Assert.Single(await _factory.QueryAsync("select id::text from chain.automation_work_requests"));

        _factory.Time.Advance(TimeSpan.FromSeconds(989)); // the deadline is 990 s after dispatch
        await WatchdogAsync();
        Assert.Equal(["execute|pending"], await _factory.QueryAsync("select kind || '|' || status from chain.automation_work_requests"));

        _factory.Time.Advance(TimeSpan.FromSeconds(2));
        await WatchdogAsync();
        await WatchdogAsync(); // a second pass, as another replica would run it, changes nothing

        Assert.Equal(
            [$"execute|timed_out|true|-", $"cancel|pending|false|{first}"],
            await _factory.QueryAsync("""
                select kind || '|' || status || '|' || (closed_at is not null)::text || '|' || coalesce(cancels_request_id::text, '-')
                from chain.automation_work_requests order by kind desc
                """));
        var faulted = await _s.Admin.GetFromJsonAsync<JsonElement>($"/api/instances/{instanceId}");
        var incident = Assert.Single(faulted.GetProperty("incidents").EnumerateArray());
        Assert.Equal("faulted|task_cpf|automation_timed_out|No result arrived before the deadline, 2026-10-15T12:16:30Z.",
            $"{faulted.GetProperty("status")}|{faulted.GetProperty("currentNodeId")}|{incident.GetProperty("code")}|{incident.GetProperty("message")}");
        var timedOut = Event(faulted, "automation.timed_out");
        Assert.Null(Channel(faulted, "automation.timed_out")); // the watchdog runs outside any request (N9b-1)
        Assert.Equal($"task_cpf|Consultar CPF|{first}", $"{timedOut.GetProperty("nodeId")}|{timedOut.GetProperty("label")}|{timedOut.GetProperty("requestId")}");
        var fault = Event(faulted, "instance.faulted");
        Assert.Equal("task_cpf|Consultar CPF|automation_timed_out", $"{fault.GetProperty("nodeId")}|{fault.GetProperty("label")}|{fault.GetProperty("code")}"); // card #219

        Assert.Equal(HttpStatusCode.OK, (await PostAsync(_s.Admin, $"/api/instances/{instanceId}/retry", null, NewKey())).StatusCode);

        var retried = Assert.Single(await _factory.QueryAsync("""
            select activation || '|' || idempotency_key || '|' || (payload #>> '{idempotency,key}') || '|' || (payload->>'requestId' = id::text)::text || '|' || (payload->>'activation')
            from chain.automation_work_requests where kind = 'execute' and status = 'pending'
            """));
        Assert.Equal($"2|{first}|{first}|true|2", retried); // the target can de-duplicate a call that did succeed (ADR-0011 decision 5)
        Assert.Equal("running", (await _s.Admin.GetFromJsonAsync<JsonElement>($"/api/instances/{instanceId}")).GetProperty("status").GetString());
    }

    [Fact]
    public async Task Cancel_requests_are_completed_once_their_24_hours_pass()
    {
        var instanceId = await StartAsync(Fixture.GetProperty("scenario").GetProperty("instanceData"));
        Assert.Equal(HttpStatusCode.OK, (await CloseAsync(_s.Diego, instanceId, "O cliente desistiu do cadastro.")).StatusCode);

        _factory.Time.Advance(TimeSpan.FromHours(24) - TimeSpan.FromSeconds(1));
        await WatchdogAsync();
        Assert.Equal(["cancel"], await _factory.QueryAsync("select kind from chain.automation_dispatch_v1"));

        _factory.Time.Advance(TimeSpan.FromSeconds(2));
        await WatchdogAsync();

        Assert.Empty(await _factory.QueryAsync("select kind from chain.automation_dispatch_v1"));
        Assert.Equal(["cancel|completed|true", "execute|cancelled|true"],
            await _factory.QueryAsync("select kind || '|' || status || '|' || (closed_at is not null)::text from chain.automation_work_requests order by kind"));
    }

    [Fact]
    public async Task A_child_that_times_out_faults_its_waiting_parent()
    {
        var child = await _s.PublishAsync("Consulta de CPF", ChildDocument());
        var parent = await _s.PublishAsync("Cadastro com consulta", ParentDocument(child));
        await _s.GrantAsync(parent, [(_comercial, "start")]);
        var parentId = await StartAsync(Fixture.GetProperty("scenario").GetProperty("instanceData"), parent);

        _factory.Time.Advance(TimeSpan.FromSeconds(991));
        await WatchdogAsync();

        Assert.Equal(["automation_timed_out|faulted", "subprocess_faulted|faulted"], await _factory.QueryAsync($"""
            select i.code || '|' || s.status from chain.instance_incidents i join chain.instances s on s.id = i.instance_id
            where s.id = '{parentId}' or s.parent_instance_id = '{parentId}' order by i.code
            """));
    }

    // Results (§6.3, automation-contract.md §4)

    [Fact]
    public async Task A_succeeded_result_merges_the_mapped_outputs_and_moves_the_token_on()
    {
        var instanceId = await StartAsync(Fixture.GetProperty("scenario").GetProperty("instanceData"));
        var requestId = Assert.Single(await _factory.QueryAsync("select id::text from chain.automation_work_requests"));
        var result = ResultFixture("result-succeeded.json", requestId);

        var applied = await PostResultAsync(result.ToJsonString());

        Assert.Equal((HttpStatusCode.OK, """{"applied":true}"""), (applied.Status, applied.Body));
        var view = await _s.Admin.GetFromJsonAsync<JsonElement>($"/api/instances/{instanceId}");
        Assert.Equal("running|analyse|regular", $"{view.GetProperty("status")}|{view.GetProperty("currentNodeId")}|{view.GetProperty("data").GetProperty("situacao_cpf")}");
        Assert.False(view.GetProperty("data").TryGetProperty("httpStatus", out _)); // only what the step maps enters the request
        Assert.Equal("Analisar", Assert.Single(view.GetProperty("openTasks").EnumerateArray()).GetProperty("label").GetString());
        var succeeded = Event(view, "automation.succeeded");
        Assert.Equal(("ui", null), (Channel(view, "instance.started"), Channel(view, "automation.succeeded"))); // the result call is no caller's (N9b-1)
        Assert.Equal($"task_cpf|Consultar CPF|{requestId}|2",
            $"{succeeded.GetProperty("nodeId")}|{succeeded.GetProperty("label")}|{succeeded.GetProperty("requestId")}|{succeeded.GetProperty("attempts").GetArrayLength()}");
        Assert.Equal(["completed|true"], await _factory.QueryAsync("select status || '|' || (closed_at is not null)::text from chain.automation_work_requests"));
        Assert.Equal([$"automation.result_applied|-|system:automation|{requestId}|succeeded"], await AuditAsync());

        // A replay, even with the keys in another order, gets the stored response and changes nothing.
        var events = view.GetProperty("timeline").GetArrayLength();
        var reordered = new JsonObject(result.Reverse().Select(pair => KeyValuePair.Create(pair.Key, pair.Value?.DeepClone())));
        var replay = await PostResultAsync(reordered.ToJsonString());
        Assert.Equal((HttpStatusCode.OK, """{"applied":true}"""), (replay.Status, replay.Body));
        Assert.Equal(events, (await _s.Admin.GetFromJsonAsync<JsonElement>($"/api/instances/{instanceId}")).GetProperty("timeline").GetArrayLength());

        // A different result for the same request is a conflict.
        result["output"]!["status"] = 201;
        var conflict = await PostResultAsync(result.ToJsonString());
        Assert.Equal((HttpStatusCode.Conflict, "result_conflict"), (conflict.Status, Code(conflict.Body)));
    }

    // Card #191: a target's answer is nested at most 32 levels deep, and Elixir refuses a deeper one as invalid_response
    // (automation-contract.md §4.2). .NET reads a result up to that depth plus the result's own two levels, and no deeper: a
    // deeper body breaks the contract.

    [Fact]
    public async Task A_result_is_read_with_an_answer_nested_32_levels_deep_and_no_deeper()
    {
        await StartAsync(Fixture.GetProperty("scenario").GetProperty("instanceData"));
        var requestId = Assert.Single(await _factory.QueryAsync("select id::text from chain.automation_work_requests"));
        var result = ResultFixture("result-succeeded.json", requestId);

        result["output"]!["body"]!["resultado"]!["arvore"] = Nested(31); // the answer: its object, "resultado", then 31 arrays
        var tooDeep = await PostResultAsync(result.ToJsonString());

        Assert.Equal((HttpStatusCode.BadRequest, "invalid_result"), (tooDeep.Status, Code(tooDeep.Body)));
        Assert.Equal(["pending"], await _factory.QueryAsync("select status from chain.automation_work_requests"));

        result["output"]!["body"]!["resultado"]!["arvore"] = Nested(30); // 32 levels
        var applied = await PostResultAsync(result.ToJsonString());

        Assert.Equal((HttpStatusCode.OK, """{"applied":true}"""), (applied.Status, applied.Body));
    }

    // Regression #207: the body was read with Encoding.UTF8, so bytes that are not UTF-8 became U+FFFD and the result was applied
    // with text Elixir never sent. Such a body is not JSON (RFC 8259 §8.1), so it is invalid_result (automation-contract.md §4.3).

    [Fact]
    public async Task A_result_whose_bytes_are_not_UTF8_is_invalid()
    {
        await StartAsync(Fixture.GetProperty("scenario").GetProperty("instanceData"));
        var requestId = Assert.Single(await _factory.QueryAsync("select id::text from chain.automation_work_requests"));
        var result = ResultFixture("result-succeeded.json", requestId);
        result["output"]!["body"]!["resultado"]!["situacao"] = "reguNOT_UTF8lar";
        var bytes = result.ToJsonString().Split("NOT_UTF8").Select(Encoding.UTF8.GetBytes).Aggregate((before, after) => [.. before, 0xFF, .. after]);

        var response = await PostResultBytesAsync(bytes);

        Assert.Equal((HttpStatusCode.BadRequest, "invalid_result"), (response.Status, Code(response.Body)));
        Assert.Equal(["pending"], await _factory.QueryAsync("select status from chain.automation_work_requests"));
    }

    [Fact]
    public async Task A_failed_result_faults_the_step_and_a_retry_dispatches_with_a_new_key()
    {
        var instanceId = await StartAsync(Fixture.GetProperty("scenario").GetProperty("instanceData"));
        var requestId = Assert.Single(await _factory.QueryAsync("select id::text from chain.automation_work_requests"));

        var applied = await PostResultAsync(ResultFixture("result-failed.json", requestId).ToJsonString());

        Assert.Equal((HttpStatusCode.OK, """{"applied":true}"""), (applied.Status, applied.Body));
        var view = await _s.Admin.GetFromJsonAsync<JsonElement>($"/api/instances/{instanceId}");
        var incident = Assert.Single(view.GetProperty("incidents").EnumerateArray());
        Assert.Equal("faulted|task_cpf|automation_failed|http_status: The target answered HTTP 404.",
            $"{view.GetProperty("status")}|{view.GetProperty("currentNodeId")}|{incident.GetProperty("code")}|{incident.GetProperty("message")}");
        var failed = Event(view, "automation.failed");
        Assert.Equal($"task_cpf|Consultar CPF|{requestId}|http_status|1",
            $"{failed.GetProperty("nodeId")}|{failed.GetProperty("label")}|{failed.GetProperty("requestId")}|{failed.GetProperty("errorClass")}|{failed.GetProperty("attempts").GetArrayLength()}");

        Assert.Equal(HttpStatusCode.OK, (await PostAsync(_s.Admin, $"/api/instances/{instanceId}/retry", null, NewKey())).StatusCode);

        Assert.Equal(["execute|failed|1|true", "execute|pending|2|true"], await _factory.QueryAsync(
            "select kind || '|' || status || '|' || activation || '|' || (idempotency_key = id::text)::text from chain.automation_work_requests order by activation"));
    }

    [Fact]
    public async Task An_output_that_breaks_the_contract_faults_the_step_and_merges_nothing()
    {
        var instanceId = await StartAsync(Fixture.GetProperty("scenario").GetProperty("instanceData"));
        var requestId = Assert.Single(await _factory.QueryAsync("select id::text from chain.automation_work_requests"));
        var result = ResultFixture("result-succeeded.json", requestId);
        result["output"]!["body"] = JsonNode.Parse("""{"resultado":{"score":812}}""");

        Assert.Equal(HttpStatusCode.OK, (await PostResultAsync(result.ToJsonString())).Status);

        var view = await _s.Admin.GetFromJsonAsync<JsonElement>($"/api/instances/{instanceId}");
        var incident = Assert.Single(view.GetProperty("incidents").EnumerateArray());
        Assert.Equal("faulted|automation_output_invalid|The output 'situacao' is required.",
            $"{view.GetProperty("status")}|{incident.GetProperty("code")}|{incident.GetProperty("message")}");
        Assert.False(view.GetProperty("data").TryGetProperty("situacao_cpf", out _));
        Assert.Equal(["failed"], await _factory.QueryAsync("select status from chain.automation_work_requests"));
    }

    // Regression #154: an output's text is merged into instances.data, and jsonb stores neither NUL nor an unpaired surrogate
    // (identity.md I1). The result call failed, so the result was retried or left unapplied instead of becoming an incident.

    [Theory]
    [InlineData("regu\\u0000lar")] // NUL
    [InlineData("regu\\ud800lar")] // an unpaired surrogate
    public async Task An_output_with_text_PostgreSQL_cannot_store_faults_the_step_and_merges_nothing(string text)
    {
        var instanceId = await StartAsync(Fixture.GetProperty("scenario").GetProperty("instanceData"));
        var requestId = Assert.Single(await _factory.QueryAsync("select id::text from chain.automation_work_requests"));
        var result = ResultFixture("result-succeeded.json", requestId);
        result["output"]!["body"] = JsonNode.Parse("""{"resultado":{"situacao":"TEXT","score":812}}""");
        var body = result.ToJsonString().Replace("TEXT", text, StringComparison.Ordinal);

        var applied = await PostResultAsync(body);

        Assert.Equal((HttpStatusCode.OK, """{"applied":true}"""), (applied.Status, applied.Body));
        var view = await _s.Admin.GetFromJsonAsync<JsonElement>($"/api/instances/{instanceId}");
        var incident = Assert.Single(view.GetProperty("incidents").EnumerateArray());
        Assert.Equal("faulted|automation_output_invalid|The output 'situacao' holds text that cannot be stored: the NUL character or an unpaired surrogate.",
            $"{view.GetProperty("status")}|{incident.GetProperty("code")}|{incident.GetProperty("message")}");
        Assert.False(view.GetProperty("data").TryGetProperty("situacao_cpf", out _));
        Assert.Equal(["failed"], await _factory.QueryAsync("select status from chain.automation_work_requests"));
        Assert.Equal("output_invalid", Event(view, "automation.failed").GetProperty("errorClass").GetString());

        var replay = await PostResultAsync(body); // the same text replays, canonical or not
        Assert.Equal((HttpStatusCode.OK, """{"applied":true}"""), (replay.Status, replay.Body));
    }

    [Fact]
    public async Task Text_PostgreSQL_cannot_store_outside_the_declared_outputs_is_ignored()
    {
        var instanceId = await StartAsync(Fixture.GetProperty("scenario").GetProperty("instanceData"));
        var requestId = Assert.Single(await _factory.QueryAsync("select id::text from chain.automation_work_requests"));
        var result = ResultFixture("result-succeeded.json", requestId);
        result["output"]!["body"] = JsonNode.Parse("""{"resultado":{"situacao":"regular","nota":"NUL","obs":"UNPAIRED"}}""");

        var applied = await PostResultAsync(result.ToJsonString()
            .Replace("NUL", "a\\u0000b", StringComparison.Ordinal).Replace("UNPAIRED", "a\\ud800b", StringComparison.Ordinal));

        Assert.Equal((HttpStatusCode.OK, """{"applied":true}"""), (applied.Status, applied.Body));
        var view = await _s.Admin.GetFromJsonAsync<JsonElement>($"/api/instances/{instanceId}");
        Assert.Equal("running|regular", $"{view.GetProperty("status")}|{view.GetProperty("data").GetProperty("situacao_cpf")}");
    }

    // Regression #154: the duplicate check reads every property name, and System.Text.Json reads a name that is not Unicode text
    // only by throwing, so such a name anywhere in the body made the result call fail with 500.

    [Fact]
    public async Task A_result_with_a_property_name_that_is_not_Unicode_is_invalid()
    {
        await StartAsync(Fixture.GetProperty("scenario").GetProperty("instanceData"));
        var requestId = Assert.Single(await _factory.QueryAsync("select id::text from chain.automation_work_requests"));
        var result = ResultFixture("result-succeeded.json", requestId);
        result["output"]!["body"] = JsonNode.Parse("""{"resultado":{"situacao":"regular","NAME":1}}""");

        var response = await PostResultAsync(result.ToJsonString().Replace("NAME", "nota\\ud800", StringComparison.Ordinal));

        Assert.Equal((HttpStatusCode.BadRequest, "invalid_result"), (response.Status, Code(response.Body)));
        Assert.Equal(["pending"], await _factory.QueryAsync("select status from chain.automation_work_requests"));
    }

    [Fact]
    public async Task Results_for_a_stale_activation_or_a_closed_request_are_ignored_with_200()
    {
        var first = await StartAsync(Fixture.GetProperty("scenario").GetProperty("instanceData"));
        var firstRequest = Assert.Single(await _factory.QueryAsync($"select id::text from chain.automation_work_requests where instance_id = '{first}'"));
        var stale = await PostResultAsync(ResultFixture("result-succeeded.json", firstRequest, activation: 2).ToJsonString());
        Assert.Equal((HttpStatusCode.OK, """{"applied":false,"reason":"stale_activation"}"""), (stale.Status, stale.Body));
        Assert.Equal(["pending"], await _factory.QueryAsync($"select status from chain.automation_work_requests where id = '{firstRequest}'"));

        var second = await StartAsync(Fixture.GetProperty("scenario").GetProperty("instanceData"));
        var secondRequest = Assert.Single(await _factory.QueryAsync($"select id::text from chain.automation_work_requests where instance_id = '{second}'"));
        Assert.Equal(HttpStatusCode.OK, (await CloseAsync(_s.Diego, second, "O cliente desistiu do cadastro.")).StatusCode);
        var late = await PostResultAsync(ResultFixture("result-succeeded.json", secondRequest).ToJsonString());
        Assert.Equal((HttpStatusCode.OK, """{"applied":false,"reason":"not_pending:cancelled"}"""), (late.Status, late.Body));

        string[] expected = [$"automation.result_ignored|-|system:automation|{firstRequest}|succeeded|stale_activation", $"automation.result_ignored|-|system:automation|{secondRequest}|succeeded|not_pending:cancelled"];
        Assert.Equal(expected.Order(StringComparer.Ordinal), (await AuditAsync(withReason: true)).Order(StringComparer.Ordinal));
    }

    [Fact]
    public async Task Unknown_requests_and_malformed_or_oversized_results_are_refused()
    {
        var instanceId = await StartAsync(Fixture.GetProperty("scenario").GetProperty("instanceData"));
        var requestId = Assert.Single(await _factory.QueryAsync("select id::text from chain.automation_work_requests"));
        Assert.Equal(HttpStatusCode.OK, (await CloseAsync(_s.Diego, instanceId, "O cliente desistiu do cadastro.")).StatusCode);
        var cancelId = Assert.Single(await _factory.QueryAsync("select id::text from chain.automation_work_requests where kind = 'cancel'"));

        foreach (var unknown in new[] { Guid.NewGuid().ToString(), cancelId })
        {
            var response = await PostResultAsync(ResultFixture("result-failed.json", unknown).ToJsonString());
            Assert.Equal((HttpStatusCode.NotFound, "unknown_request"), (response.Status, Code(response.Body)));
        }

        var valid = ResultFixture("result-failed.json", requestId);
        string With(Action<JsonObject> change)
        {
            var copy = valid.DeepClone().AsObject();
            change(copy);
            return copy.ToJsonString();
        }

        static string Twice(string json, string property) => json.Replace(property, $"{property},{property}", StringComparison.Ordinal);

        foreach (var malformed in new[]
        {
            "not json",
            "[]",
            With(r => r["contractVersion"] = 2),
            With(r => r["outcome"] = "maybe"),
            With(r => r["error"] = null),
            With(r => r["output"] = new JsonObject { ["status"] = 200, ["body"] = null }),
            With(r => r["extra"] = 1),
            With(r => r.Remove("attempts")),
            With(r => r["requestId"] = "not-a-uuid"),
            Twice(valid.ToJsonString(), "\"outcome\":\"failed\""), // a property twice, at any depth
            Twice(valid.ToJsonString(), "\"number\":1"),
            Twice(ResultFixture("result-succeeded.json", requestId).ToJsonString(), "\"score\":812"),
        })
        {
            var response = await PostResultAsync(malformed);
            Assert.True((response.Status, Code(response.Body)) == (HttpStatusCode.BadRequest, "invalid_result"), malformed);
        }

        var oversized = await PostResultAsync(new string(' ', (16 * 1024 * 1024) + 1));
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, oversized.Status);
    }

    [Fact]
    public async Task Only_the_result_token_on_the_internal_port_reaches_the_endpoint()
    {
        await StartAsync(Fixture.GetProperty("scenario").GetProperty("instanceData"));
        var requestId = Assert.Single(await _factory.QueryAsync("select id::text from chain.automation_work_requests"));
        var body = ResultFixture("result-failed.json", requestId).ToJsonString();
        var bot = await Chain.Api.Tests.Mcp.McpTestClient.CreateBotAsync(_s.Admin, "robo", enableMcp: false);
        using var anonymous = _factory.CreateBrowser(handleCookies: false);
        var cookie = (await anonymous.LoginAsync(ApiTestSession.AdminUsername, ApiTestSession.AdminPassword)).Headers.GetValues("Set-Cookie").Single().Split(';')[0];

        Assert.Equal(HttpStatusCode.NotFound, (await PostResultAsync(body, port: 8080)).Status); // the public listener has no such path
        Assert.Equal(HttpStatusCode.Unauthorized, (await PostResultAsync(body, token: null)).Status);
        Assert.Equal(HttpStatusCode.Unauthorized, (await PostResultAsync(body, token: "not-the-token")).Status);
        Assert.Equal(HttpStatusCode.Unauthorized, (await PostResultAsync(body, token: bot.Token)).Status);
        Assert.Equal(HttpStatusCode.Unauthorized, (await PostResultAsync(body, token: null, cookie: cookie)).Status);
        using var publicCall = new HttpRequestMessage(HttpMethod.Get, "/api/instances");
        publicCall.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", ChainApiFactory.TestResultToken);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.SendAsync(publicCall)).StatusCode); // the result token works nowhere else
        Assert.Equal(["pending"], await _factory.QueryAsync("select status from chain.automation_work_requests"));

        Assert.Equal(HttpStatusCode.OK, (await PostResultAsync(body)).Status);
    }

    [Fact]
    public async Task A_child_completed_by_its_result_returns_its_outputs_to_the_parent()
    {
        var child = await _s.PublishAsync("Consulta de CPF", ChildDocument());
        var parent = await _s.PublishAsync("Cadastro com consulta", ParentDocument(child, outputs: new JsonObject { ["situacao_final"] = Path("situacao_cpf") }));
        await _s.GrantAsync(parent, [(_comercial, "start")]);
        var parentId = await StartAsync(Fixture.GetProperty("scenario").GetProperty("instanceData"), parent);
        var requestId = Assert.Single(await _factory.QueryAsync("select id::text from chain.automation_work_requests"));

        Assert.Equal(HttpStatusCode.OK, (await PostResultAsync(ResultFixture("result-succeeded.json", requestId).ToJsonString())).Status);

        var view = await _s.Admin.GetFromJsonAsync<JsonElement>($"/api/instances/{parentId}");
        Assert.Equal("completed|regular", $"{view.GetProperty("status")}|{view.GetProperty("data").GetProperty("situacao_final")}");
        Assert.Equal(["completed"], await _factory.QueryAsync($"select status from chain.instances where parent_instance_id = '{parentId}'"));
    }

    // Card #76: the catalog types automation outputs, so an admin correction checks them as typed keys (workflow-engine.md §16.3).
    // Before, every output was unknown, and with no current value any correction of one was untyped_key.

    [Fact]
    public async Task A_correction_checks_an_automation_output_against_its_type()
    {
        var created = await _s.Admin.PostAsJsonAsync("/api/automations", new { name = "Consultar endereço" });
        var automation = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var document = JsonNode.Parse("""
            {
              "schemaVersion": 1, "kind": "http", "inputs": [],
              "request": { "method": "GET", "destination": "erp", "path": "/v1/enderecos", "headers": { "X-Api-Key": "{{secret:erp_api_key}}" } },
              "response": { "type": "json" },
              "outputs": [
                { "key": "endereco", "type": "object", "required": true, "source": "body", "path": ["endereco"] },
                { "key": "cep", "type": "text", "source": "body", "path": ["cep"] }
              ]
            }
            """);
        Assert.Equal(HttpStatusCode.OK, (await SendAsync(HttpMethod.Put, $"/api/automations/{automation}/draft", new { document }, $"/api/automations/{automation}")).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await SendAsync(HttpMethod.Post, $"/api/automations/{automation}/publish", null, $"/api/automations/{automation}")).StatusCode);
        var workflow = await _s.PublishAsync("Endereço", new JsonObject
        {
            ["schemaVersion"] = 1,
            ["lanes"] = new JsonArray(),
            ["nodes"] = new JsonArray
            {
                new JsonObject { ["id"] = "start", ["type"] = "start", ["label"] = "Início" },
                new JsonObject
                {
                    ["id"] = "busca", ["type"] = "task", ["taskKind"] = "automation", ["label"] = "Buscar endereço",
                    ["automation"] = new JsonObject
                    {
                        ["automationId"] = automation.ToString(), ["inputs"] = new JsonObject(),
                        ["outputs"] = new JsonObject { ["endereco"] = Path("endereco"), ["cep"] = Path("cep") },
                    },
                },
                new JsonObject { ["id"] = "end", ["type"] = "end", ["label"] = "Fim" },
            },
            ["flows"] = Flows(("start", "busca"), ("busca", "end")),
        });
        await _s.GrantAsync(workflow, [(_comercial, "start")]);
        var instanceId = await StartedInstanceAsync(_s.Ana, workflow);
        var requestId = Assert.Single(await _factory.QueryAsync($"select id::text from chain.automation_work_requests where instance_id = '{instanceId}'"));
        Assert.Equal(HttpStatusCode.OK, (await PostResultAsync(ResultFixture("result-failed.json", requestId).ToJsonString())).Status); // faults the step
        const string Justification = "O endereço veio do cadastro antigo.";

        var wrong = await CorrectAsync(_s.Admin, instanceId, await CurrentETagAsync(_s.Admin, instanceId),
            new { changes = new JsonObject { ["cep"] = 1, ["endereco"] = "Rua A" }, justification = Justification });

        Assert.Equal(HttpStatusCode.UnprocessableEntity, wrong.StatusCode);
        var problem = await wrong.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal([("cep", "type_mismatch"), ("endereco", "type_mismatch")],
            problem.GetProperty("errors").EnumerateArray().Select(e => (e.GetProperty("key").GetString()!, e.GetProperty("code").GetString()!)));

        var right = await CorrectAsync(_s.Admin, instanceId, await CurrentETagAsync(_s.Admin, instanceId),
            new { changes = new JsonObject { ["cep"] = "01001-000", ["endereco"] = new JsonObject { ["rua"] = "Praça da Sé", ["numero"] = 1 } }, justification = Justification });

        Assert.Equal(HttpStatusCode.OK, right.StatusCode);
        var data = (await right.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("data");
        Assert.Equal("01001-000", data.GetProperty("cep").GetString());
        Assert.Equal("Praça da Sé|1", $"{data.GetProperty("endereco").GetProperty("rua")}|{data.GetProperty("endereco").GetProperty("numero")}"); // no declared fields
    }

    // The views Elixir reads (automation-contract.md §2)

    [Fact]
    public async Task The_views_expose_exactly_the_contract_columns()
    {
        Assert.Equal(["request_id", "kind", "cancels_request_id", "payload", "created_at", "deadline_at"], await ColumnsAsync("automation_dispatch_v1"));
        Assert.Equal(["name", "version", "ciphertext", "nonce", "wrapped_data_key", "key_id", "allowed_destinations"], await ColumnsAsync("automation_secrets_v1"));
    }

    // Helpers

    private async Task<Guid> PublishAutomationAsync()
    {
        var scenario = Fixture.GetProperty("scenario").GetProperty("automation");
        var created = await _s.Admin.PostAsJsonAsync("/api/automations", new { name = scenario.GetProperty("name").GetString() });
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var document = JsonNode.Parse(scenario.GetProperty("document").GetRawText());
        Assert.Equal(HttpStatusCode.OK, (await SendAsync(HttpMethod.Put, $"/api/automations/{id}/draft", new { document }, $"/api/automations/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await SendAsync(HttpMethod.Post, $"/api/automations/{id}/publish", null, $"/api/automations/{id}")).StatusCode);
        return id;
    }

    /// <summary>start (Proposta) → task_cpf (the fixture's automation step) → analyse (Analistas) → end.</summary>
    private JsonObject CadastroDocument() => new()
    {
        ["schemaVersion"] = 1,
        ["lanes"] = new JsonArray
        {
            new JsonObject { ["id"] = "lane_req", ["title"] = "Solicitantes", ["group"] = new JsonObject { ["kind"] = "requesters" } },
            new JsonObject { ["id"] = "lane_an", ["title"] = "Análise", ["group"] = new JsonObject { ["kind"] = "group", ["groupId"] = _s.Analistas.ToString() } },
        },
        ["nodes"] = new JsonArray
        {
            new JsonObject { ["id"] = "start", ["type"] = "start", ["label"] = "Início", ["laneId"] = "lane_req", ["form"] = new JsonObject { ["formId"] = _proposta.ToString() } },
            AutomationStep("lane_an"),
            new JsonObject { ["id"] = "analyse", ["type"] = "task", ["taskKind"] = "human", ["label"] = "Analisar", ["laneId"] = "lane_an" },
            new JsonObject { ["id"] = "end", ["type"] = "end", ["label"] = "Fim", ["laneId"] = "lane_an" },
        },
        ["flows"] = Flows(("start", "task_cpf"), ("task_cpf", "analyse"), ("analyse", "end")),
    };

    /// <summary>A child without a start form: its parent's inputs become its data (TC-5), then the automation step.</summary>
    private JsonObject ChildDocument() => new()
    {
        ["schemaVersion"] = 1,
        ["lanes"] = new JsonArray(),
        ["nodes"] = new JsonArray
        {
            new JsonObject { ["id"] = "start", ["type"] = "start", ["label"] = "Início" },
            AutomationStep(null),
            new JsonObject { ["id"] = "end", ["type"] = "end", ["label"] = "Fim" },
        },
        ["flows"] = Flows(("start", "task_cpf"), ("task_cpf", "end")),
    };

    private JsonObject ParentDocument(Guid child, JsonObject? outputs = null) => new()
    {
        ["schemaVersion"] = 1,
        ["lanes"] = new JsonArray(),
        ["nodes"] = new JsonArray
        {
            new JsonObject { ["id"] = "start", ["type"] = "start", ["label"] = "Início", ["form"] = new JsonObject { ["formId"] = _proposta.ToString() } },
            new JsonObject
            {
                ["id"] = "sub", ["type"] = "task", ["taskKind"] = "subprocess", ["label"] = "Consultar",
                ["workflow"] = new JsonObject
                {
                    ["workflowId"] = child.ToString(), ["inputs"] = new JsonObject { ["cpf"] = Path("cpf"), ["valor"] = Path("valor") }, ["outputs"] = outputs,
                },
            },
            new JsonObject { ["id"] = "end", ["type"] = "end", ["label"] = "Fim" },
        },
        ["flows"] = Flows(("start", "sub"), ("sub", "end")),
    };

    /// <summary>The fixture's step: node <c>task_cpf</c> with its <c>stepInputs</c>.</summary>
    private JsonObject AutomationStep(string? laneId)
    {
        var step = new JsonObject
        {
            ["id"] = Fixture.GetProperty("scenario").GetProperty("nodeId").GetString(), ["type"] = "task", ["taskKind"] = "automation", ["label"] = "Consultar CPF",
            ["automation"] = new JsonObject
            {
                ["automationId"] = _automation.ToString(),
                ["inputs"] = JsonNode.Parse(Fixture.GetProperty("scenario").GetProperty("stepInputs").GetRawText()),
                ["outputs"] = new JsonObject { ["situacao_cpf"] = Path("situacao") },
            },
        };
        if (laneId is not null)
        {
            step["laneId"] = laneId;
        }

        return step;
    }

    private static JsonArray Flows(params (string Source, string Target)[] flows) =>
        [.. flows.Select((f, i) => (JsonNode)new JsonObject { ["id"] = $"f{i + 1}", ["source"] = f.Source, ["target"] = f.Target })];

    private static JsonObject Path(string key) => new() { ["kind"] = "path", ["path"] = new JsonArray(key) };

    /// <summary>Arrays nested <paramref name="levels"/> deep: <c>[[…]]</c>.</summary>
    private static JsonNode Nested(int levels) => JsonNode.Parse(new string('[', levels) + new string(']', levels))!;

    private async Task<Guid> StartAsync(JsonElement data, Guid? definition = null)
    {
        var response = await StartWithDataAsync(_s.Ana, definition ?? _cadastro, JsonNode.Parse(data.GetRawText())!.AsObject());
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    /// <summary>A shared result fixture for one of our requests: its id and activation are volatile.</summary>
    private static JsonObject ResultFixture(string file, string requestId, int activation = 1)
    {
        var result = JsonNode.Parse(File.ReadAllText(System.IO.Path.Combine(AppContext.BaseDirectory, "contract", file)))!.AsObject();
        result["requestId"] = requestId;
        result["activation"] = activation;
        return result;
    }

    /// <summary>The result call as Elixir makes it: on the internal listener's port, with the result token (contract §4.1).</summary>
    private Task<(HttpStatusCode Status, string Body)> PostResultAsync(
        string body, string? token = ChainApiFactory.TestResultToken, int port = ChainApiFactory.InternalPort, string? cookie = null) =>
        PostResultBytesAsync(Encoding.UTF8.GetBytes(body), token, port, cookie);

    private async Task<(HttpStatusCode Status, string Body)> PostResultBytesAsync(
        byte[] body, string? token = ChainApiFactory.TestResultToken, int port = ChainApiFactory.InternalPort, string? cookie = null)
    {
        var context = await _factory.Server.SendAsync(http =>
        {
            http.Connection.LocalPort = port;
            http.Request.Method = HttpMethods.Post;
            http.Request.Path = "/internal/automation/results";
            http.Request.ContentType = "application/json";
            if (token is not null)
            {
                http.Request.Headers.Authorization = $"Bearer {token}";
            }

            if (cookie is not null)
            {
                http.Request.Headers.Cookie = cookie;
            }

            http.Request.Body = new MemoryStream(body);
        });
        using var reader = new StreamReader(context.Response.Body);
        return ((HttpStatusCode)context.Response.StatusCode, await reader.ReadToEndAsync());
    }

    private static string? Code(string problem) =>
        problem.Length > 0 && JsonDocument.Parse(problem).RootElement.TryGetProperty("code", out var code) ? code.GetString() : null;

    private async Task<List<string>> AuditAsync(bool withReason = false) => await _factory.QueryAsync($"""
        select action || '|' || coalesce(actor_id::text, '-') || '|' || (details->>'principal') || '|' || (details->>'requestId') || '|' || (details->>'outcome')
               {(withReason ? "|| '|' || (details->>'reason')" : "")}
        from chain.audit_events where action like 'automation.result_%' order by occurred_at, (details->>'requestId')
        """);

    /// <summary>One pass of the watchdog (§6.7), as the hosted service runs it every 15 seconds outside tests.</summary>
    private async Task WatchdogAsync()
    {
        await using var scope = _factory.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<InstanceService>().TimeOutAutomationsAsync(CancellationToken.None);
    }

    private static async Task<Guid> OnlyGroupAsync(HttpClient client) =>
        Id(Assert.Single((await client.GetFromJsonAsync<JsonElement>("/api/auth/me")).GetProperty("groups").EnumerateArray()));

    private static JsonElement Event(JsonElement view, string type) =>
        Assert.Single(view.GetProperty("timeline").EnumerateArray(), e => e.GetProperty("type").GetString() == type).GetProperty("details");

    /// <summary>The channel of the only event of <paramref name="type"/> (workflow-engine.md §8, card #83); null when it has none.</summary>
    private static string? Channel(JsonElement view, string type) =>
        Assert.Single(view.GetProperty("timeline").EnumerateArray(), e => e.GetProperty("type").GetString() == type).GetProperty("channel").GetString();

    private async Task<List<string>> ColumnsAsync(string view) =>
        await _factory.QueryAsync($"select column_name from information_schema.columns where table_schema = 'chain' and table_name = '{view}' order by ordinal_position");

    /// <summary>Removes the text at a dotted path and returns it.</summary>
    private static string? Take(JsonObject root, string path)
    {
        var parts = path.Split('.');
        var parent = parts[..^1].Aggregate(root, (node, part) => node[part]!.AsObject());
        var value = parent[parts[^1]];
        parent.Remove(parts[^1]);
        return value?.GetValue<string>();
    }

    private async Task<HttpResponseMessage> SendAsync(HttpMethod method, string path, object? body, string etagPath)
    {
        using var request = new HttpRequestMessage(method, path) { Content = body is null ? null : JsonContent.Create(body) };
        request.Headers.TryAddWithoutValidation("If-Match", (await _s.Admin.GetAsync(etagPath)).Headers.ETag!.Tag);
        return await _s.Admin.SendAsync(request);
    }

    [GeneratedRegex("^[0-9a-f]{32}\\z")]
    private static partial Regex TraceId();

    [GeneratedRegex("^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}\\z")]
    private static partial Regex TraceParent();
}
