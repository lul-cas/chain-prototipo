using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Chain.Api.Tests.Infrastructure;
using static Chain.Api.Tests.Engine.CreditScenario;

namespace Chain.Api.Tests.Engine;

/// <summary>Acceptance criteria of engine increment E1 (workflow-engine.md §11).</summary>
[Collection(PostgresTestGroup.Name)]
public sealed class EngineTests(PostgresFixture postgres) : IAsyncLifetime, IDisposable
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
        _s?.Dispose();
        _factory.Dispose();
    }

    // 1. Starting

    [Fact]
    public async Task Only_start_holders_can_start_and_the_latest_version_is_pinned()
    {
        await (await StartAsync(_s.Bruno, _s.DefinitionId)).AssertProblemAsync(HttpStatusCode.Forbidden, "forbidden");
        await (await StartAsync(_s.Admin, _s.DefinitionId)).AssertProblemAsync(HttpStatusCode.Forbidden, "forbidden"); // E-1: admins act only when eligible

        var instanceId = await StartedInstanceAsync(_s.Ana, _s.DefinitionId);

        var document = CreditScenario.Document(_s.Analistas);
        document["nodes"]![1]!["label"] = "Preencher proposta (v2)";
        await RepublishAsync(document);

        var instance = await _s.Ana.GetFromJsonAsync<JsonElement>($"/api/instances/{instanceId}");
        Assert.Equal(1, instance.GetProperty("versionNumber").GetInt32());
        Assert.Equal("Preencher proposta", (await OpenTaskAsync(_s.Ana, instanceId)).GetProperty("label").GetString());
        var newer = await StartedInstanceAsync(_s.Ana, _s.DefinitionId);
        Assert.Equal(2, (await _s.Ana.GetFromJsonAsync<JsonElement>($"/api/instances/{newer}")).GetProperty("versionNumber").GetInt32());
    }

    [Fact]
    public async Task Inactive_definitions_cannot_be_started()
    {
        await _s.Admin.PostAsync($"/api/workflows/{_s.DefinitionId}/deactivate", null);

        await (await StartAsync(_s.Ana, _s.DefinitionId)).AssertProblemAsync(HttpStatusCode.Conflict, "workflow_not_startable");
    }

    [Fact]
    public async Task Startable_workflows_lists_only_what_the_caller_can_start()
    {
        var forAna = await _s.Ana.GetFromJsonAsync<JsonElement>("/api/startable-workflows");
        var forBruno = await _s.Bruno.GetFromJsonAsync<JsonElement>("/api/startable-workflows");

        Assert.Equal(_s.DefinitionId, Id(Assert.Single(forAna.EnumerateArray())));
        Assert.Empty(forBruno.EnumerateArray());
    }

    // 2. First wait state and who sees it

    [Fact]
    public async Task Starting_creates_the_first_task_for_the_requester()
    {
        var instanceId = await StartedInstanceAsync(_s.Ana, _s.DefinitionId);

        var task = await OpenTaskAsync(_s.Ana, instanceId);
        Assert.Equal("fill", task.GetProperty("nodeId").GetString());
        Assert.Equal("Preencher proposta", task.GetProperty("label").GetString());
        var inbox = await _s.Ana.GetFromJsonAsync<JsonElement>("/api/tasks");
        Assert.Contains(inbox.GetProperty("unassigned").EnumerateArray(), t => Id(t) == Id(task));

        Assert.Equal(HttpStatusCode.NotFound, (await _s.Bruno.GetAsync($"/api/instances/{instanceId}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _s.Fabio.GetAsync($"/api/instances/{instanceId}")).StatusCode);
    }

    // 3. Eligibility

    [Fact]
    public async Task Only_eligible_actors_can_act()
    {
        var instanceId = await StartedInstanceAsync(_s.Ana, _s.DefinitionId);
        var fill = Id(await OpenTaskAsync(_s.Ana, instanceId));

        await (await CompleteAsync(_s.Bruno, fill)).AssertProblemAsync(HttpStatusCode.NotFound, "not_found");       // can't see it
        await (await CompleteAsync(_s.Eva, fill)).AssertProblemAsync(HttpStatusCode.Forbidden, "forbidden");        // can see (view), not eligible
        await (await CompleteAsync(_s.Admin, fill)).AssertProblemAsync(HttpStatusCode.Forbidden, "forbidden");      // E-1

        Assert.Equal(HttpStatusCode.OK, (await CompleteAsync(_s.Ana, fill)).StatusCode);
        var analyse = await OpenTaskAsync(_s.Bruno, instanceId);
        Assert.Equal("analyse", analyse.GetProperty("nodeId").GetString());

        await _s.Admin.DeleteAsync($"/api/admin/groups/{_s.Analistas}/members/{_s.UserIds["bruno"]}");
        Assert.Equal(HttpStatusCode.NotFound, (await CompleteAsync(_s.Bruno, Id(analyse))).StatusCode);
    }

    // 3a. Assignment

    [Fact]
    public async Task Start_working_links_the_task_and_others_must_take_over()
    {
        var instanceId = await AtAnalysisAsync();
        var analyse = Id(await OpenTaskAsync(_s.Bruno, instanceId));

        Assert.Equal(HttpStatusCode.OK, (await StartWorkingAsync(_s.Bruno, analyse)).StatusCode);
        var carlaInbox = await _s.Carla.GetFromJsonAsync<JsonElement>("/api/tasks");
        Assert.Contains(carlaInbox.GetProperty("assignedToOthers").EnumerateArray(), t => Id(t) == analyse);
        await (await CompleteAsync(_s.Carla, analyse)).AssertProblemAsync(HttpStatusCode.Conflict, "task_assigned");
        await (await StartWorkingAsync(_s.Carla, analyse)).AssertProblemAsync(HttpStatusCode.Conflict, "task_assigned");

        Assert.Equal(HttpStatusCode.OK, (await TakeOverAsync(_s.Carla, analyse)).StatusCode);
        await (await CompleteAsync(_s.Bruno, analyse)).AssertProblemAsync(HttpStatusCode.Conflict, "task_assigned");
        Assert.Equal(HttpStatusCode.OK, (await CompleteAsync(_s.Carla, analyse)).StatusCode);

        var instance = await _s.Bruno.GetFromJsonAsync<JsonElement>($"/api/instances/{instanceId}"); // Bruno is a participant
        var participants = instance.GetProperty("participants").EnumerateArray().Select(p => p.GetProperty("username").GetString()).Order().ToList();
        Assert.Equal(["ana", "bruno", "carla"], participants);
        var events = instance.GetProperty("timeline").EnumerateArray().Select(e => e.GetProperty("type").GetString()).ToList();
        Assert.Contains("task.taken_over", events);
    }

    [Fact]
    public async Task Completing_an_unassigned_task_links_the_actor()
    {
        var instanceId = await StartedInstanceAsync(_s.Ana, _s.DefinitionId);
        await CompleteAsync(_s.Ana, Id(await OpenTaskAsync(_s.Ana, instanceId)));

        var instance = await _s.Ana.GetFromJsonAsync<JsonElement>($"/api/instances/{instanceId}");

        Assert.Equal("ana", Assert.Single(instance.GetProperty("participants").EnumerateArray()).GetProperty("username").GetString());
    }

    // 4. Gateways, loops, completion

    [Fact]
    public async Task Decisions_follow_branches_loops_create_new_tasks_and_end_completes()
    {
        var instanceId = await AtAnalysisAsync();
        await CompleteAsync(_s.Bruno, Id(await OpenTaskAsync(_s.Bruno, instanceId)));
        var decision = await OpenTaskAsync(_s.Bruno, instanceId);
        Assert.Equal("decision", decision.GetProperty("kind").GetString());
        Assert.Equal("Documentação correta?", decision.GetProperty("question").GetString());

        Assert.Equal(HttpStatusCode.OK, (await DecideAsync(_s.Bruno, Id(decision), false, "Falta o comprovante de renda")).StatusCode);
        var fillAgain = await OpenTaskAsync(_s.Ana, instanceId);
        Assert.Equal("fill", fillAgain.GetProperty("nodeId").GetString());

        await CompleteAsync(_s.Ana, Id(fillAgain));
        await CompleteAsync(_s.Bruno, Id(await OpenTaskAsync(_s.Bruno, instanceId)));
        Assert.Equal(HttpStatusCode.OK, (await DecideAsync(_s.Bruno, Id(await OpenTaskAsync(_s.Bruno, instanceId)), true)).StatusCode);

        var instance = await _s.Ana.GetFromJsonAsync<JsonElement>($"/api/instances/{instanceId}");
        Assert.Equal("completed", instance.GetProperty("status").GetString());
        Assert.Empty(instance.GetProperty("openTasks").EnumerateArray());
        var decided = instance.GetProperty("timeline").EnumerateArray().Where(e => e.GetProperty("type").GetString() == "gateway.decided").ToList();
        Assert.Equal(2, decided.Count);
        Assert.Equal("Falta o comprovante de renda", decided[0].GetProperty("details").GetProperty("justification").GetString());
    }

    [Fact]
    public async Task Complete_and_decide_are_not_interchangeable()
    {
        var instanceId = await AtAnalysisAsync();
        var analyse = Id(await OpenTaskAsync(_s.Bruno, instanceId));

        await (await DecideAsync(_s.Bruno, analyse, true)).AssertProblemAsync(HttpStatusCode.Conflict, "wrong_task_kind");
        await CompleteAsync(_s.Bruno, analyse);
        await (await CompleteAsync(_s.Bruno, Id(await OpenTaskAsync(_s.Bruno, instanceId)))).AssertProblemAsync(HttpStatusCode.Conflict, "wrong_task_kind");
    }

    // 5. Concurrency and idempotency

    [Fact]
    public async Task Concurrent_completions_of_the_same_task_succeed_exactly_once()
    {
        var instanceId = await AtAnalysisAsync();
        var analyse = Id(await OpenTaskAsync(_s.Bruno, instanceId));

        var results = await Task.WhenAll(CompleteAsync(_s.Bruno, analyse), CompleteAsync(_s.Carla, analyse));

        Assert.Single(results, r => r.StatusCode == HttpStatusCode.OK);
        Assert.Single(results, r => r.StatusCode == HttpStatusCode.Conflict);
        Assert.Equal("docs_ok", (await OpenTaskAsync(_s.Bruno, instanceId)).GetProperty("nodeId").GetString());
    }

    [Fact]
    public async Task Idempotency_keys_replay_results_and_reject_reuse()
    {
        var key = NewKey();
        var first = await StartAsync(_s.Ana, _s.DefinitionId, key);
        var replay = await StartAsync(_s.Ana, _s.DefinitionId, key);

        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        Assert.Equal(HttpStatusCode.Created, replay.StatusCode);
        Assert.Equal(Id(await first.Content.ReadFromJsonAsync<JsonElement>()), Id(await replay.Content.ReadFromJsonAsync<JsonElement>()));
        Assert.Equal(1, await _factory.CountAsync("SELECT count(*) FROM chain.instances"));

        var other = await _s.PublishAsync("Outro", CreditScenario.Document(_s.Analistas));
        await (await StartAsync(_s.Ana, other, key)).AssertProblemAsync(HttpStatusCode.UnprocessableEntity, "idempotency_key_reused");
        await (await PostAsync(_s.Ana, "/api/instances", new { definitionId = _s.DefinitionId }, key: null)).AssertProblemAsync(HttpStatusCode.BadRequest, "idempotency_key_required");
    }

    [Fact]
    public async Task Replaying_a_completion_does_not_act_twice()
    {
        var instanceId = await StartedInstanceAsync(_s.Ana, _s.DefinitionId);
        var fill = Id(await OpenTaskAsync(_s.Ana, instanceId));
        var key = NewKey();

        var first = await CompleteAsync(_s.Ana, fill, key: key);
        var replay = await CompleteAsync(_s.Ana, fill, key: key);

        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.Equal(HttpStatusCode.OK, replay.StatusCode);
        Assert.Equal(1, await _factory.CountAsync($"SELECT count(*) FROM chain.instance_events WHERE instance_id = '{instanceId}' AND type = 'task.completed'"));
    }

    // 6. Close early

    [Fact]
    public async Task Requester_and_close_holders_can_close_with_a_justification()
    {
        var mine = await StartedInstanceAsync(_s.Ana, _s.DefinitionId);
        await (await CloseAsync(_s.Ana, mine, justification: " ")).AssertProblemAsync(HttpStatusCode.BadRequest, "validation_failed");
        Assert.Equal(HttpStatusCode.OK, (await CloseAsync(_s.Ana, mine, "Cliente desistiu")).StatusCode);

        var closed = await _s.Ana.GetFromJsonAsync<JsonElement>($"/api/instances/{mine}");
        Assert.Equal("cancelled", closed.GetProperty("status").GetString());
        Assert.Empty(closed.GetProperty("openTasks").EnumerateArray());

        var other = await AtAnalysisAsync();
        await (await CloseAsync(_s.Bruno, other, "não sou supervisor")).AssertProblemAsync(HttpStatusCode.Forbidden, "forbidden");
        await (await CloseAsync(_s.Fabio, other, "nem vejo")).AssertProblemAsync(HttpStatusCode.NotFound, "not_found");
        Assert.Equal(HttpStatusCode.OK, (await CloseAsync(_s.Diego, other, "Fraude identificada")).StatusCode);
    }

    // Regression #129: the timeline stores comments and justifications in jsonb, which cannot store the NUL character, so these
    // were 500s.

    [Fact]
    public async Task A_completion_comment_with_the_NUL_character_is_invalid()
    {
        var instanceId = await AtAnalysisAsync();
        var analyse = Id(await OpenTaskAsync(_s.Bruno, instanceId));

        await (await CompleteAsync(_s.Bruno, analyse, comment: "Documentos\u0000conferidos")).AssertValidationFailedAsync("invalid_comment");

        Assert.Equal("analyse", (await OpenTaskAsync(_s.Bruno, instanceId)).GetProperty("nodeId").GetString()); // the task stays open
    }

    [Fact]
    public async Task A_decision_justification_with_the_NUL_character_is_invalid()
    {
        var instanceId = await AtAnalysisAsync();
        Assert.Equal(HttpStatusCode.OK, (await CompleteAsync(_s.Bruno, Id(await OpenTaskAsync(_s.Bruno, instanceId)))).StatusCode);
        var decision = Id(await OpenTaskAsync(_s.Bruno, instanceId));

        await (await DecideAsync(_s.Bruno, decision, outcome: true, justification: "Tudo\u0000certo")).AssertValidationFailedAsync("invalid_justification");

        Assert.Equal("docs_ok", (await OpenTaskAsync(_s.Bruno, instanceId)).GetProperty("nodeId").GetString()); // still undecided
    }

    [Fact]
    public async Task A_close_justification_with_the_NUL_character_is_invalid()
    {
        var instanceId = await StartedInstanceAsync(_s.Ana, _s.DefinitionId);

        await (await CloseAsync(_s.Ana, instanceId, "Cliente\u0000desistiu")).AssertValidationFailedAsync("invalid_justification");

        Assert.Equal("running", (await _s.Ana.GetFromJsonAsync<JsonElement>($"/api/instances/{instanceId}")).GetProperty("status").GetString());
    }

    [Fact]
    public async Task Terminal_instances_reject_commands()
    {
        var instanceId = await StartedInstanceAsync(_s.Ana, _s.DefinitionId);
        var fill = Id(await OpenTaskAsync(_s.Ana, instanceId));
        await CloseAsync(_s.Ana, instanceId, "Cancelado");

        await (await CompleteAsync(_s.Ana, fill)).AssertProblemAsync(HttpStatusCode.Conflict, "task_not_open");
        await (await CloseAsync(_s.Ana, instanceId, "De novo")).AssertProblemAsync(HttpStatusCode.Conflict, "instance_not_running");
    }

    // 7. Visibility

    [Fact]
    public async Task Visibility_follows_requester_participants_eligibility_view_and_admin()
    {
        var instanceId = await AtAnalysisAsync();

        Assert.Equal(HttpStatusCode.OK, (await _s.Ana.GetAsync($"/api/instances/{instanceId}")).StatusCode);   // requester
        Assert.Equal(HttpStatusCode.OK, (await _s.Carla.GetAsync($"/api/instances/{instanceId}")).StatusCode); // eligible for open task
        Assert.Equal(HttpStatusCode.OK, (await _s.Eva.GetAsync($"/api/instances/{instanceId}")).StatusCode);   // view capability
        Assert.Equal(HttpStatusCode.OK, (await _s.Admin.GetAsync($"/api/instances/{instanceId}")).StatusCode); // admin
        Assert.Equal(HttpStatusCode.NotFound, (await _s.Fabio.GetAsync($"/api/instances/{instanceId}")).StatusCode);

        var visibleToEva = await _s.Eva.GetFromJsonAsync<JsonElement>("/api/instances?scope=visible");
        var mineForEva = await _s.Eva.GetFromJsonAsync<JsonElement>("/api/instances?scope=mine");
        Assert.Contains(visibleToEva.EnumerateArray(), i => Id(i) == instanceId);
        Assert.Empty(mineForEva.EnumerateArray());
        Assert.Single((await _s.Ana.GetFromJsonAsync<JsonElement>("/api/instances?scope=mine")).EnumerateArray());
    }

    // 8. Timeline

    [Fact]
    public async Task Timeline_records_actor_and_group_acted_as()
    {
        var instanceId = await AtAnalysisAsync();
        await CompleteAsync(_s.Bruno, Id(await OpenTaskAsync(_s.Bruno, instanceId)), comment: "Documentos conferidos");

        var timeline = (await _s.Ana.GetFromJsonAsync<JsonElement>($"/api/instances/{instanceId}")).GetProperty("timeline").EnumerateArray().ToList();

        Assert.Equal("instance.started", timeline[0].GetProperty("type").GetString());
        var analysis = timeline.Last(e => e.GetProperty("type").GetString() == "task.completed");
        Assert.Equal("bruno", analysis.GetProperty("actor").GetProperty("username").GetString());
        Assert.Equal("Analistas", analysis.GetProperty("actedAsGroup").GetProperty("name").GetString());
        Assert.Equal("Documentos conferidos", analysis.GetProperty("details").GetProperty("comment").GetString());
    }

    // Helpers

    /// <summary>Starts an instance as Ana and completes "Preencher proposta", so the token waits at "Analisar".</summary>
    private async Task<Guid> AtAnalysisAsync()
    {
        var instanceId = await StartedInstanceAsync(_s.Ana, _s.DefinitionId);
        Assert.Equal(HttpStatusCode.OK, (await CompleteAsync(_s.Ana, Id(await OpenTaskAsync(_s.Ana, instanceId)))).StatusCode);
        return instanceId;
    }

    private async Task RepublishAsync(JsonObject document)
    {
        var etag = (await _s.Admin.GetAsync($"/api/workflows/{_s.DefinitionId}")).Headers.ETag!.Tag;
        using var draft = new HttpRequestMessage(HttpMethod.Put, $"/api/workflows/{_s.DefinitionId}/draft") { Content = JsonContent.Create(new { document }) };
        draft.Headers.TryAddWithoutValidation("If-Match", etag);
        var saved = await _s.Admin.SendAsync(draft);
        using var publish = new HttpRequestMessage(HttpMethod.Post, $"/api/workflows/{_s.DefinitionId}/publish");
        publish.Headers.TryAddWithoutValidation("If-Match", saved.Headers.ETag!.Tag);
        Assert.Equal(HttpStatusCode.Created, (await _s.Admin.SendAsync(publish)).StatusCode);
    }

    private async Task<Guid> GroupOfAnaAsync()
    {
        var me = await _s.Ana.GetFromJsonAsync<JsonElement>("/api/auth/me");
        return Id(Assert.Single(me.GetProperty("groups").EnumerateArray()));
    }
}
