using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Chain.Api.Tests.Infrastructure;

namespace Chain.Api.Tests.Forms;

/// <summary>Acceptance criteria of forms increment F1 (forms.md §F1).</summary>
[Collection(PostgresTestGroup.Name)]
public sealed class FormsTests(PostgresFixture postgres) : IAsyncLifetime, IDisposable
{
    private readonly ChainApiFactory _factory = new(postgres.ConnectionString);
    private HttpClient _admin = null!;

    public async Task InitializeAsync()
    {
        await _factory.ResetDatabaseAsync();
        _admin = await _factory.CreateReadyAdminAsync();
    }

    public Task DisposeAsync() => Task.CompletedTask;

    public void Dispose()
    {
        _admin?.Dispose();
        _factory.Dispose();
    }

    // 1. Lifecycle

    [Fact]
    public async Task Forms_are_drafted_validated_and_published_as_immutable_versions()
    {
        var id = await CreateAsync("Proposta de Crédito");
        Assert.Equal(HttpStatusCode.OK, (await SaveDraftAsync(id, Form("Nome"))).StatusCode);

        var report = await (await _admin.PostAsync($"/api/forms/{id}/validate", null)).Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(report.GetProperty("valid").GetBoolean());

        var first = await PublishAsync(id);
        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        Assert.Equal(1, (await first.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("versionNumber").GetInt32());

        var unchanged = await PublishAsync(id);
        Assert.Equal(HttpStatusCode.OK, unchanged.StatusCode);

        await SaveDraftAsync(id, Form("Nome completo"));
        Assert.Equal(2, (await (await PublishAsync(id)).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("versionNumber").GetInt32());

        var v1 = await _admin.GetFromJsonAsync<JsonElement>($"/api/forms/{id}/versions/1");
        Assert.Equal("Nome", v1.GetProperty("document").GetProperty("components")[0].GetProperty("label").GetString());
        Assert.Equal(2, (await _admin.GetFromJsonAsync<JsonElement>($"/api/forms/{id}/versions")).GetArrayLength());

        var update = await Assert.ThrowsAnyAsync<Exception>(() => _factory.QueryAsync("UPDATE chain.form_versions SET content_hash = 'x' RETURNING id"));
        Assert.Contains("append-only", update.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Malformed_drafts_are_rejected_and_invalid_forms_cannot_be_published()
    {
        var id = await CreateAsync("Inválido");
        var malformed = Form("Nome");
        malformed["components"]![0]!["type"] = "signature";
        await (await SaveDraftAsync(id, malformed)).AssertProblemAsync(HttpStatusCode.BadRequest, "invalid_document");

        var keyless = Form("Nome");
        keyless["components"]![0]!.AsObject().Remove("key");
        Assert.Equal(HttpStatusCode.OK, (await SaveDraftAsync(id, keyless)).StatusCode);

        var publish = await PublishAsync(id);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, publish.StatusCode);
        var problem = await publish.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("form_validation_failed", problem.GetProperty("code").GetString());
        Assert.Contains(problem.GetProperty("errors").EnumerateArray(), e => e.GetProperty("code").GetString() == "FM001");
    }

    // Regression #93: these two were 500s. A body without "document" made GetRawText throw on the undefined element, and
    // PostgreSQL jsonb cannot store the NUL character, so saving one failed in the database.

    [Fact]
    public async Task A_draft_without_a_document_is_an_invalid_document()
    {
        var id = await CreateAsync("Sem documento");

        var missing = await SendAsync(HttpMethod.Put, $"/api/forms/{id}/draft", new { }, await ETagAsync(id));
        var nulled = await SendAsync(HttpMethod.Put, $"/api/forms/{id}/draft", new { document = (object?)null }, await ETagAsync(id));

        Assert.Equal("FM000", await SingleIssueAsync(missing));
        Assert.Equal("FM000", await SingleIssueAsync(nulled));
    }

    [Fact]
    public async Task A_draft_with_the_NUL_character_is_an_invalid_document()
    {
        var id = await CreateAsync("Com NUL");

        var response = await SaveDraftAsync(id, Form("Nome\u0000completo"));

        Assert.Equal("FM000", await SingleIssueAsync(response));
        var draft = (await _admin.GetFromJsonAsync<JsonElement>($"/api/forms/{id}")).GetProperty("draft");
        Assert.Equal(0, draft.GetProperty("components").GetArrayLength()); // the empty draft is kept
    }

    // Regression #129: PostgreSQL cannot store the NUL character in text, nor an unpaired surrogate in jsonb, so these were 500s.
    // A serializer writes a lone surrogate as U+FFFD, so the escape is sent as JSON text written by hand.

    [Fact]
    public async Task A_name_or_description_with_the_NUL_character_is_invalid()
    {
        var id = await CreateAsync("Proposta");

        await (await _admin.PostAsJsonAsync("/api/forms", new { name = "Cadastro\u0000" })).AssertValidationFailedAsync("invalid_name");
        await (await _admin.PostAsJsonAsync("/api/forms", new { name = "Cadastro", description = "Dados\u0000" })).AssertValidationFailedAsync("invalid_description");
        await (await SendAsync(HttpMethod.Patch, $"/api/forms/{id}", new { name = "Proposta\u0000" }, await ETagAsync(id))).AssertValidationFailedAsync("invalid_name");
        await (await SendAsync(HttpMethod.Patch, $"/api/forms/{id}", new { description = "\u0000" }, await ETagAsync(id))).AssertValidationFailedAsync("invalid_description");

        Assert.Equal(["Proposta"], await _factory.QueryAsync("SELECT name FROM chain.form_definitions"));
    }

    [Fact]
    public async Task A_draft_with_an_unpaired_surrogate_is_an_invalid_document()
    {
        var id = await CreateAsync("Com surrogate");
        using var request = new HttpRequestMessage(HttpMethod.Put, $"/api/forms/{id}/draft")
        {
            Content = ApiTestSession.RawJson("""{"document":{"schemaVersion":1,"components":[{"type":"text","key":"x","label":"X","visibleWhen":{"kind":"compare","left":{"kind":"path","path":["y"]},"operator":"equals","right":{"kind":"literal","type":"text","value":"\ud800"}}}]}}"""),
        };
        request.Headers.TryAddWithoutValidation("If-Match", await ETagAsync(id));

        var response = await _admin.SendAsync(request);

        Assert.Equal("FM000", await SingleIssueAsync(response));
        var draft = (await _admin.GetFromJsonAsync<JsonElement>($"/api/forms/{id}")).GetProperty("draft");
        Assert.Equal(0, draft.GetProperty("components").GetArrayLength()); // the empty draft is kept
    }

    [Fact]
    public async Task Validating_a_sample_with_an_unpaired_surrogate_reports_an_invalid_value()
    {
        var id = await CreateAsync("Amostra");
        await SaveDraftAsync(id, Form("Nome"));
        Assert.Equal(HttpStatusCode.Created, (await PublishAsync(id)).StatusCode);

        var response = await _admin.PostAsync($"/api/forms/{id}/versions/1/validate-submission", ApiTestSession.RawJson("""{"campo":"Ana\ud800"}"""));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var report = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.False(report.GetProperty("valid").GetBoolean());
        var error = Assert.Single(report.GetProperty("errors").EnumerateArray());
        Assert.Equal((string.Empty, "invalid_value"), (error.GetProperty("key").GetString(), error.GetProperty("code").GetString()));
    }

    // Regression #153: System.Text.Json keeps bytes that are not UTF-8 in a JsonElement and throws only when its text is read, so
    // GetRawText made these 500s. A body that isn't UTF-8 is not JSON, so it gets the malformed-JSON answer (identity.md I1).

    [Fact]
    public async Task A_draft_whose_bytes_are_not_UTF8_is_malformed_json()
    {
        var id = await CreateAsync("Bytes");
        using var request = new HttpRequestMessage(HttpMethod.Put, $"/api/forms/{id}/draft")
        {
            Content = ApiTestSession.NotUtf8Json("""{"document":{"schemaVersion":1,"components":[{"type":"text","key":"x","label":"NOT_UTF8"}]}}"""),
        };
        request.Headers.TryAddWithoutValidation("If-Match", await ETagAsync(id));

        var response = await _admin.SendAsync(request);

        await response.AssertMalformedJsonAsync(_admin, HttpMethod.Put, $"/api/forms/{id}/draft");
        var draft = (await _admin.GetFromJsonAsync<JsonElement>($"/api/forms/{id}")).GetProperty("draft");
        Assert.Equal(0, draft.GetProperty("components").GetArrayLength()); // the empty draft is kept
    }

    [Fact]
    public async Task Validating_a_sample_whose_bytes_are_not_UTF8_is_malformed_json()
    {
        var id = await CreateAsync("Amostra");
        await SaveDraftAsync(id, Form("Nome"));
        Assert.Equal(HttpStatusCode.Created, (await PublishAsync(id)).StatusCode);
        var path = $"/api/forms/{id}/versions/1/validate-submission";

        var response = await _admin.PostAsync(path, ApiTestSession.NotUtf8Json("""{"campo":"AnaNOT_UTF8"}"""));

        await response.AssertMalformedJsonAsync(_admin, HttpMethod.Post, path);
    }

    [Fact]
    public async Task Restore_copies_a_version_into_the_draft()
    {
        var id = await CreateAsync("Restaurável");
        await SaveDraftAsync(id, Form("Original"));
        await PublishAsync(id);
        await SaveDraftAsync(id, Form("Alterado"));

        var restore = await SendAsync(HttpMethod.Post, $"/api/forms/{id}/versions/1/restore", null, await ETagAsync(id));

        Assert.Equal(HttpStatusCode.OK, restore.StatusCode);
        var draft = (await _admin.GetFromJsonAsync<JsonElement>($"/api/forms/{id}")).GetProperty("draft");
        Assert.Equal("Original", draft.GetProperty("components")[0].GetProperty("label").GetString());
    }

    [Fact]
    public async Task Names_are_unique_and_versions_are_required()
    {
        var id = await CreateAsync("Proposta");
        await (await _admin.PostAsJsonAsync("/api/forms", new { name = "PROPOSTA" })).AssertProblemAsync(HttpStatusCode.Conflict, "form_name_taken");

        await (await SendAsync(HttpMethod.Put, $"/api/forms/{id}/draft", new { document = Form("x") }, etag: null))
            .AssertProblemAsync(HttpStatusCode.PreconditionRequired, "precondition_required");
        var stale = await ETagAsync(id);
        await SaveDraftAsync(id, Form("Nome"));
        await (await SendAsync(HttpMethod.Post, $"/api/forms/{id}/publish", null, stale)).AssertProblemAsync(HttpStatusCode.PreconditionFailed, "version_mismatch");
    }

    // 2. Test a submission

    [Fact]
    public async Task Submissions_can_be_tested_against_a_version()
    {
        var id = await CreateAsync("Cadastro");
        var form = Form("CPF");
        form["components"]![0]!["validate"] = new JsonObject { ["required"] = true, ["format"] = "cpf" };
        await SaveDraftAsync(id, form);
        await PublishAsync(id);

        var valid = await _admin.PostAsJsonAsync($"/api/forms/{id}/versions/1/validate-submission", new { campo = "529.982.247-25" });
        var invalid = await _admin.PostAsJsonAsync($"/api/forms/{id}/versions/1/validate-submission", new { campo = "529.982.247-24", extra = 1 });

        Assert.True((await valid.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("valid").GetBoolean());
        var report = await invalid.Content.ReadFromJsonAsync<JsonElement>();
        Assert.False(report.GetProperty("valid").GetBoolean());
        var errors = report.GetProperty("errors").EnumerateArray().Select(e => (e.GetProperty("key").GetString(), e.GetProperty("code").GetString())).ToList();
        Assert.Contains(("campo", "invalid_format"), errors);
        Assert.Contains(("extra", "unknown_field"), errors);
    }

    [Fact]
    public async Task Test_submissions_return_the_values_to_store_with_computed_fields()
    {
        var id = await CreateAsync("Calculadora");
        var form = new JsonObject
        {
            ["schemaVersion"] = 1,
            ["components"] = new JsonArray
            {
                new JsonObject { ["type"] = "number", ["key"] = "valor", ["label"] = "Valor" },
                new JsonObject { ["type"] = "number", ["key"] = "parcelas", ["label"] = "Parcelas" },
                new JsonObject
                {
                    ["type"] = "computed", ["key"] = "parcela", ["label"] = "Parcela",
                    ["expression"] = new JsonObject
                    {
                        ["kind"] = "call", ["function"] = "round",
                        ["args"] = new JsonArray(
                            new JsonObject { ["kind"] = "arithmetic", ["op"] = "divide", ["left"] = new JsonObject { ["kind"] = "path", ["path"] = new JsonArray("valor") }, ["right"] = new JsonObject { ["kind"] = "path", ["path"] = new JsonArray("parcelas") } },
                            new JsonObject { ["kind"] = "literal", ["type"] = "number", ["value"] = "2" }),
                    },
                },
            },
        };
        await SaveDraftAsync(id, form);
        await PublishAsync(id);

        var report = await (await _admin.PostAsJsonAsync($"/api/forms/{id}/versions/1/validate-submission", new { valor = 1000, parcelas = 3, parcela = 1 }))
            .Content.ReadFromJsonAsync<JsonElement>();

        Assert.True(report.GetProperty("valid").GetBoolean());
        Assert.Equal(333.33m, report.GetProperty("values").GetProperty("parcela").GetDecimal());
    }

    // 3. Access

    [Fact]
    public async Task Only_modelers_and_admins_can_use_forms()
    {
        var created = await _admin.PostAsJsonAsync("/api/admin/users", new { username = "ana", displayName = "Ana", isAdmin = false });
        var temporary = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("temporaryPassword").GetString()!;
        using var ana = await _factory.CreateReadyUserAsync("ana", temporary, "ana-own-passphrase");
        using var anonymous = _factory.CreateBrowser();

        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/forms")).StatusCode);
        await (await ana.GetAsync("/api/forms")).AssertProblemAsync(HttpStatusCode.Forbidden, "forbidden");
        await (await ana.PostAsJsonAsync("/api/forms", new { name = "x" })).AssertProblemAsync(HttpStatusCode.Forbidden, "forbidden");
    }

    // 4. Workflows pin forms

    [Fact]
    public async Task Workflows_pin_published_form_versions()
    {
        var formId = await CreateAsync("Proposta");
        await SaveDraftAsync(formId, Form("Nome"));
        await PublishAsync(formId);
        var workflowId = await CreateWorkflowAsync("Concessão", WorkflowUsingForm(formId.ToString()));

        Assert.Equal(HttpStatusCode.Created, (await PublishWorkflowAsync(workflowId)).StatusCode);
        await SaveDraftAsync(formId, Form("Nome completo"));
        await PublishAsync(formId);

        var version = await _admin.GetFromJsonAsync<JsonElement>($"/api/workflows/{workflowId}/versions/1");
        var form = version.GetProperty("document").GetProperty("nodes")[1].GetProperty("form");
        Assert.Equal(formId.ToString(), form.GetProperty("formId").GetString());
        Assert.Equal(1, form.GetProperty("version").GetInt32());
    }

    [Fact]
    public async Task Workflows_reject_unknown_and_unpublished_forms()
    {
        var unpublished = await CreateAsync("Rascunho");
        var unknownForm = await CreateWorkflowAsync("Formulário inexistente", WorkflowUsingForm(Guid.NewGuid().ToString()));
        var draftForm = await CreateWorkflowAsync("Formulário sem versão", WorkflowUsingForm(unpublished.ToString()));

        foreach (var workflow in new[] { unknownForm, draftForm })
        {
            var response = await PublishWorkflowAsync(workflow);
            Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
            var errors = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("errors").EnumerateArray();
            Assert.Contains(errors, e => e.GetProperty("code").GetString() == "WF103" && e.GetProperty("elementId").GetString() == "task_1");
        }
    }

    [Fact]
    public async Task Form_changes_are_audited()
    {
        var id = await CreateAsync("Auditado");
        await SaveDraftAsync(id, Form("Nome"));
        await PublishAsync(id);

        var actions = await _factory.QueryAsync($"SELECT action FROM chain.audit_events WHERE subject_id = '{id}'");

        Assert.Equal(["form.created", "form.draft_saved", "form.published"], actions.Order(StringComparer.Ordinal));
    }

    // Helpers

    private static JsonObject Form(string label) => new()
    {
        ["schemaVersion"] = 1,
        ["components"] = new JsonArray { new JsonObject { ["type"] = "text", ["key"] = "campo", ["label"] = label } },
    };

    private static JsonObject WorkflowUsingForm(string formId) => new()
    {
        ["schemaVersion"] = 1,
        ["lanes"] = new JsonArray(),
        ["nodes"] = new JsonArray
        {
            new JsonObject { ["id"] = "start_1", ["type"] = "start", ["label"] = "Início" },
            new JsonObject { ["id"] = "task_1", ["type"] = "task", ["taskKind"] = "human", ["label"] = "Preencher", ["form"] = new JsonObject { ["formId"] = formId } },
            new JsonObject { ["id"] = "end_1", ["type"] = "end", ["label"] = "Fim" },
        },
        ["flows"] = new JsonArray
        {
            new JsonObject { ["id"] = "f1", ["source"] = "start_1", ["target"] = "task_1" },
            new JsonObject { ["id"] = "f2", ["source"] = "task_1", ["target"] = "end_1" },
        },
    };

    private async Task<Guid> CreateAsync(string name)
    {
        var response = await _admin.PostAsJsonAsync("/api/forms", new { name });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    private async Task<string> ETagAsync(Guid id, string resource = "forms") =>
        (await _admin.GetAsync($"/api/{resource}/{id}")).Headers.ETag!.Tag;

    private async Task<HttpResponseMessage> SaveDraftAsync(Guid id, JsonObject document) =>
        await SendAsync(HttpMethod.Put, $"/api/forms/{id}/draft", new { document }, await ETagAsync(id));

    private async Task<HttpResponseMessage> PublishAsync(Guid id) =>
        await SendAsync(HttpMethod.Post, $"/api/forms/{id}/publish", null, await ETagAsync(id));

    /// <summary>Asserts a 400 <c>invalid_document</c> and returns the code of its single error.</summary>
    private static async Task<string?> SingleIssueAsync(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("invalid_document", problem.GetProperty("code").GetString());
        return Assert.Single(problem.GetProperty("errors").EnumerateArray()).GetProperty("code").GetString();
    }

    private async Task<Guid> CreateWorkflowAsync(string name, JsonObject document)
    {
        var created = await _admin.PostAsJsonAsync("/api/workflows", new { name });
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        await SendAsync(HttpMethod.Put, $"/api/workflows/{id}/draft", new { document }, await ETagAsync(id, "workflows"));
        return id;
    }

    private async Task<HttpResponseMessage> PublishWorkflowAsync(Guid id) =>
        await SendAsync(HttpMethod.Post, $"/api/workflows/{id}/publish", null, await ETagAsync(id, "workflows"));

    private async Task<HttpResponseMessage> SendAsync(HttpMethod method, string path, object? body, string? etag)
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

        return await _admin.SendAsync(request);
    }
}
