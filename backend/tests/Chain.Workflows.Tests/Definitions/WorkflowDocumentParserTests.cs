using System.Text.Json.Nodes;
using Chain.Workflows.Definitions;

namespace Chain.Workflows.Tests.Definitions;

public sealed class WorkflowDocumentParserTests
{
    [Fact]
    public void Parses_a_valid_document()
    {
        var result = WorkflowDocumentParser.Parse(SampleWorkflow.Create().ToJsonString());

        Assert.True(result.IsSuccess);
        var document = result.Document!;
        Assert.Equal(1, document.SchemaVersion);
        Assert.Equal(2, document.Lanes.Count);
        Assert.Equal(LaneGroupKind.Group, document.Lanes[1].Group.Kind);
        Assert.Equal(Guid.Parse(SampleWorkflow.AnalystGroupId), document.Lanes[1].Group.GroupId);
        Assert.Equal(4, document.Nodes.Count);
        Assert.Equal(TaskKind.Human, document.Nodes[1].TaskKind);
        Assert.Equal("analise", document.Nodes[1].Form!.FormId);
        Assert.Equal(DecisionMode.Human, document.Nodes[2].DecisionMode);
        Assert.Equal(Branch.False, document.Flows[3].Branch);
        Assert.Null(document.Flows[0].Branch);
    }

    [Theory]
    [InlineData("")]
    [InlineData("null")]
    [InlineData("not json")]
    [InlineData("[]")]
    [InlineData("{\"schemaVersion\": 1, \"lanes\": [], \"nodes\": [")]
    public void Rejects_malformed_json_with_WF000(string json)
    {
        AssertRejected(json);
    }

    [Fact]
    public void Rejects_unsupported_schema_version()
    {
        var document = SampleWorkflow.Create();
        document["schemaVersion"] = 2;

        AssertRejected(document.ToJsonString());
    }

    [Fact]
    public void Rejects_unknown_node_type()
    {
        var document = SampleWorkflow.Create();
        SampleWorkflow.Node(document, "task_1")["type"] = "parallelGateway";

        AssertRejected(document.ToJsonString());
    }

    [Fact]
    public void Rejects_missing_required_field()
    {
        var document = SampleWorkflow.Create();
        SampleWorkflow.FlowById(document, "f_1").Remove("target");

        AssertRejected(document.ToJsonString());
    }

    [Fact]
    public void Rejects_null_collections()
    {
        var document = SampleWorkflow.Create();
        document["nodes"] = null;

        AssertRejected(document.ToJsonString());
    }

    [Fact]
    public void Rejects_unknown_properties()
    {
        var document = SampleWorkflow.Create();
        SampleWorkflow.Node(document, "task_1")["script"] = "alert(1)";

        AssertRejected(document.ToJsonString());
    }

    [Fact]
    public void Rejects_numeric_enum_values()
    {
        var document = SampleWorkflow.Create();
        SampleWorkflow.Node(document, "task_1")["type"] = 1;

        AssertRejected(document.ToJsonString());
    }

    [Fact]
    public void Rejects_invalid_group_id()
    {
        var document = SampleWorkflow.Create();
        document["lanes"]![1]!["group"]!["groupId"] = "not-a-guid";

        AssertRejected(document.ToJsonString());
    }

    // Regression #93: PostgreSQL jsonb cannot store the NUL character, so a draft with one failed when it was saved.

    [Fact]
    public void Rejects_the_NUL_character_in_text()
    {
        var document = SampleWorkflow.Create();
        SampleWorkflow.Node(document, "task_1")["label"] = "Analisar\u0000documentos";

        AssertRejected(document.ToJsonString());
    }

    [Fact]
    public void Rejects_the_NUL_character_in_free_form_json()
    {
        var document = SampleWorkflow.Create();
        SampleWorkflow.Node(document, "task_1")["layout"] = new JsonObject { ["x"] = 10, ["y"] = 20, ["nota\u0000"] = 1 };

        AssertRejected(document.ToJsonString());
    }

    [Fact]
    public void An_escaped_backslash_before_u0000_is_text_not_NUL()
    {
        var document = SampleWorkflow.Create();
        SampleWorkflow.Node(document, "task_1")["label"] = "\\u0000";

        var result = WorkflowDocumentParser.Parse(document.ToJsonString());

        Assert.True(result.IsSuccess, result.Error?.Message);
        Assert.Equal("\\u0000", result.Document!.Nodes[1].Label);
    }

    // Regression #129: PostgreSQL jsonb cannot store an unpaired surrogate, so a draft with one failed when it was saved. A
    // serializer writes a lone surrogate as U+FFFD, so the escape is put into the JSON text by hand.

    [Theory]
    [InlineData("\\ud800")]
    [InlineData("\\udc00")]
    [InlineData("\\ud83d\\ud83d")]
    [InlineData("\\ude00\\ud83d")]
    public void Rejects_an_unpaired_surrogate_in_free_form_json(string escape)
    {
        var document = SampleWorkflow.Create();
        SampleWorkflow.Node(document, "task_1")["layout"] = new JsonObject { ["x"] = 10, ["y"] = 20, ["nota"] = "UNPAIRED" };

        AssertRejected(document.ToJsonString().Replace("UNPAIRED", escape, StringComparison.Ordinal));
    }

    [Fact]
    public void An_escaped_surrogate_pair_is_text()
    {
        var document = SampleWorkflow.Create();
        SampleWorkflow.Node(document, "task_1")["label"] = "PAIR";

        var result = WorkflowDocumentParser.Parse(document.ToJsonString().Replace("PAIR", "Analisar \\ud83d\\ude00", StringComparison.Ordinal));

        Assert.True(result.IsSuccess, result.Error?.Message);
        Assert.Equal("Analisar 😀", result.Document!.Nodes[1].Label);
    }

    private static void AssertRejected(string json)
    {
        var result = WorkflowDocumentParser.Parse(json);

        Assert.False(result.IsSuccess);
        Assert.Null(result.Document);
        Assert.Equal("WF000", result.Error!.Code);
    }
}
