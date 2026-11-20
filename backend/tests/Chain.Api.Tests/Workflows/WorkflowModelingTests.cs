using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Chain.Api.Tests.Infrastructure;

namespace Chain.Api.Tests.Workflows;

/// <summary>Acceptance criteria of increment W2: workflow persistence, drafts and publishing (workflow-definition.md §5).</summary>
[Collection(PostgresTestGroup.Name)]
public sealed class WorkflowModelingTests(PostgresFixture postgres) : IAsyncLifetime, IDisposable
{
    private const string UserPassword = "modeler-own-passphrase";
    private static readonly string[] StartAndView = ["start", "view"];
    private static readonly string[] StartOnly = ["start"];
    private static readonly string[] UnknownCapability = ["delete-everything"];

    private readonly ChainApiFactory _factory = new(postgres.ConnectionString);

    public async Task InitializeAsync() => await _factory.ResetDatabaseAsync();

    public Task DisposeAsync() => Task.CompletedTask;

    public void Dispose() => _factory.Dispose();

    // 1. Who models

    [Fact]
    public async Task Only_admins_and_modelers_can_use_workflow_endpoints()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var (ana, temporary) = await CreateUserAsync(admin, "ana.souza");
        using var anaBrowser = await _factory.CreateReadyUserAsync("ana.souza", temporary, UserPassword);
        using var anonymous = _factory.CreateBrowser();

        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/workflows")).StatusCode);
        await (await anaBrowser.GetAsync("/api/workflows")).AssertProblemAsync(HttpStatusCode.Forbidden, "forbidden");
        Assert.Equal(HttpStatusCode.OK, (await admin.GetAsync("/api/workflows")).StatusCode);

        var modelers = await CreateGroupAsync(admin, "Modeladores");
        await admin.PutAsync($"/api/admin/groups/{modelers}/members/{ana}", null);
        Assert.Equal(HttpStatusCode.NoContent, (await admin.PutAsync($"/api/admin/groups/{modelers}/modeler", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await admin.PutAsync($"/api/admin/groups/{modelers}/modeler", null)).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await anaBrowser.PostAsJsonAsync("/api/workflows", new { name = "Concessão de Crédito" })).StatusCode);

        await admin.DeleteAsync($"/api/admin/groups/{modelers}/members/{ana}");
        Assert.Equal(HttpStatusCode.Forbidden, (await anaBrowser.GetAsync("/api/workflows")).StatusCode);

        await admin.PutAsync($"/api/admin/groups/{modelers}/members/{ana}", null);
        Assert.Equal(HttpStatusCode.OK, (await anaBrowser.GetAsync("/api/workflows")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await admin.DeleteAsync($"/api/admin/groups/{modelers}/modeler")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await admin.DeleteAsync($"/api/admin/groups/{modelers}/modeler")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await anaBrowser.GetAsync("/api/workflows")).StatusCode);
    }

    [Fact]
    public async Task Me_says_whether_the_caller_can_model_by_the_same_rule_as_the_workflow_endpoints()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var (ana, temporary) = await CreateUserAsync(admin, "ana.souza");
        using var anaBrowser = await _factory.CreateReadyUserAsync("ana.souza", temporary, UserPassword);

        async Task<bool> CanModelAsync(HttpClient client) =>
            (await client.GetFromJsonAsync<JsonElement>("/api/auth/me")).GetProperty("canModel").GetBoolean();

        Assert.True(await CanModelAsync(admin));
        Assert.False(await CanModelAsync(anaBrowser));

        var modelers = await CreateGroupAsync(admin, "Modeladores");
        await admin.PutAsync($"/api/admin/groups/{modelers}/members/{ana}", null);
        Assert.False(await CanModelAsync(anaBrowser));
        await admin.PutAsync($"/api/admin/groups/{modelers}/modeler", null);
        Assert.True(await CanModelAsync(anaBrowser));

        await admin.PostAsync($"/api/admin/groups/{modelers}/archive", null);
        Assert.False(await CanModelAsync(anaBrowser));
        await admin.PostAsync($"/api/admin/groups/{modelers}/unarchive", null);
        Assert.True(await CanModelAsync(anaBrowser));

        await admin.DeleteAsync($"/api/admin/groups/{modelers}/modeler");
        Assert.False(await CanModelAsync(anaBrowser));
    }

    [Fact]
    public async Task Lane_groups_are_the_active_groups_by_name_with_ids_and_names_only_for_admins_and_modelers()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var (ana, temporary) = await CreateUserAsync(admin, "ana.souza");
        using var anaBrowser = await _factory.CreateReadyUserAsync("ana.souza", temporary, UserPassword);
        var cadastro = await CreateGroupAsync(admin, "Cadastro");
        var analise = await CreateGroupAsync(admin, "Análise de Crédito");
        var antigo = await CreateGroupAsync(admin, "Antigo");
        Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsync($"/api/admin/groups/{antigo}/archive", null)).StatusCode);

        await (await anaBrowser.GetAsync("/api/workflows/groups")).AssertProblemAsync(HttpStatusCode.Forbidden, "forbidden");

        var modelers = await CreateGroupAsync(admin, "Modeladores");
        await admin.PutAsync($"/api/admin/groups/{modelers}/members/{ana}", null);
        await admin.PutAsync($"/api/admin/groups/{modelers}/modeler", null);
        var groups = await anaBrowser.GetFromJsonAsync<JsonElement>("/api/workflows/groups");

        Assert.Equal(
            [("Análise de Crédito", analise), ("Cadastro", cadastro), ("Modeladores", modelers)],
            groups.EnumerateArray().Select(group => (group.GetProperty("name").GetString()!, group.GetProperty("id").GetGuid())));
        Assert.All(groups.EnumerateArray(), group => Assert.Equal(["id", "name"], group.EnumerateObject().Select(property => property.Name)));
        Assert.Equal(HttpStatusCode.OK, (await admin.GetAsync("/api/workflows/groups")).StatusCode);
    }

    [Fact]
    public async Task Modeler_grant_is_admin_only()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var (ana, temporary) = await CreateUserAsync(admin, "ana.souza");
        var modelers = await CreateGroupAsync(admin, "Modeladores");
        await admin.PutAsync($"/api/admin/groups/{modelers}/members/{ana}", null);
        await admin.PutAsync($"/api/admin/groups/{modelers}/modeler", null);
        using var anaBrowser = await _factory.CreateReadyUserAsync("ana.souza", temporary, UserPassword);

        await (await anaBrowser.PutAsync($"/api/admin/groups/{modelers}/modeler", null)).AssertProblemAsync(HttpStatusCode.Forbidden, "forbidden");
    }

    [Fact]
    public async Task Archived_groups_cannot_be_granted_modeler_and_archiving_suspends_the_grant()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var (ana, temporary) = await CreateUserAsync(admin, "ana.souza");
        var modelers = await CreateGroupAsync(admin, "Modeladores");
        await admin.PutAsync($"/api/admin/groups/{modelers}/members/{ana}", null);
        await admin.PutAsync($"/api/admin/groups/{modelers}/modeler", null);
        using var anaBrowser = await _factory.CreateReadyUserAsync("ana.souza", temporary, UserPassword);
        Assert.Equal(HttpStatusCode.OK, (await anaBrowser.GetAsync("/api/workflows")).StatusCode);

        await admin.PostAsync($"/api/admin/groups/{modelers}/archive", null);
        Assert.Equal(HttpStatusCode.Forbidden, (await anaBrowser.GetAsync("/api/workflows")).StatusCode);

        await admin.PostAsync($"/api/admin/groups/{modelers}/unarchive", null);
        Assert.Equal(HttpStatusCode.OK, (await anaBrowser.GetAsync("/api/workflows")).StatusCode);

        var other = await CreateGroupAsync(admin, "Arquivado");
        await admin.PostAsync($"/api/admin/groups/{other}/archive", null);
        await (await admin.PutAsync($"/api/admin/groups/{other}/modeler", null)).AssertProblemAsync(HttpStatusCode.Conflict, "group_archived");
    }

    [Fact]
    public async Task Definition_names_are_unique_ignoring_case()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        await CreateDefinitionAsync(admin, "Concessão de Crédito");

        var duplicate = await admin.PostAsJsonAsync("/api/workflows", new { name = "concessão de crédito" });

        await duplicate.AssertProblemAsync(HttpStatusCode.Conflict, "workflow_name_taken");
    }

    // 2. Drafts

    [Fact]
    public async Task Structurally_invalid_drafts_are_saved_but_malformed_ones_are_rejected()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var id = await CreateDefinitionAsync(admin, "Rascunho");
        var incomplete = ValidDocument();
        incomplete["nodes"]!.AsArray().RemoveAt(2); // no end node

        var saved = await SaveDraftAsync(admin, id, incomplete);
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
        var draft = (await admin.GetFromJsonAsync<JsonElement>($"/api/workflows/{id}")).GetProperty("draft");
        Assert.Equal(2, draft.GetProperty("nodes").GetArrayLength());

        var malformed = ValidDocument();
        malformed["nodes"]![1]!["type"] = "parallelGateway";
        await (await SaveDraftAsync(admin, id, malformed)).AssertProblemAsync(HttpStatusCode.BadRequest, "invalid_document");
    }

    // Regression #93: these two were 500s. A body without "document" made GetRawText throw on the undefined element, and
    // PostgreSQL jsonb cannot store the NUL character, so saving one failed in the database.

    [Fact]
    public async Task A_draft_without_a_document_is_an_invalid_document()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var id = await CreateDefinitionAsync(admin, "Sem documento");

        var missing = await SendAsync(admin, HttpMethod.Put, $"/api/workflows/{id}/draft", new { }, await ETagAsync(admin, id));
        var nulled = await SendAsync(admin, HttpMethod.Put, $"/api/workflows/{id}/draft", new { document = (object?)null }, await ETagAsync(admin, id));

        Assert.Equal("WF000", await SingleFindingAsync(missing));
        Assert.Equal("WF000", await SingleFindingAsync(nulled));
    }

    [Fact]
    public async Task A_draft_with_the_NUL_character_is_an_invalid_document()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var id = await CreateDefinitionAsync(admin, "Com NUL");
        var document = ValidDocument(laneGroupId: Guid.NewGuid());
        document["lanes"]![0]!["title"] = "Análise\u0000";

        var response = await SaveDraftAsync(admin, id, document);

        Assert.Equal("WF000", await SingleFindingAsync(response));
        var draft = (await admin.GetFromJsonAsync<JsonElement>($"/api/workflows/{id}")).GetProperty("draft");
        Assert.Equal(0, draft.GetProperty("lanes").GetArrayLength()); // the empty draft is kept
    }

    // Regression #129: PostgreSQL cannot store the NUL character in text, nor an unpaired surrogate in jsonb, so these were 500s.
    // A serializer writes a lone surrogate as U+FFFD, so the escape is sent as JSON text written by hand.

    [Fact]
    public async Task A_name_or_description_with_the_NUL_character_is_invalid()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var id = await CreateDefinitionAsync(admin, "Concessão");

        await (await admin.PostAsJsonAsync("/api/workflows", new { name = "Crédito\u0000" })).AssertValidationFailedAsync("invalid_name");
        await (await admin.PostAsJsonAsync("/api/workflows", new { name = "Crédito", description = "Fluxo\u0000" })).AssertValidationFailedAsync("invalid_description");
        await (await SendAsync(admin, HttpMethod.Patch, $"/api/workflows/{id}", new { name = "Concessão\u0000" }, await ETagAsync(admin, id))).AssertValidationFailedAsync("invalid_name");
        await (await SendAsync(admin, HttpMethod.Patch, $"/api/workflows/{id}", new { description = "\u0000" }, await ETagAsync(admin, id))).AssertValidationFailedAsync("invalid_description");

        Assert.Equal(["Concessão"], await _factory.QueryAsync("SELECT name FROM chain.workflow_definitions"));
    }

    [Fact]
    public async Task A_draft_with_an_unpaired_surrogate_is_an_invalid_document()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var id = await CreateDefinitionAsync(admin, "Com surrogate");
        var document = ValidDocument();
        document["nodes"]![0]!["layout"] = new JsonObject { ["x"] = 10, ["y"] = 20, ["nota"] = "UNPAIRED" };
        using var request = new HttpRequestMessage(HttpMethod.Put, $"/api/workflows/{id}/draft")
        {
            Content = ApiTestSession.RawJson(new JsonObject { ["document"] = document }.ToJsonString().Replace("UNPAIRED", "\\udc00", StringComparison.Ordinal)),
        };
        request.Headers.TryAddWithoutValidation("If-Match", await ETagAsync(admin, id));

        var response = await admin.SendAsync(request);

        Assert.Equal("WF000", await SingleFindingAsync(response));
        var draft = (await admin.GetFromJsonAsync<JsonElement>($"/api/workflows/{id}")).GetProperty("draft");
        Assert.Equal(0, draft.GetProperty("nodes").GetArrayLength()); // the empty draft is kept
    }

    // Regression #153: bytes that are not UTF-8 reached GetRawText, which threw: a 500. Such a body is not JSON (identity.md I1).

    [Fact]
    public async Task A_draft_whose_bytes_are_not_UTF8_is_malformed_json()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var id = await CreateDefinitionAsync(admin, "Com bytes");
        var document = ValidDocument();
        document["nodes"]![0]!["label"] = "NOT_UTF8";
        using var request = new HttpRequestMessage(HttpMethod.Put, $"/api/workflows/{id}/draft")
        {
            Content = ApiTestSession.NotUtf8Json(new JsonObject { ["document"] = document }.ToJsonString()),
        };
        request.Headers.TryAddWithoutValidation("If-Match", await ETagAsync(admin, id));

        var response = await admin.SendAsync(request);

        await response.AssertMalformedJsonAsync(admin, HttpMethod.Put, $"/api/workflows/{id}/draft");
        var draft = (await admin.GetFromJsonAsync<JsonElement>($"/api/workflows/{id}")).GetProperty("draft");
        Assert.Equal(0, draft.GetProperty("nodes").GetArrayLength()); // the empty draft is kept
    }

    [Fact]
    public async Task New_definition_starts_with_an_empty_draft_and_inactive()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var id = await CreateDefinitionAsync(admin, "Novo");

        var definition = await admin.GetFromJsonAsync<JsonElement>($"/api/workflows/{id}");

        Assert.False(definition.GetProperty("isActive").GetBoolean());
        Assert.Equal(JsonValueKind.Null, definition.GetProperty("latestVersion").ValueKind);
        Assert.Equal(0, definition.GetProperty("draft").GetProperty("nodes").GetArrayLength());
    }

    // 3. Validate

    [Fact]
    public async Task Validate_reports_structural_and_reference_errors_with_element_ids()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var id = await CreateDefinitionAsync(admin, "Com erros");
        var document = ValidDocument(laneGroupId: Guid.NewGuid());
        document["nodes"]![1]!["label"] = "";
        await SaveDraftAsync(admin, id, document);

        var result = await (await admin.PostAsync($"/api/workflows/{id}/validate", null)).Content.ReadFromJsonAsync<JsonElement>();

        Assert.False(result.GetProperty("valid").GetBoolean());
        var errors = result.GetProperty("errors").EnumerateArray().Select(e => (e.GetProperty("code").GetString(), e.GetProperty("elementId").GetString())).ToList();
        Assert.Contains(("WF012", "task_1"), errors);
        Assert.Contains(("WF101", "lane_1"), errors);
    }

    // 4–5. Publishing and immutable versions

    [Fact]
    public async Task Publishing_creates_immutable_numbered_versions()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var id = await CreateDefinitionAsync(admin, "Concessão");
        await SaveDraftAsync(admin, id, ValidDocument(taskLabel: "Primeira versão"));

        var first = await PublishAsync(admin, id);
        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        var firstBody = await first.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(1, firstBody.GetProperty("versionNumber").GetInt32());
        Assert.StartsWith("sha256:", firstBody.GetProperty("contentHash").GetString(), StringComparison.Ordinal);

        await SaveDraftAsync(admin, id, ValidDocument(taskLabel: "Segunda versão"));
        Assert.Equal(2, (await (await PublishAsync(admin, id)).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("versionNumber").GetInt32());
        await SaveDraftAsync(admin, id, ValidDocument(taskLabel: "Rascunho posterior"));

        var v1 = await admin.GetFromJsonAsync<JsonElement>($"/api/workflows/{id}/versions/1");
        Assert.Equal("Primeira versão", TaskLabel(v1.GetProperty("document")));
        var definition = await admin.GetFromJsonAsync<JsonElement>($"/api/workflows/{id}");
        Assert.True(definition.GetProperty("isActive").GetBoolean());
        Assert.Equal(2, definition.GetProperty("latestVersion").GetInt32());
        Assert.Equal(2, (await admin.GetFromJsonAsync<JsonElement>($"/api/workflows/{id}/versions")).GetArrayLength());
    }

    [Fact]
    public async Task Publishing_an_unchanged_draft_creates_no_new_version()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var id = await CreateDefinitionAsync(admin, "Concessão");
        await SaveDraftAsync(admin, id, ValidDocument());
        await PublishAsync(admin, id);

        var again = await PublishAsync(admin, id);

        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
        Assert.Equal(1, (await again.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("versionNumber").GetInt32());
        Assert.Single((await admin.GetFromJsonAsync<JsonElement>($"/api/workflows/{id}/versions")).EnumerateArray());
    }

    [Fact]
    public async Task Deactivation_and_activation_toggle_the_definition()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var id = await CreateDefinitionAsync(admin, "Concessão");
        await SaveDraftAsync(admin, id, ValidDocument());
        await PublishAsync(admin, id);

        Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsync($"/api/workflows/{id}/deactivate", null)).StatusCode);
        Assert.False((await admin.GetFromJsonAsync<JsonElement>($"/api/workflows/{id}")).GetProperty("isActive").GetBoolean());
        Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsync($"/api/workflows/{id}/activate", null)).StatusCode);
        Assert.True((await admin.GetFromJsonAsync<JsonElement>($"/api/workflows/{id}")).GetProperty("isActive").GetBoolean());
    }

    // 6. Publish reference errors

    [Fact]
    public async Task Publish_rejects_unknown_and_archived_groups()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var archived = await CreateGroupAsync(admin, "Antigo");
        await admin.PostAsync($"/api/admin/groups/{archived}/archive", null);

        var unknown = await CreateDefinitionAsync(admin, "Grupo inexistente");
        await SaveDraftAsync(admin, unknown, ValidDocument(laneGroupId: Guid.NewGuid()));
        await AssertPublishErrorAsync(admin, unknown, "WF101", "lane_1");

        var old = await CreateDefinitionAsync(admin, "Grupo arquivado");
        await SaveDraftAsync(admin, old, ValidDocument(laneGroupId: archived));
        await AssertPublishErrorAsync(admin, old, "WF102", "lane_1");
    }

    [Fact]
    public async Task Publish_rejects_references_to_unknown_forms_and_automations()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var id = await CreateDefinitionAsync(admin, "Com formulário");
        var document = ValidDocument();
        document["nodes"]![1]!["form"] = new JsonObject { ["formId"] = "proposta" };
        await SaveDraftAsync(admin, id, document);
        await AssertPublishErrorAsync(admin, id, "WF103", "task_1");

        var automation = ValidDocument();
        automation["nodes"]![1]!["taskKind"] = "automation";
        automation["nodes"]![1]!["automation"] = new JsonObject { ["automationId"] = "consulta-serasa" };
        await SaveDraftAsync(admin, id, automation);
        await AssertPublishErrorAsync(admin, id, "WF104", "task_1");
    }

    [Fact]
    public async Task Publish_rejects_unpublished_and_self_referencing_subprocesses()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var child = await CreateDefinitionAsync(admin, "Filho sem versão");
        var parent = await CreateDefinitionAsync(admin, "Pai");

        await SaveDraftAsync(admin, parent, SubprocessDocument(child));
        await AssertPublishErrorAsync(admin, parent, "WF105", "task_1");

        await SaveDraftAsync(admin, parent, SubprocessDocument(parent));
        await AssertPublishErrorAsync(admin, parent, "WF106", "task_1");

        await SaveDraftAsync(admin, parent, SubprocessDocument(Guid.NewGuid()));
        await AssertPublishErrorAsync(admin, parent, "WF105", "task_1");
    }

    // 7. Pinning

    [Fact]
    public async Task Subprocess_references_are_pinned_at_publish_time()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var child = await CreateDefinitionAsync(admin, "Verificação cadastral");
        await SaveDraftAsync(admin, child, ValidDocument(taskLabel: "v1"));
        await PublishAsync(admin, child);
        var parent = await CreateDefinitionAsync(admin, "Concessão");
        await SaveDraftAsync(admin, parent, SubprocessDocument(child));

        Assert.Equal(HttpStatusCode.Created, (await PublishAsync(admin, parent)).StatusCode);
        await SaveDraftAsync(admin, child, ValidDocument(taskLabel: "v2"));
        await PublishAsync(admin, child);

        var parentV1 = await admin.GetFromJsonAsync<JsonElement>($"/api/workflows/{parent}/versions/1");
        Assert.Equal(1, SubprocessPin(parentV1.GetProperty("document")));
        var draft = (await admin.GetFromJsonAsync<JsonElement>($"/api/workflows/{parent}")).GetProperty("draft");
        Assert.False(draft.GetProperty("nodes")[1].GetProperty("workflow").TryGetProperty("version", out _));

        await SaveDraftAsync(admin, parent, SubprocessDocument(child, label: "Verificar cadastro (v2)"));
        await PublishAsync(admin, parent);
        var parentV2 = await admin.GetFromJsonAsync<JsonElement>($"/api/workflows/{parent}/versions/2");
        Assert.Equal(2, SubprocessPin(parentV2.GetProperty("document")));
    }

    // 8. Append-only versions

    [Fact]
    public async Task Database_rejects_changes_to_published_versions()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var id = await CreateDefinitionAsync(admin, "Concessão");
        await SaveDraftAsync(admin, id, ValidDocument());
        await PublishAsync(admin, id);

        var update = await Assert.ThrowsAnyAsync<Exception>(() => _factory.QueryAsync("UPDATE chain.workflow_versions SET content_hash = 'x' RETURNING id"));
        var delete = await Assert.ThrowsAnyAsync<Exception>(() => _factory.QueryAsync("DELETE FROM chain.workflow_versions RETURNING id"));

        Assert.Contains("append-only", update.Message, StringComparison.Ordinal);
        Assert.Contains("append-only", delete.Message, StringComparison.Ordinal);
    }

    // 9. Versions required

    [Fact]
    public async Task Draft_publish_restore_and_grants_require_the_current_version()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var id = await CreateDefinitionAsync(admin, "Concessão");
        var stale = await ETagAsync(admin, id);
        await SaveDraftAsync(admin, id, ValidDocument());
        await PublishAsync(admin, id);

        foreach (var (method, path, body) in new (HttpMethod, string, object?)[]
        {
            (HttpMethod.Put, $"/api/workflows/{id}/draft", new { document = ValidDocument() }),
            (HttpMethod.Post, $"/api/workflows/{id}/publish", null),
            (HttpMethod.Post, $"/api/workflows/{id}/versions/1/restore", null),
            (HttpMethod.Put, $"/api/workflows/{id}/grants", Array.Empty<object>()),
        })
        {
            await (await SendAsync(admin, method, path, body, etag: null)).AssertProblemAsync(HttpStatusCode.PreconditionRequired, "precondition_required");
            await (await SendAsync(admin, method, path, body, stale)).AssertProblemAsync(HttpStatusCode.PreconditionFailed, "version_mismatch");
        }
    }

    // 10. Restore

    [Fact]
    public async Task Restoring_a_version_copies_it_into_the_draft_unpinned()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var child = await CreateDefinitionAsync(admin, "Filho");
        await SaveDraftAsync(admin, child, ValidDocument());
        await PublishAsync(admin, child);
        var id = await CreateDefinitionAsync(admin, "Concessão");
        await SaveDraftAsync(admin, id, SubprocessDocument(child, label: "Original"));
        await PublishAsync(admin, id);
        await SaveDraftAsync(admin, id, SubprocessDocument(child, label: "Alterado"));
        await PublishAsync(admin, id);

        var restore = await SendAsync(admin, HttpMethod.Post, $"/api/workflows/{id}/versions/1/restore", null, await ETagAsync(admin, id));

        Assert.Equal(HttpStatusCode.OK, restore.StatusCode);
        var draft = (await admin.GetFromJsonAsync<JsonElement>($"/api/workflows/{id}")).GetProperty("draft");
        Assert.Equal("Original", TaskLabel(draft));
        Assert.False(draft.GetProperty("nodes")[1].GetProperty("workflow").TryGetProperty("version", out _));
        Assert.Equal(3, (await (await PublishAsync(admin, id)).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("versionNumber").GetInt32());
    }

    // 11. Grants

    [Fact]
    public async Task Workflow_grants_round_trip_and_reject_unknown_groups()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var id = await CreateDefinitionAsync(admin, "Concessão");
        var analysts = await CreateGroupAsync(admin, "Analistas");

        var put = await SendAsync(admin, HttpMethod.Put, $"/api/workflows/{id}/grants",
            new[] { new { groupId = analysts, capabilities = StartAndView } }, await ETagAsync(admin, id));
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);

        var grants = await admin.GetFromJsonAsync<JsonElement>($"/api/workflows/{id}/grants");
        var grant = Assert.Single(grants.EnumerateArray());
        Assert.Equal(analysts, grant.GetProperty("groupId").GetGuid());
        Assert.Equal("Analistas", grant.GetProperty("groupName").GetString());
        Assert.Equal(["start", "view"], grant.GetProperty("capabilities").EnumerateArray().Select(c => c.GetString()).Order());

        var unknown = await SendAsync(admin, HttpMethod.Put, $"/api/workflows/{id}/grants",
            new[] { new { groupId = Guid.NewGuid(), capabilities = StartOnly } }, await ETagAsync(admin, id));
        await unknown.AssertProblemAsync(HttpStatusCode.UnprocessableEntity, "invalid_grants");

        var badCapability = await SendAsync(admin, HttpMethod.Put, $"/api/workflows/{id}/grants",
            new[] { new { groupId = analysts, capabilities = UnknownCapability } }, await ETagAsync(admin, id));
        await badCapability.AssertProblemAsync(HttpStatusCode.UnprocessableEntity, "invalid_grants");
    }

    [Fact]
    public async Task Replacing_grants_answers_with_the_process_ETag_so_the_editor_can_save_its_draft_next()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var id = await CreateDefinitionAsync(admin, "Concessão");
        var analysts = await CreateGroupAsync(admin, "Analistas");
        var before = await ETagAsync(admin, id);
        _factory.Time.Advance(TimeSpan.FromMinutes(1)); // the change touches the process with the time, which moves outside tests

        var put = await SendAsync(admin, HttpMethod.Put, $"/api/workflows/{id}/grants",
            new[] { new { groupId = analysts, capabilities = StartAndView } }, before);

        Assert.Equal(HttpStatusCode.OK, put.StatusCode);
        var etag = put.Headers.ETag?.Tag;
        Assert.NotEqual(before, etag); // the change touches the process (admin-ui.md §8, S-A2)
        Assert.Equal(await ETagAsync(admin, id), etag);
        Assert.Equal(analysts, Assert.Single((await put.Content.ReadFromJsonAsync<JsonElement>()).EnumerateArray()).GetProperty("groupId").GetGuid());

        var saved = await SendAsync(admin, HttpMethod.Put, $"/api/workflows/{id}/draft", new { document = ValidDocument() }, etag);
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
        await (await SendAsync(admin, HttpMethod.Put, $"/api/workflows/{id}/grants", Array.Empty<object>(), before))
            .AssertProblemAsync(HttpStatusCode.PreconditionFailed, "version_mismatch");
    }

    [Fact]
    public async Task Workflow_changes_are_audited()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var id = await CreateDefinitionAsync(admin, "Concessão");
        await SaveDraftAsync(admin, id, ValidDocument());
        await PublishAsync(admin, id);

        var actions = await _factory.QueryAsync($"SELECT action FROM chain.audit_events WHERE subject_id = '{id}'");

        Assert.Equal(["workflow.created", "workflow.draft_saved", "workflow.published"], actions.Order(StringComparer.Ordinal));
    }

    // Helpers

    /// <summary>start_1 → task_1 → end_1, optionally all inside lane_1 bound to a group.</summary>
    private static JsonObject ValidDocument(Guid? laneGroupId = null, string taskLabel = "Analisar proposta")
    {
        var lanes = new JsonArray();
        if (laneGroupId is { } groupId)
        {
            lanes.Add(new JsonObject { ["id"] = "lane_1", ["title"] = "Análise", ["group"] = new JsonObject { ["kind"] = "group", ["groupId"] = groupId.ToString() } });
        }

        JsonObject Node(string id, string type, string label) =>
            laneGroupId is null ? new() { ["id"] = id, ["type"] = type, ["label"] = label } : new() { ["id"] = id, ["type"] = type, ["label"] = label, ["laneId"] = "lane_1" };

        var task = Node("task_1", "task", taskLabel);
        task["taskKind"] = "human";
        return new JsonObject
        {
            ["schemaVersion"] = 1,
            ["lanes"] = lanes,
            ["nodes"] = new JsonArray { Node("start_1", "start", "Início"), task, Node("end_1", "end", "Fim") },
            ["flows"] = new JsonArray
            {
                new JsonObject { ["id"] = "f_1", ["source"] = "start_1", ["target"] = "task_1" },
                new JsonObject { ["id"] = "f_2", ["source"] = "task_1", ["target"] = "end_1" },
            },
        };
    }

    private static JsonObject SubprocessDocument(Guid childId, string label = "Verificar cadastro")
    {
        var document = ValidDocument(taskLabel: label);
        var task = document["nodes"]![1]!.AsObject();
        task["taskKind"] = "subprocess";
        task["workflow"] = new JsonObject { ["workflowId"] = childId.ToString() };
        return document;
    }

    private static string? TaskLabel(JsonElement document) => document.GetProperty("nodes")[1].GetProperty("label").GetString();

    private static int SubprocessPin(JsonElement document) => document.GetProperty("nodes")[1].GetProperty("workflow").GetProperty("version").GetInt32();

    private static async Task<Guid> CreateDefinitionAsync(HttpClient client, string name)
    {
        var response = await client.PostAsJsonAsync("/api/workflows", new { name });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    private static async Task<string> ETagAsync(HttpClient client, Guid id) =>
        (await client.GetAsync($"/api/workflows/{id}")).Headers.ETag!.Tag;

    private static async Task<HttpResponseMessage> SaveDraftAsync(HttpClient client, Guid id, JsonObject document) =>
        await SendAsync(client, HttpMethod.Put, $"/api/workflows/{id}/draft", new { document }, await ETagAsync(client, id));

    private static async Task<HttpResponseMessage> PublishAsync(HttpClient client, Guid id) =>
        await SendAsync(client, HttpMethod.Post, $"/api/workflows/{id}/publish", null, await ETagAsync(client, id));

    /// <summary>Asserts a 400 <c>invalid_document</c> and returns the code of its single finding.</summary>
    private static async Task<string?> SingleFindingAsync(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("invalid_document", problem.GetProperty("code").GetString());
        return Assert.Single(problem.GetProperty("errors").EnumerateArray()).GetProperty("code").GetString();
    }

    private static async Task AssertPublishErrorAsync(HttpClient client, Guid id, string code, string elementId)
    {
        var response = await PublishAsync(client, id);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("publish_validation_failed", problem.GetProperty("code").GetString());
        Assert.Contains(problem.GetProperty("errors").EnumerateArray(),
            e => e.GetProperty("code").GetString() == code && e.GetProperty("elementId").GetString() == elementId);
    }

    private static async Task<HttpResponseMessage> SendAsync(HttpClient client, HttpMethod method, string path, object? body, string? etag)
    {
        using var request = new HttpRequestMessage(method, path);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }

        if (etag is not null)
        {
            request.Headers.TryAddWithoutValidation("If-Match", etag);
        }

        return await client.SendAsync(request);
    }

    private static async Task<(Guid Id, string TemporaryPassword)> CreateUserAsync(HttpClient admin, string username)
    {
        var response = await admin.PostAsJsonAsync("/api/admin/users", new { username, displayName = "Pessoa", isAdmin = false });
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        return (body.GetProperty("user").GetProperty("id").GetGuid(), body.GetProperty("temporaryPassword").GetString()!);
    }

    private static async Task<Guid> CreateGroupAsync(HttpClient admin, string name)
    {
        var response = await admin.PostAsJsonAsync("/api/admin/groups", new { name });
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }
}
