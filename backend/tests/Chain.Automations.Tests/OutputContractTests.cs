using System.Text.Json;
using System.Text.Json.Nodes;

namespace Chain.Automations.Tests;

/// <summary>The output object built from a succeeded result (automation.md §7.2), checked against the output contract (§7.1).</summary>
public sealed class OutputContractTests
{
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    private static List<AutomationOutput> Outputs(string json) => JsonSerializer.Deserialize<List<AutomationOutput>>(json, Web)!;

    private static OutputExtraction Extract(string outputs, int status, string? body) =>
        OutputContract.Extract(Outputs(outputs), status, body is null ? null : JsonNode.Parse(body));

    [Fact]
    public void The_shared_succeeded_fixture_gives_the_declared_outputs_only()
    {
        using var request = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "contract", "work-request.json")));
        using var result = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "contract", "result-succeeded.json")));
        var document = AutomationDocumentParser.Parse(request.RootElement.GetProperty("scenario").GetProperty("automation").GetProperty("document").GetRawText()).Document!;
        var output = result.RootElement.GetProperty("output");

        var extracted = OutputContract.Extract(document.Outputs, output.GetProperty("status").GetInt32(), JsonNode.Parse(output.GetProperty("body").GetRawText()));

        Assert.Null(extracted.Problems);
        Assert.Equal("""{"situacao":"regular","httpStatus":200}""", extracted.Output!.ToJsonString()); // "score" was not declared
    }

    [Fact]
    public void Paths_read_properties_with_names_and_array_items_with_indexes()
    {
        var extracted = Extract(
            """[{"key":"nome","type":"text","source":"body","path":["itens",1,"nome"]},{"key":"primeiro","type":"object","source":"body","path":["itens",0]}]""",
            200, """{"itens":[{"nome":"a"},{"nome":"b"}]}""");

        Assert.Equal("""{"nome":"b","primeiro":{"nome":"a"}}""", extracted.Output!.ToJsonString());
    }

    [Theory]
    [InlineData("""["falta"]""", """{"itens":[]}""")] // a missing property
    [InlineData("""["itens",5]""", """{"itens":[1]}""")] // an index out of range
    [InlineData("""["itens","x"]""", """{"itens":[1]}""")] // a name on an array
    [InlineData("""["itens",0]""", """{"itens":{"0":1}}""")] // an index on an object
    [InlineData("""["itens","x"]""", """{"itens":"texto"}""")] // through a non-container
    [InlineData("""["itens"]""", null)] // no body (response type none, or an empty body)
    public void Anything_else_on_the_way_is_missing_and_optional_missing_outputs_are_left_out(string path, string? body)
    {
        var extracted = Extract($$"""[{"key":"valor","type":"unknown","source":"body","path":{{path}}}]""", 200, body);

        Assert.Null(extracted.Problems);
        Assert.Equal("{}", extracted.Output!.ToJsonString());
    }

    [Fact]
    public void Missing_required_outputs_and_wrong_types_are_reported_together_in_output_order()
    {
        var extracted = Extract(
            """
            [{"key":"situacao","type":"text","required":true,"source":"body","path":["situacao"]},
             {"key":"score","type":"number","source":"body","path":["score"]},
             {"key":"httpStatus","type":"text","required":true,"source":"status"}]
            """,
            200, """{"score":"alto"}""");

        Assert.Null(extracted.Output);
        Assert.Equal("The output 'situacao' is required. The output 'score' must be a number. The output 'httpStatus' must be text.", extracted.Problems);
    }

    // Card #154: the output object is merged into the request's data, and jsonb stores neither NUL nor an unpaired surrogate.

    [Theory]
    [InlineData("unknown", """{"situacao":"regu\u0000lar"}""")] // NUL
    [InlineData("unknown", """{"situacao":"regu\ud800lar"}""")] // an unpaired surrogate
    [InlineData("unknown", """{"situacao":{"itens":[{"no\u0000me":1}]}}""")] // in a key, at any depth
    [InlineData("text", """{"situacao":"regu\udc00lar"}""")]
    [InlineData("date", """{"situacao":"2026-10-1\ud800"}""")] // checked before the type, which reads the text
    [InlineData("unknown", """{"situacao":1,"x\ud800":2}""")] // in a name on the path, which can't be read
    public void An_output_with_text_PostgreSQL_cannot_store_is_invalid(string type, string body)
    {
        var extracted = Extract($$"""[{"key":"situacao","type":"{{type}}","required":true,"source":"body","path":["situacao"]}]""", 200, body);

        Assert.Null(extracted.Output);
        Assert.Equal("The output 'situacao' holds text that cannot be stored: the NUL character or an unpaired surrogate.", extracted.Problems);
    }

    [Fact]
    public void Text_PostgreSQL_cannot_store_outside_the_declared_outputs_is_ignored()
    {
        var extracted = Extract(
            """[{"key":"situacao","type":"text","required":true,"source":"body","path":["situacao"]}]""",
            200, """{"situacao":"regular","nota":"a\u0000b","obs":"a\ud800b"}""");

        Assert.Null(extracted.Problems);
        Assert.Equal("""{"situacao":"regular"}""", extracted.Output!.ToJsonString());
    }

    [Fact]
    public void A_status_output_is_the_final_HTTP_status()
    {
        Assert.Equal("""{"codigo":201}""", Extract("""[{"key":"codigo","type":"number","required":true,"source":"status"}]""", 201, null).Output!.ToJsonString());
    }
}
