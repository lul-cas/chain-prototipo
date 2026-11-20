using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Chain.Api.Tests.Infrastructure;
using Chain.Forms;
using Chain.Infrastructure;
using Chain.Workflows.Application.Files;
using Chain.Workflows.Files;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Chain.Api.Tests.Engine.CreditScenario;

namespace Chain.Api.Tests.Engine;

[Collection(PostgresTestGroup.Name)]
public sealed class FilesTests(PostgresFixture postgres) : IAsyncLifetime, IDisposable
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
        _s.Dispose();
        _factory.Dispose();
    }

    [Fact]
    public async Task Upload_is_pending_until_referenced_and_downloads_are_authorized()
    {
        var uploaded = await UploadAsync(_s.Ana, "contrato.pdf", Pdf());
        Assert.Equal(HttpStatusCode.Created, uploaded.StatusCode);
        var created = await uploaded.Content.ReadFromJsonAsync<JsonElement>();
        var id = created.GetProperty("id").GetGuid();
        Assert.Equal("contrato.pdf", created.GetProperty("name").GetString());
        Assert.Equal(Pdf().Length, created.GetProperty("size").GetInt64());
        Assert.Equal("application/pdf", created.GetProperty("contentType").GetString());
        Assert.Equal("not_scanned", (await _factory.QueryAsync($"SELECT scan_status FROM chain.files WHERE id = '{id}'")).Single());
        Assert.Equal("", (await _factory.QueryAsync($"SELECT coalesce(instance_id::text, '') FROM chain.files WHERE id = '{id}'")).Single());

        var pending = await _s.Ana.GetAsync($"/api/files/{id}");
        Assert.Equal(HttpStatusCode.OK, pending.StatusCode);
        Assert.Equal("application/pdf", pending.Content.Headers.ContentType!.MediaType);
        Assert.StartsWith("attachment", pending.Content.Headers.ContentDisposition!.ToString(), StringComparison.Ordinal);
        Assert.Equal("nosniff", pending.Headers.GetValues("X-Content-Type-Options").Single());
        Assert.Equal("sandbox; default-src 'none'", pending.Headers.GetValues("Content-Security-Policy").Single());
        var cache = pending.Headers.GetValues("Cache-Control").Single();
        Assert.Contains("private", cache, StringComparison.Ordinal);
        Assert.Contains("no-store", cache, StringComparison.Ordinal);
        Assert.Equal(Pdf(), await pending.Content.ReadAsByteArrayAsync());
        await (await _s.Bruno.GetAsync($"/api/files/{id}")).AssertProblemAsync(HttpStatusCode.NotFound, "not_found");

        var image = await UploadAsync(_s.Ana, "foto.png", Png());
        var imageId = (await image.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var inline = await _s.Ana.GetAsync($"/api/files/{imageId}");
        Assert.StartsWith("inline", inline.Content.Headers.ContentDisposition!.ToString(), StringComparison.Ordinal);

        var instanceId = await StartedInstanceAsync(_s.Ana, _s.DefinitionId);
        var comment = await PostAsync(_s.Ana, $"/api/instances/{instanceId}/comments", new { text = "Segue o contrato", fileIds = new[] { id } }, NewKey());
        Assert.Equal(HttpStatusCode.OK, comment.StatusCode);
        var view = await comment.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Contains(view.GetProperty("timeline").EnumerateArray(), e => e.GetProperty("type").GetString() == "comment.added");
        Assert.Contains(view.GetProperty("timeline").EnumerateArray(), e => e.GetProperty("type").GetString() == "attachment.added");
        Assert.Equal("attached", (await _factory.QueryAsync($"SELECT status FROM chain.files WHERE id = '{id}'")).Single());
        Assert.Equal(Pdf(), await (await _s.Eva.GetAsync($"/api/files/{id}")).Content.ReadAsByteArrayAsync());
        await (await _s.Fabio.GetAsync($"/api/files/{id}")).AssertProblemAsync(HttpStatusCode.NotFound, "not_found");
        await (await PostAsync(_s.Ana, $"/api/instances/{instanceId}/comments", new { text = "de novo", fileIds = new[] { id } }, NewKey()))
            .AssertProblemAsync(HttpStatusCode.UnprocessableEntity, "file_invalid");
    }

    [Fact]
    public async Task Upload_enforces_type_size_name_and_idempotency()
    {
        await (await UploadAsync(_s.Ana, "page.html", "<html>"u8.ToArray())).AssertProblemAsync(HttpStatusCode.UnsupportedMediaType, "file_type_not_allowed");
        var named = await UploadAsync(_s.Ana, "a/b.pdf", Pdf());
        Assert.Equal(HttpStatusCode.Created, named.StatusCode);
        Assert.Equal("ab.pdf", (await named.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("name").GetString());

        var hugePath = Path.GetTempFileName();
        await using (var created = new FileStream(hugePath, FileMode.Open, FileAccess.Write))
        {
            created.SetLength(FileRules.MaxBytes + 1);
        }

        await using var huge = new FileStream(hugePath, FileMode.Open, FileAccess.Read, FileShare.Read, 81920, FileOptions.DeleteOnClose);
        await (await UploadStreamAsync(_s.Ana, "big.pdf", huge)).AssertProblemAsync(HttpStatusCode.RequestEntityTooLarge, "file_too_large");

        var key = NewKey();
        var first = await UploadAsync(_s.Ana, "mesmo.pdf", Pdf(), key);
        var second = await UploadAsync(_s.Ana, "mesmo.pdf", Pdf(), key);
        Assert.Equal(HttpStatusCode.Created, second.StatusCode);
        Assert.Equal(
            (await first.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid(),
            (await second.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid());
        Assert.Equal(1, await _factory.CountAsync("SELECT count(*) FROM chain.files WHERE original_name = 'mesmo.pdf'"));
        await (await UploadAsync(_s.Ana, "mesmo.pdf", "%PDF-1.7\n%other\n"u8.ToArray(), key)).AssertProblemAsync(HttpStatusCode.UnprocessableEntity, "idempotency_key_reused");

        using var missing = new HttpRequestMessage(HttpMethod.Post, "/api/files") { Content = Form(Pdf(), "x.pdf") };
        await (await _s.Ana.SendAsync(missing)).AssertProblemAsync(HttpStatusCode.BadRequest, "idempotency_key_required");
    }

    [Fact]
    public async Task The_size_limit_is_served_as_configured_to_anyone_signed_in()
    {
        var served = await _s.Ana.GetFromJsonAsync<JsonElement>("/api/files/limits");
        Assert.Equal(FileRules.MaxBytes, served.GetProperty("maxBytes").GetInt64());
        Assert.Equal(HttpStatusCode.Unauthorized, (await _factory.CreateBrowser().GetAsync("/api/files/limits")).StatusCode);

        // A deployment with a lower limit serves it, and enforces it (ADR-0014 §4.3 and §5, card #195).
        using var configured = new ChainApiFactory(postgres.ConnectionString, settings: new Dictionary<string, string> { ["Chain:Files:MaxBytes"] = "1048576" });
        await configured.ResetDatabaseAsync();
        var admin = await configured.CreateReadyAdminAsync();
        Assert.Equal(1048576, (await admin.GetFromJsonAsync<JsonElement>("/api/files/limits")).GetProperty("maxBytes").GetInt64());
        await (await UploadAsync(admin, "grande.pdf", [.. Pdf(), .. new byte[1048576]])).AssertProblemAsync(HttpStatusCode.RequestEntityTooLarge, "file_too_large");
        Assert.Equal(HttpStatusCode.Created, (await UploadAsync(admin, "limite.pdf", [.. Pdf(), .. new byte[1048576 - Pdf().Length]])).StatusCode);
    }

    [Fact]
    public async Task Comments_follow_visibility_and_the_first_one_assigns_the_task()
    {
        var instanceId = await StartedInstanceAsync(_s.Ana, _s.DefinitionId);
        var fileId = (await (await UploadAsync(_s.Ana, "nota.txt", "olá\n"u8.ToArray())).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();

        var commented = await PostAsync(_s.Ana, $"/api/instances/{instanceId}/comments", new { text = "Comecei", fileIds = new[] { fileId } }, NewKey());
        var view = await commented.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(_s.UserIds["ana"], view.GetProperty("openTasks")[0].GetProperty("assignee").GetProperty("id").GetGuid());

        await (await PostAsync(_s.Eva, $"/api/instances/{instanceId}/comments", new { text = "vi" }, NewKey()))
            .AssertProblemAsync(HttpStatusCode.Forbidden, "forbidden");
        await (await PostAsync(_s.Fabio, $"/api/instances/{instanceId}/comments", new { text = "oi" }, NewKey()))
            .AssertProblemAsync(HttpStatusCode.NotFound, "not_found");
        var empty = await PostAsync(_s.Ana, $"/api/instances/{instanceId}/comments", new { text = "   " }, NewKey());
        await empty.AssertProblemAsync(HttpStatusCode.BadRequest, "validation_failed");
        Assert.Contains("comment_empty", await empty.Content.ReadAsStringAsync(), StringComparison.Ordinal);

        await GrantCommentToAuditoriaAsync();
        var fromEva = await PostAsync(_s.Eva, $"/api/instances/{instanceId}/comments", new { text = "Registro da auditoria" }, NewKey());
        Assert.Equal(HttpStatusCode.OK, fromEva.StatusCode);
        var evaView = await fromEva.Content.ReadFromJsonAsync<JsonElement>();
        var evaComment = evaView.GetProperty("timeline").EnumerateArray().Last(e => e.GetProperty("type").GetString() == "comment.added");
        Assert.Equal("Auditoria", evaComment.GetProperty("actedAsGroup").GetProperty("name").GetString());

        Assert.Equal(HttpStatusCode.OK, (await CloseAsync(_s.Ana, instanceId, "encerrado")).StatusCode);
        await (await PostAsync(_s.Ana, $"/api/instances/{instanceId}/comments", new { text = "tarde" }, NewKey()))
            .AssertProblemAsync(HttpStatusCode.Conflict, "instance_not_running");
    }

    // Regression #129: the timeline stores a comment's text in jsonb, which cannot store the NUL character, so this was a 500.

    [Fact]
    public async Task A_comment_with_the_NUL_character_is_invalid()
    {
        var instanceId = await StartedInstanceAsync(_s.Ana, _s.DefinitionId);

        var response = await PostAsync(_s.Ana, $"/api/instances/{instanceId}/comments", new { text = "Segue\u0000o contrato" }, NewKey());

        await response.AssertValidationFailedAsync("invalid_comment");
        Assert.Equal(0, await _factory.CountAsync($"SELECT count(*) FROM chain.instance_events WHERE instance_id = '{instanceId}' AND type = 'comment.added'"));
    }

    [Fact]
    public async Task A_file_field_stores_the_server_reference_and_attaches_the_file()
    {
        var formId = await _s.PublishFormAsync("Com anexo", new JsonObject
        {
            ["schemaVersion"] = 1,
            ["components"] = new JsonArray
            {
                new JsonObject
                {
                    ["type"] = "file", ["key"] = "docs", ["label"] = "Documentos",
                    ["validate"] = new JsonObject { ["required"] = true, ["maxFiles"] = 2, ["accept"] = new JsonArray("application/pdf") },
                },
            },
        });
        var group = await _s.GroupAsync("Envio");
        await _s.UserAsync("helena", group);
        var definitionId = await _s.PublishAsync("Pedido com arquivo", new JsonObject
        {
            ["schemaVersion"] = 1,
            ["lanes"] = new JsonArray(),
            ["nodes"] = new JsonArray
            {
                new JsonObject { ["id"] = "start", ["type"] = "start", ["label"] = "Início", ["form"] = new JsonObject { ["formId"] = formId.ToString() } },
                new JsonObject { ["id"] = "end", ["type"] = "end", ["label"] = "Fim" },
            },
            ["flows"] = new JsonArray { new JsonObject { ["id"] = "f1", ["source"] = "start", ["target"] = "end" } },
        });
        await _s.GrantAsync(definitionId, [(group, "start")]);
        var helena = _s.Browsers["helena"];
        var uploaded = await UploadAsync(helena, "contrato.pdf", Pdf());
        var fileId = (await uploaded.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var anaFile = (await (await UploadAsync(_s.Ana, "outro.pdf", Pdf())).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();

        var rejected = await StartWithDataAsync(helena, definitionId, new JsonObject { ["docs"] = new JsonArray(new JsonObject { ["fileId"] = anaFile.ToString() }) });
        await rejected.AssertProblemAsync(HttpStatusCode.UnprocessableEntity, "submission_invalid");
        Assert.Contains("file_invalid", await rejected.Content.ReadAsStringAsync());

        var started = await StartWithDataAsync(helena, definitionId, new JsonObject
        {
            ["docs"] = new JsonArray(new JsonObject { ["fileId"] = fileId.ToString(), ["name"] = "evil.exe" }),
        });
        Assert.Equal(HttpStatusCode.Created, started.StatusCode);
        var view = await started.Content.ReadFromJsonAsync<JsonElement>();
        var stored = view.GetProperty("data").GetProperty("docs")[0];
        Assert.Equal("contrato.pdf", stored.GetProperty("name").GetString());
        Assert.Equal("application/pdf", stored.GetProperty("contentType").GetString());
        Assert.Equal(Pdf().Length, stored.GetProperty("size").GetInt64());
        Assert.Equal("attached", (await _factory.QueryAsync($"SELECT status FROM chain.files WHERE id = '{fileId}'")).Single());
        Assert.Contains(view.GetProperty("timeline").EnumerateArray(), e => e.GetProperty("type").GetString() == "attachment.added");

        await (await StartWithDataAsync(helena, definitionId, new JsonObject { ["docs"] = new JsonArray(new JsonObject { ["fileId"] = fileId.ToString() }) }))
            .AssertProblemAsync(HttpStatusCode.UnprocessableEntity, "submission_invalid");
    }

    // Regression #69: a later step's prefill holds the stored files, and sending them back unchanged was refused as
    // file_invalid, because they were already attached. Owner decision, option A (2026-10-16; forms.md F4).

    [Fact]
    public async Task Prefilled_files_sent_back_unchanged_stay_bound_to_their_first_submission()
    {
        var definitionId = await PublishReviewedTwiceAsync();
        var (instanceId, contrato) = await StartedWithFileAsync(definitionId);
        var review = Id(await OpenTaskAsync(_s.Bruno, instanceId));
        var prefill = (await _s.Bruno.GetFromJsonAsync<JsonElement>($"/api/tasks/{review}")).GetProperty("prefill");
        var anexo = await UploadedIdAsync(_s.Bruno, "anexo.txt", "parecer técnico\n"u8.ToArray());
        var docs = JsonNode.Parse(prefill.GetProperty("docs").GetRawText())!.AsArray();
        docs.Add(new JsonObject { ["fileId"] = anexo.ToString() });

        var done = await CompleteAsync(_s.Bruno, review, data: new JsonObject { ["docs"] = docs, ["parecer"] = "Revisado" });

        var stored = (await SucceededAsync(done)).GetProperty("data").GetProperty("docs");
        Assert.Equal([contrato, anexo], stored.EnumerateArray().Select(file => file.GetProperty("fileId").GetGuid()));
        Assert.Equal("contrato.pdf", stored[0].GetProperty("name").GetString());
        var (start, reviewRow) = (await SubmissionIdAsync(instanceId, firstStep: true), await SubmissionIdAsync(instanceId, firstStep: false));
        Assert.Equal($"submission|{start}", await BindingAsync(contrato)); // not attached again
        Assert.Equal($"submission|{reviewRow}", await BindingAsync(anexo)); // a new file is attached as before
        Assert.Equal([contrato.ToString(), anexo.ToString()], await _factory.QueryAsync(
            $"SELECT details->>'fileId' FROM chain.instance_events WHERE instance_id = '{instanceId}' AND type = 'attachment.added' ORDER BY sequence"));
        var row = JsonNode.Parse(Assert.Single(await _factory.QueryAsync($"SELECT \"values\"::text FROM chain.instance_submissions WHERE id = '{reviewRow}'")))!;
        Assert.Equal([contrato.ToString(), anexo.ToString()], row["docs"]!.AsArray().Select(file => (string?)file!["fileId"]));
    }

    [Fact]
    public async Task An_empty_value_clears_files_sent_again_and_the_history_keeps_them()
    {
        var definitionId = await PublishReviewedTwiceAsync();
        var (instanceId, contrato) = await StartedWithFileAsync(definitionId);
        var first = Id(await OpenTaskAsync(_s.Bruno, instanceId));
        var prefill = (await _s.Bruno.GetFromJsonAsync<JsonElement>($"/api/tasks/{first}")).GetProperty("prefill");
        await SucceededAsync(await CompleteAsync(_s.Bruno, first, data: new JsonObject
        {
            ["docs"] = JsonNode.Parse(prefill.GetProperty("docs").GetRawText()), ["parecer"] = "Mantido",
        }));

        var cleared = await CompleteAsync(_s.Bruno, Id(await OpenTaskAsync(_s.Bruno, instanceId)), data: new JsonObject
        {
            ["docs"] = new JsonArray(), ["parecer"] = "Sem anexos",
        });

        Assert.False((await SucceededAsync(cleared)).GetProperty("data").TryGetProperty("docs", out _));
        Assert.Equal($"submission|{await SubmissionIdAsync(instanceId, firstStep: true)}", await BindingAsync(contrato));
        var rows = (await _factory.QueryAsync(
            $"SELECT coalesce(jsonb_typeof(\"values\"->'docs'), 'absent') || ':' || coalesce(\"values\"->'docs'->0->>'fileId', '') FROM chain.instance_submissions WHERE instance_id = '{instanceId}' ORDER BY task_id IS NOT NULL, node_id"));
        Assert.Equal([$"array:{contrato}", $"array:{contrato}", "null:"], rows); // start, review1 (sent again), review2 (cleared)
    }

    [Fact]
    public async Task Only_files_attached_to_this_instance_through_a_submission_can_be_sent_again()
    {
        var definitionId = await PublishReviewedTwiceAsync();
        var (instanceId, contrato) = await StartedWithFileAsync(definitionId);
        var (_, elsewhere) = await StartedWithFileAsync(definitionId);
        var commented = await UploadedIdAsync(_s.Ana, "nota.txt", "comentário\n"u8.ToArray());
        Assert.Equal(HttpStatusCode.OK, (await PostAsync(_s.Ana, $"/api/instances/{instanceId}/comments", new { text = "Segue", fileIds = new[] { commented } }, NewKey())).StatusCode);
        var review = Id(await OpenTaskAsync(_s.Bruno, instanceId));

        foreach (var docs in new[] { new[] { elsewhere }, new[] { commented }, new[] { contrato, contrato } })
        {
            var refused = await CompleteAsync(_s.Bruno, review, data: new JsonObject
            {
                ["docs"] = new JsonArray([.. docs.Select(id => (JsonNode)new JsonObject { ["fileId"] = id.ToString() })]), ["parecer"] = "x",
            });

            Assert.Equal(HttpStatusCode.UnprocessableEntity, refused.StatusCode);
            var problem = await refused.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("submission_invalid", problem.GetProperty("code").GetString());
            Assert.Equal(
                [("docs", "file_invalid")],
                problem.GetProperty("errors").EnumerateArray().Select(e => (e.GetProperty("key").GetString(), e.GetProperty("code").GetString())));
        }

        Assert.Equal("review1", (await OpenTaskAsync(_s.Bruno, instanceId)).GetProperty("nodeId").GetString());
    }

    [Fact]
    public async Task Concurrent_references_attach_a_pending_file_once()
    {
        var instanceA = await StartedInstanceAsync(_s.Ana, _s.DefinitionId);
        var instanceB = await StartedInstanceAsync(_s.Ana, _s.DefinitionId);
        var fileId = (await (await UploadAsync(_s.Ana, "unico.pdf", Pdf())).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var first = PostAsync(_s.Ana, $"/api/instances/{instanceA}/comments", new { text = "a", fileIds = new[] { fileId } }, NewKey());
        var second = PostAsync(_s.Ana, $"/api/instances/{instanceB}/comments", new { text = "b", fileIds = new[] { fileId } }, NewKey());
        var results = await Task.WhenAll(first, second);
        Assert.Equal(1, results.Count(response => response.StatusCode == HttpStatusCode.OK));
        Assert.Equal(1, results.Count(response => response.StatusCode == HttpStatusCode.UnprocessableEntity));
        Assert.Equal(1, await _factory.CountAsync($"SELECT count(*) FROM chain.files WHERE id = '{fileId}' AND status = 'attached'"));
    }

    [Fact]
    public async Task Pending_files_older_than_a_day_are_deleted_and_attached_files_stay()
    {
        var pending = (await (await UploadAsync(_s.Ana, "velho.txt", "x"u8.ToArray())).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var instanceId = await StartedInstanceAsync(_s.Ana, _s.DefinitionId);
        var kept = (await (await UploadAsync(_s.Ana, "fica.txt", "y"u8.ToArray())).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.OK, (await PostAsync(_s.Ana, $"/api/instances/{instanceId}/comments", new { text = "guarda", fileIds = new[] { kept } }, NewKey())).StatusCode);

        _factory.Time.Advance(TimeSpan.FromHours(24) + TimeSpan.FromSeconds(1));
        await using var scope = _factory.Services.CreateAsyncScope();
        var removed = await scope.ServiceProvider.GetRequiredService<FileService>().PurgePendingAsync(CancellationToken.None);

        Assert.True(removed >= 1);
        Assert.Equal(HttpStatusCode.NoContent, (await _s.Ana.LoginAsync("ana", Password)).StatusCode);
        await (await _s.Ana.GetAsync($"/api/files/{pending}")).AssertProblemAsync(HttpStatusCode.NotFound, "not_found");
        Assert.Equal(HttpStatusCode.OK, (await _s.Ana.GetAsync($"/api/files/{kept}")).StatusCode);
        Assert.Equal(0, await _factory.CountAsync($"SELECT count(*) FROM chain.file_contents WHERE file_id = '{pending}'"));
    }

    [Fact]
    public async Task A_bot_can_upload_with_a_bearer_token()
    {
        var bot = await CreateBotAsync();
        using var client = _factory.CreateClient(new() { BaseAddress = new Uri("https://localhost") });
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", bot);
        var uploaded = await UploadAsync(client, "bot.txt", "via api\n"u8.ToArray());
        Assert.Equal(HttpStatusCode.Created, uploaded.StatusCode);
    }

    [Fact]
    public async Task Streaming_a_25mb_file_stays_under_5mb_allocated()
    {
        var userId = Guid.Parse((await _factory.QueryAsync("SELECT id FROM chain.users LIMIT 1")).Single());
        var path = Path.GetTempFileName();
        try
        {
            await using (var created = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                var buffer = new byte[81920];
                long left = FileRules.MaxBytes;
                while (left > 0)
                {
                    var count = (int)Math.Min(buffer.Length, left);
                    await created.WriteAsync(buffer.AsMemory(0, count));
                    left -= count;
                }
            }

            await using var scope = _factory.Services.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<ChainDbContext>();
            var store = scope.ServiceProvider.GetRequiredService<IFileContentStore>();
            await using var transaction = await db.Database.BeginTransactionAsync();
            var warm = StoredFile.Pending(userId, "warm.bin", "application/octet-stream", 1, new string('a', 64), _factory.Time.GetUtcNow());
            db.Files.Add(warm);
            await db.SaveChangesAsync();
            await using (var tiny = new MemoryStream([1]))
            {
                await store.WriteAsync(warm.Id, tiny, CancellationToken.None);
                await using var sink = new MemoryStream();
                await store.CopyToAsync(warm.Id, sink, CancellationToken.None);
            }

            var file = StoredFile.Pending(userId, "blob.bin", "application/octet-stream", FileRules.MaxBytes, new string('b', 64), _factory.Time.GetUtcNow());
            db.Files.Add(file);
            await db.SaveChangesAsync();
            await using var source = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            var beforeWrite = GC.GetTotalAllocatedBytes(true);
            await store.WriteAsync(file.Id, source, CancellationToken.None);
            var writeAllocated = GC.GetTotalAllocatedBytes(true) - beforeWrite;

            var output = Path.GetTempFileName();
            try
            {
                await using var destination = new FileStream(output, FileMode.Create, FileAccess.Write, FileShare.None);
                var beforeRead = GC.GetTotalAllocatedBytes(true);
                await store.CopyToAsync(file.Id, destination, CancellationToken.None);
                var readAllocated = GC.GetTotalAllocatedBytes(true) - beforeRead;
                Assert.True(writeAllocated < 5 * 1024 * 1024, $"write allocated {writeAllocated}");
                Assert.True(readAllocated < 5 * 1024 * 1024, $"read allocated {readAllocated}");
            }
            finally
            {
                File.Delete(output);
            }

            await transaction.CommitAsync();
        }
        finally
        {
            File.Delete(path);
        }
    }

    private async Task GrantCommentToAuditoriaAsync()
    {
        var current = await _s.Admin.GetFromJsonAsync<JsonElement>($"/api/workflows/{_s.DefinitionId}/grants");
        var body = current.EnumerateArray().Select(grant => new
        {
            groupId = grant.GetProperty("groupId").GetGuid(),
            capabilities = grant.GetProperty("groupName").GetString() == "Auditoria"
                ? grant.GetProperty("capabilities").EnumerateArray().Select(item => item.GetString()).Append("comment").Distinct().ToArray()
                : grant.GetProperty("capabilities").EnumerateArray().Select(item => item.GetString()).ToArray(),
        }).ToArray();
        var etag = (await _s.Admin.GetAsync($"/api/workflows/{_s.DefinitionId}")).Headers.ETag!.Tag;
        using var request = new HttpRequestMessage(HttpMethod.Put, $"/api/workflows/{_s.DefinitionId}/grants") { Content = JsonContent.Create(body) };
        request.Headers.TryAddWithoutValidation("If-Match", etag);
        var response = await _s.Admin.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    /// <summary>
    /// start (Envio: required <c>docs</c>) → review1 → review2 (both Analistas, Revisão: optional <c>docs</c> and <c>parecer</c>)
    /// → end. Ana's group may start it.
    /// </summary>
    private async Task<Guid> PublishReviewedTwiceAsync()
    {
        static JsonObject Docs(bool required) => new()
        {
            ["type"] = "file", ["key"] = "docs", ["label"] = "Documentos", ["validate"] = new JsonObject { ["required"] = required, ["maxFiles"] = 3 },
        };

        var envio = await _s.PublishFormAsync("Envio", new JsonObject { ["schemaVersion"] = 1, ["components"] = new JsonArray(Docs(required: true)) });
        var revisao = await _s.PublishFormAsync("Revisão", new JsonObject
        {
            ["schemaVersion"] = 1,
            ["components"] = new JsonArray(Docs(required: false), new JsonObject { ["type"] = "text", ["key"] = "parecer", ["label"] = "Parecer" }),
        });
        JsonObject Review(string id) => new()
        {
            ["id"] = id, ["type"] = "task", ["taskKind"] = "human", ["label"] = id, ["laneId"] = "lane_an",
            ["form"] = new JsonObject { ["formId"] = revisao.ToString() },
        };

        var definitionId = await _s.PublishAsync("Revisão de documentos", new JsonObject
        {
            ["schemaVersion"] = 1,
            ["lanes"] = new JsonArray
            {
                new JsonObject { ["id"] = "lane_an", ["title"] = "Análise", ["group"] = new JsonObject { ["kind"] = "group", ["groupId"] = _s.Analistas.ToString() } },
            },
            ["nodes"] = new JsonArray
            {
                new JsonObject { ["id"] = "start", ["type"] = "start", ["label"] = "Início", ["form"] = new JsonObject { ["formId"] = envio.ToString() } },
                Review("review1"),
                Review("review2"),
                new JsonObject { ["id"] = "end", ["type"] = "end", ["label"] = "Fim" },
            },
            ["flows"] = new JsonArray
            {
                new JsonObject { ["id"] = "f1", ["source"] = "start", ["target"] = "review1" },
                new JsonObject { ["id"] = "f2", ["source"] = "review1", ["target"] = "review2" },
                new JsonObject { ["id"] = "f3", ["source"] = "review2", ["target"] = "end" },
            },
        });
        var comercial = Id(Assert.Single((await _s.Ana.GetFromJsonAsync<JsonElement>("/api/auth/me")).GetProperty("groups").EnumerateArray()));
        await _s.GrantAsync(definitionId, [(comercial, "start")]);
        return definitionId;
    }

    /// <summary>Ana uploads contrato.pdf and starts <paramref name="definitionId"/> with it in <c>docs</c>.</summary>
    private async Task<(Guid InstanceId, Guid FileId)> StartedWithFileAsync(Guid definitionId)
    {
        var fileId = await UploadedIdAsync(_s.Ana, "contrato.pdf", Pdf());
        var started = await StartWithDataAsync(_s.Ana, definitionId, new JsonObject { ["docs"] = new JsonArray(new JsonObject { ["fileId"] = fileId.ToString() }) });
        Assert.Equal(HttpStatusCode.Created, started.StatusCode);
        return (Id(await started.Content.ReadFromJsonAsync<JsonElement>()), fileId);
    }

    private static async Task<Guid> UploadedIdAsync(HttpClient client, string name, byte[] content)
    {
        var uploaded = await UploadAsync(client, name, content);
        Assert.Equal(HttpStatusCode.Created, uploaded.StatusCode);
        return (await uploaded.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    /// <summary>Asserts a 200 and returns its body; a failure shows the body, such as a 422's field errors.</summary>
    private static async Task<JsonElement> SucceededAsync(HttpResponseMessage response)
    {
        var body = await response.Content.ReadAsStringAsync();
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"{(int)response.StatusCode}: {body}");
        return JsonDocument.Parse(body).RootElement.Clone();
    }

    /// <summary>The submission a file is bound to, as <c>kind|id</c>.</summary>
    private async Task<string> BindingAsync(Guid fileId) =>
        Assert.Single(await _factory.QueryAsync($"SELECT attached_to_kind || '|' || attached_to_id FROM chain.files WHERE id = '{fileId}' AND status = 'attached'"));

    /// <summary>The id of the start form's submission, or of the only task submission.</summary>
    private async Task<string> SubmissionIdAsync(Guid instanceId, bool firstStep) =>
        Assert.Single(await _factory.QueryAsync(
            $"SELECT id FROM chain.instance_submissions WHERE instance_id = '{instanceId}' AND task_id IS {(firstStep ? "" : "NOT ")}NULL"));

    private async Task<string> CreateBotAsync()
    {
        var bot = await _s.Admin.PostAsJsonAsync("/api/admin/bots", new { name = "integracao", displayName = "Robô" });
        var botId = (await bot.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var token = await _s.Admin.PostAsJsonAsync($"/api/admin/bots/{botId}/tokens", new { label = "api" });
        return (await token.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("value").GetString()!;
    }

    private static async Task<HttpResponseMessage> UploadAsync(HttpClient client, string name, byte[] content, string? key = null)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/files") { Content = Form(content, name) };
        request.Headers.Add("Idempotency-Key", key ?? NewKey());
        return await client.SendAsync(request);
    }

    private static async Task<HttpResponseMessage> UploadStreamAsync(HttpClient client, string name, Stream content)
    {
        using var form = new MultipartFormDataContent();
        form.Add(new StreamContent(content), "file", name);
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/files") { Content = form };
        request.Headers.Add("Idempotency-Key", NewKey());
        return await client.SendAsync(request);
    }

    private static MultipartFormDataContent Form(byte[] content, string name)
    {
        var form = new MultipartFormDataContent();
        form.Add(new ByteArrayContent(content), "file", name);
        return form;
    }

    private static byte[] Pdf() => "%PDF-1.7\n"u8.ToArray();

    private static byte[] Png() => [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
}
