using System.Text.Json;
using System.Text.Json.Nodes;

namespace Chain.Forms.Tests;

public sealed class FileFieldTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 15, 12, 0, 0, TimeSpan.Zero);
    private static readonly Guid Actor = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    private static readonly Guid FileId = Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");

    [Fact]
    public void A_file_field_with_a_narrowing_accept_list_is_valid()
    {
        var issues = FormValidator.Validate(FormDocumentParser.Parse(Document(3, ["application/pdf", "image/png"])).Document!);

        Assert.Empty(issues);
    }

    [Theory]
    [InlineData(11)]
    [InlineData(0)]
    public void Max_files_outside_1_to_10_is_FM004(int maxFiles)
    {
        var issues = FormValidator.Validate(FormDocumentParser.Parse(Document(maxFiles, ["application/pdf"])).Document!);

        Assert.Contains(issues, issue => issue.Code == "FM004");
    }

    [Fact]
    public void Accept_cannot_widen_the_global_allowlist()
    {
        var issues = FormValidator.Validate(FormDocumentParser.Parse(Document(1, ["application/zip"])).Document!);

        Assert.Contains(issues, issue => issue.Code == "FM004");
    }

    [Fact]
    public void A_file_field_is_a_list_of_file_in_the_catalog()
    {
        var stored = FormDataTypes.Stored(FormDocumentParser.Parse(Document(1, null)).Document!);

        Assert.Equal("list<file>", stored["docs"].Type.ToString());
        Assert.True(stored["docs"].Definite);
    }

    [Fact]
    public void The_server_stores_its_own_name_size_and_type()
    {
        var result = Process($$"""{"docs":[{"fileId":"{{FileId}}","name":"evil.exe","size":1}]}""");

        Assert.Empty(result.Errors);
        var stored = result.Values["docs"]![0]!;
        Assert.Equal(FileId.ToString("D"), stored["fileId"]!.GetValue<string>());
        Assert.Equal("contrato.pdf", stored["name"]!.GetValue<string>());
        Assert.Equal(1200, stored["size"]!.GetValue<long>());
        Assert.Equal("application/pdf", stored["contentType"]!.GetValue<string>());
        Assert.Equal(FileId, Assert.Single(result.FileIds));
    }

    [Fact]
    public void An_unknown_foreign_or_attached_file_is_file_invalid()
    {
        Assert.Equal("file_invalid", Process($$"""{"docs":[{"fileId":"{{Guid.NewGuid()}}"}]}""").Errors[0].Code);

        var foreign = new Dictionary<Guid, FileBinding> { [FileId] = new(Guid.NewGuid(), true, "contrato.pdf", 1200, "application/pdf") };
        Assert.Equal("file_invalid", Process($$"""{"docs":[{"fileId":"{{FileId}}"}]}""", foreign).Errors[0].Code);

        var attached = new Dictionary<Guid, FileBinding> { [FileId] = new(Actor, false, "contrato.pdf", 1200, "application/pdf") };
        Assert.Equal("file_invalid", Process($$"""{"docs":[{"fileId":"{{FileId}}"}]}""", attached).Errors[0].Code);
    }

    // Card #69 (owner decision A): a file already attached to this instance through a submission may be sent again unchanged.

    [Fact]
    public void A_file_attached_to_this_instance_can_be_sent_again_and_is_not_attached_again()
    {
        var files = new Dictionary<Guid, FileBinding> { [FileId] = new(Guid.NewGuid(), false, "contrato.pdf", 1200, "application/pdf") { AttachedToThisInstance = true } };

        var result = Process($$"""{"docs":[{"fileId":"{{FileId}}","name":"evil.exe"}]}""", files);

        Assert.Empty(result.Errors);
        var stored = Assert.Single(result.Values["docs"]!.AsArray())!;
        Assert.Equal((FileId.ToString("D"), "contrato.pdf", 1200L), (stored["fileId"]!.GetValue<string>(), stored["name"]!.GetValue<string>(), stored["size"]!.GetValue<long>()));
        Assert.Empty(result.FileIds); // FileIds are the files to attach
    }

    [Fact]
    public void Files_sent_again_and_new_files_mix_and_only_the_new_ones_are_attached()
    {
        var earlier = Guid.Parse("cccccccc-cccc-cccc-cccc-cccccccccccc");
        var files = Known();
        files[earlier] = new FileBinding(Guid.NewGuid(), false, "anterior.pdf", 10, "application/pdf") { AttachedToThisInstance = true };

        var result = Process($$"""{"docs":[{"fileId":"{{earlier}}"},{"fileId":"{{FileId}}"}]}""", files);

        Assert.Empty(result.Errors);
        Assert.Equal([earlier.ToString("D"), FileId.ToString("D")], result.Values["docs"]!.AsArray().Select(file => file!["fileId"]!.GetValue<string>()));
        Assert.Equal([FileId], result.FileIds);
    }

    [Fact]
    public void A_file_sent_again_still_follows_accept_and_is_used_once()
    {
        var files = new Dictionary<Guid, FileBinding> { [FileId] = new(Actor, false, "contrato.pdf", 1200, "application/pdf") { AttachedToThisInstance = true } };

        Assert.Equal(["file_type_not_allowed"], Process($$"""{"docs":[{"fileId":"{{FileId}}"}]}""", files, accept: ["image/png"]).Errors.Select(e => e.Code));
        Assert.Equal(["file_invalid"], Process($$"""{"docs":[{"fileId":"{{FileId}}"},{"fileId":"{{FileId}}"}]}""", files).Errors.Select(e => e.Code));
    }

    [Fact]
    public void Accept_and_count_are_enforced_per_field()
    {
        Assert.Equal("file_type_not_allowed", Process(
            $$"""{"docs":[{"fileId":"{{FileId}}"}]}""",
            accept: ["image/png"]).Errors[0].Code);

        var second = Guid.Parse("cccccccc-cccc-cccc-cccc-cccccccccccc");
        var files = Known();
        files[second] = new FileBinding(Actor, true, "outro.pdf", 10, "application/pdf");
        Assert.Equal("too_many", Process(
            $$"""{"docs":[{"fileId":"{{FileId}}"},{"fileId":"{{second}}"}]}""",
            files,
            maxFiles: 1).Errors[0].Code);
    }

    [Fact]
    public void A_required_file_field_rejects_an_empty_list()
    {
        Assert.Equal("required", Process("""{"docs":[]}""").Errors[0].Code);
        Assert.Equal("type_mismatch", Process("""{"docs":"contrato.pdf"}""").Errors[0].Code);
    }

    private static SubmissionResult Process(string json, Dictionary<Guid, FileBinding>? files = null, int? maxFiles = null, IReadOnlyList<string>? accept = null)
    {
        var form = FormDocumentParser.Parse(Document(maxFiles ?? 10, accept ?? ["application/pdf"])).Document!;
        using var document = JsonDocument.Parse(json);
        return SubmissionProcessor.Process(form, document.RootElement, SubmissionProcessor.EmptyObject, Now, TimeSpan.Zero, Actor, files ?? Known(), FileRules.MaxFiles);
    }

    private static Dictionary<Guid, FileBinding> Known() => new()
    {
        [FileId] = new(Actor, true, "contrato.pdf", 1200, "application/pdf"),
    };

    private static string Document(int? maxFiles, IReadOnlyList<string>? accept)
    {
        var validate = new JsonObject { ["required"] = true };
        if (maxFiles is { } max)
        {
            validate["maxFiles"] = max;
        }

        if (accept is not null)
        {
            validate["accept"] = new JsonArray(accept.Select(type => (JsonNode)type).ToArray());
        }

        var document = new JsonObject
        {
            ["schemaVersion"] = 1,
            ["components"] = new JsonArray
            {
                new JsonObject { ["type"] = "file", ["key"] = "docs", ["label"] = "Documentos", ["validate"] = validate },
            },
        };
        return document.ToJsonString();
    }
}
