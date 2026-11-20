using System.Text.Json.Nodes;
using Chain.Workflows.Definitions;
using static Chain.Workflows.Tests.Definitions.SampleWorkflow;

namespace Chain.Workflows.Tests.Definitions;

/// <summary>Publish validation rules WF001–WF017 (specs/modules/workflow-definition.md §2).</summary>
public sealed class WorkflowValidatorTests
{
    [Fact]
    public void Valid_workflow_has_no_errors()
    {
        Assert.Empty(Validate(Create()));
    }

    [Fact]
    public void Flow_back_to_start_is_allowed()
    {
        var document = Create();
        FlowById(document, "f_4")["target"] = "start_1";

        Assert.Empty(Validate(document));
    }

    [Fact]
    public void WF001_no_start_node()
    {
        var document = Create();
        RemoveNode(document, "start_1");
        RemoveFlow(document, "f_1");

        AssertHasError(Validate(document), "WF001");
    }

    [Fact]
    public void WF001_more_than_one_start_node()
    {
        var document = Create();
        document["nodes"]!.AsArray().Add(new JsonObject { ["id"] = "start_2", ["type"] = "start", ["label"] = "Outro início" });
        document["flows"]!.AsArray().Add(Flow("f_9", "start_2", "task_1"));

        AssertHasError(Validate(document), "WF001", "start_2");
    }

    [Fact]
    public void WF002_no_end_node()
    {
        var document = Create();
        RemoveNode(document, "end_1");
        FlowById(document, "f_3")["target"] = "task_1";

        AssertHasError(Validate(document), "WF002");
    }

    [Fact]
    public void WF003_duplicate_ids_across_element_kinds()
    {
        var document = Create();
        FlowById(document, "f_1")["id"] = "lane_a";

        AssertHasError(Validate(document), "WF003", "lane_a");
    }

    [Fact]
    public void WF004_flow_references_missing_node()
    {
        var document = Create();
        FlowById(document, "f_2")["target"] = "ghost";

        AssertHasError(Validate(document), "WF004", "f_2");
    }

    [Fact]
    public void WF005_task_without_outgoing_flow()
    {
        var document = Create();
        RemoveFlow(document, "f_2");

        AssertHasError(Validate(document), "WF005", "task_1");
    }

    [Fact]
    public void WF005_task_with_two_outgoing_flows_because_parallelism_is_not_supported()
    {
        var document = Create();
        document["flows"]!.AsArray().Add(Flow("f_9", "task_1", "end_1"));

        AssertHasError(Validate(document), "WF005", "task_1");
    }

    [Fact]
    public void WF005_start_with_two_outgoing_flows()
    {
        var document = Create();
        document["flows"]!.AsArray().Add(Flow("f_9", "start_1", "end_1"));

        AssertHasError(Validate(document), "WF005", "start_1");
    }

    [Fact]
    public void WF006_gateway_missing_false_branch()
    {
        var document = Create();
        RemoveFlow(document, "f_4");

        AssertHasError(Validate(document), "WF006", "gw_1");
    }

    [Fact]
    public void WF006_gateway_with_two_true_branches()
    {
        var document = Create();
        FlowById(document, "f_4")["branch"] = "true";

        AssertHasError(Validate(document), "WF006", "gw_1");
    }

    [Fact]
    public void WF006_gateway_flow_without_branch()
    {
        var document = Create();
        FlowById(document, "f_4").Remove("branch");

        AssertHasError(Validate(document), "WF006", "gw_1");
    }

    [Fact]
    public void WF006_gateway_true_flow_without_branch()
    {
        var document = Create();
        FlowById(document, "f_3").Remove("branch");

        AssertHasError(Validate(document), "WF006", "gw_1");
    }

    [Fact]
    public void WF007_end_with_outgoing_flow()
    {
        var document = Create();
        document["flows"]!.AsArray().Add(Flow("f_9", "end_1", "task_1"));

        AssertHasError(Validate(document), "WF007", "end_1");
    }

    [Fact]
    public void WF008_node_unreachable_from_start()
    {
        var document = Create();
        document["nodes"]!.AsArray().Add(new JsonObject { ["id"] = "orphan", ["type"] = "task", ["taskKind"] = "human", ["label"] = "Órfã" });
        document["flows"]!.AsArray().Add(Flow("f_9", "orphan", "end_1"));

        AssertHasError(Validate(document), "WF008", "orphan");
    }

    [Fact]
    public void WF009_node_cannot_reach_an_end()
    {
        var document = Create();
        // task_2 and task_3 loop forever: reachable from the gateway, but no path leads to an end.
        document["nodes"]!.AsArray().Add(new JsonObject { ["id"] = "task_2", ["type"] = "task", ["taskKind"] = "human", ["label"] = "A" });
        document["nodes"]!.AsArray().Add(new JsonObject { ["id"] = "task_3", ["type"] = "task", ["taskKind"] = "human", ["label"] = "B" });
        FlowById(document, "f_4")["target"] = "task_2";
        document["flows"]!.AsArray().Add(Flow("f_8", "task_2", "task_3"));
        document["flows"]!.AsArray().Add(Flow("f_9", "task_3", "task_2"));

        var errors = Validate(document);

        AssertHasError(errors, "WF009", "task_2");
        AssertHasError(errors, "WF009", "task_3");
        Assert.DoesNotContain(errors, e => e.Code == "WF009" && e.ElementId == "task_1");
    }

    [Fact]
    public void WF010_self_loop()
    {
        var document = Create();
        FlowById(document, "f_2")["target"] = "task_1";

        AssertHasError(Validate(document), "WF010", "f_2");
    }

    [Fact]
    public void WF011_unknown_lane()
    {
        var document = Create();
        Node(document, "task_1")["laneId"] = "lane_z";

        AssertHasError(Validate(document), "WF011", "task_1");
    }

    [Fact]
    public void Node_without_lane_is_allowed_and_belongs_to_requesters()
    {
        var document = Create();
        Node(document, "start_1").Remove("laneId");

        Assert.Empty(Validate(document));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void WF012_blank_label(string label)
    {
        var document = Create();
        Node(document, "task_1")["label"] = label;

        AssertHasError(Validate(document), "WF012", "task_1");
    }

    [Fact]
    public void WF012_missing_label()
    {
        var document = Create();
        Node(document, "task_1").Remove("label");

        AssertHasError(Validate(document), "WF012", "task_1");
    }

    [Fact]
    public void WF012_label_longer_than_120_characters()
    {
        var document = Create();
        Node(document, "task_1")["label"] = new string('a', 121);

        AssertHasError(Validate(document), "WF012", "task_1");
    }

    [Fact]
    public void WF012_label_of_exactly_120_characters_is_valid()
    {
        var document = Create();
        Node(document, "task_1")["label"] = new string('a', 120);

        Assert.Empty(Validate(document));
    }

    [Fact]
    public void WF013_human_gateway_without_question()
    {
        var document = Create();
        Node(document, "gw_1").Remove("question");

        AssertHasError(Validate(document), "WF013", "gw_1");
    }

    [Fact]
    public void WF013_automatic_gateway_without_condition()
    {
        var document = Create();
        Node(document, "gw_1")["decisionMode"] = "automatic";

        AssertHasError(Validate(document), "WF013", "gw_1");
    }

    [Fact]
    public void WF013_automatic_gateway_with_an_invalid_condition()
    {
        var document = Create();
        var gateway = Node(document, "gw_1");
        gateway["decisionMode"] = "automatic";
        gateway["condition"] = new JsonObject { ["kind"] = "script", ["code"] = "alert(1)" };

        AssertHasError(Validate(document), "WF013", "gw_1");
    }

    [Fact]
    public void WF013_automatic_gateway_with_condition_is_valid()
    {
        var document = Create();
        var gateway = Node(document, "gw_1");
        gateway["decisionMode"] = "automatic";
        gateway.Remove("question");
        gateway["condition"] = new JsonObject { ["kind"] = "group", ["op"] = "and", ["items"] = new JsonArray() };

        Assert.Empty(Validate(document));
    }

    [Fact]
    public void WF013_gateway_without_decision_mode()
    {
        var document = Create();
        Node(document, "gw_1").Remove("decisionMode");

        AssertHasError(Validate(document), "WF013", "gw_1");
    }

    [Fact]
    public void WF014_task_without_kind()
    {
        var document = Create();
        Node(document, "task_1").Remove("taskKind");

        AssertHasError(Validate(document), "WF014", "task_1");
    }

    [Fact]
    public void WF014_automation_task_without_automation_reference()
    {
        var document = Create();
        Node(document, "task_1")["taskKind"] = "automation";

        AssertHasError(Validate(document), "WF014", "task_1");
    }

    [Fact]
    public void WF014_subprocess_task_without_workflow_reference()
    {
        var document = Create();
        Node(document, "task_1")["taskKind"] = "subprocess";

        AssertHasError(Validate(document), "WF014", "task_1");
    }

    [Fact]
    public void WF014_task_variants_with_references_are_valid()
    {
        var document = Create();
        var task = Node(document, "task_1");
        task["taskKind"] = "subprocess";
        task.Remove("form");
        task["workflow"] = new JsonObject { ["workflowId"] = "verificacao-cadastral" };

        Assert.Empty(Validate(document));
    }

    [Fact]
    public void Subprocess_mappings_with_valid_trees_and_keys_are_valid()
    {
        var document = Create();
        var task = Node(document, "task_1");
        task["taskKind"] = "subprocess";
        task.Remove("form");
        task["workflow"] = new JsonObject
        {
            ["workflowId"] = "child",
            ["inputs"] = new JsonObject { ["valor"] = new JsonObject { ["kind"] = "path", ["path"] = new JsonArray("valor") } },
            ["outputs"] = new JsonObject { ["parecer_filho"] = new JsonObject { ["kind"] = "path", ["path"] = new JsonArray("parecer") } },
        };

        Assert.Empty(Validate(document));
    }

    [Fact]
    public void WF018_subprocess_mappings_must_be_valid_value_trees()
    {
        var document = Create();
        var task = Node(document, "task_1");
        task["taskKind"] = "subprocess";
        task.Remove("form");
        task["workflow"] = new JsonObject
        {
            ["workflowId"] = "child",
            ["inputs"] = new JsonObject { ["valor"] = new JsonObject { ["kind"] = "script" } },
        };

        AssertHasError(Validate(document), "WF018", "task_1");
    }

    [Fact]
    public void WF019_subprocess_mapping_keys_must_be_valid()
    {
        var document = Create();
        var task = Node(document, "task_1");
        task["taskKind"] = "subprocess";
        task.Remove("form");
        task["workflow"] = new JsonObject
        {
            ["workflowId"] = "child",
            ["outputs"] = new JsonObject { ["1 inválida"] = new JsonObject { ["kind"] = "path", ["path"] = new JsonArray("x") } },
        };

        AssertHasError(Validate(document), "WF019", "task_1");
    }

    [Fact]
    public void Automation_mappings_with_valid_trees_and_keys_are_valid()
    {
        var document = AutomationStep(
            new JsonObject { ["cpf"] = PathTo("cpf"), ["canal"] = new JsonObject { ["kind"] = "literal", ["type"] = "text", ["value"] = "web" } },
            new JsonObject { ["situacao_cpf"] = PathTo("situacao") });

        Assert.Empty(Validate(document));
    }

    [Theory]
    [InlineData("inputs")]
    [InlineData("outputs")]
    public void WF109_automation_mappings_must_be_valid_value_trees(string mapping)
    {
        var document = AutomationStep();
        Node(document, "task_1")["automation"]![mapping] = new JsonObject { ["cpf"] = new JsonObject { ["kind"] = "script" } };

        var errors = Validate(document);

        AssertHasError(errors, "WF109", "task_1");
        Assert.DoesNotContain(errors, e => e.Code is "WF018" or "WF019");
    }

    [Theory]
    [InlineData("inputs", "1cpf")]
    [InlineData("outputs", "situação")]
    [InlineData("outputs", "a_name_that_is_far_too_long_for_a_mapping_key_of_sixty_four_chars_")]
    [InlineData("inputs", "cpf\n")] // accepted before #81: in .NET, $ also matches before a final newline
    public void WF109_automation_mapping_keys_must_be_valid(string mapping, string key)
    {
        var document = AutomationStep();
        Node(document, "task_1")["automation"]![mapping] = new JsonObject { [key] = PathTo("cpf") };

        AssertHasError(Validate(document), "WF109", "task_1");
    }

    [Fact]
    public void WF109_accepts_a_key_of_sixty_four_characters()
    {
        var document = AutomationStep(outputs: new JsonObject { ["a" + new string('b', 63)] = PathTo("cpf") });

        Assert.Empty(Validate(document));
    }

    /// <summary>The sample with task_1 turned into an automation step.</summary>
    private static JsonObject AutomationStep(JsonObject? inputs = null, JsonObject? outputs = null)
    {
        var document = Create();
        var task = Node(document, "task_1");
        task["taskKind"] = "automation";
        task.Remove("form");
        var reference = new JsonObject { ["automationId"] = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" };
        if (inputs is not null)
        {
            reference["inputs"] = inputs;
        }

        if (outputs is not null)
        {
            reference["outputs"] = outputs;
        }

        task["automation"] = reference;
        return document;
    }

    private static JsonObject PathTo(string key) => new() { ["kind"] = "path", ["path"] = new JsonArray(key) };

    [Fact]
    public void WF015_branch_on_non_gateway_flow()
    {
        var document = Create();
        FlowById(document, "f_2")["branch"] = "true";

        AssertHasError(Validate(document), "WF015", "f_2");
    }

    [Fact]
    public void WF016_too_many_nodes()
    {
        var document = Create();
        var nodes = document["nodes"]!.AsArray();
        for (var i = 0; i < 500; i++)
        {
            nodes.Add(new JsonObject { ["id"] = $"extra_{i}", ["type"] = "end", ["label"] = "Fim" });
        }

        var errors = Validate(document);

        AssertHasError(errors, "WF016");
        Assert.Single(errors);
    }

    [Fact]
    public void WF017_group_lane_without_group_id()
    {
        var document = Create();
        document["lanes"]![1]!["group"]!.AsObject().Remove("groupId");

        AssertHasError(Validate(document), "WF017", "lane_b");
    }

    [Fact]
    public void WF017_requesters_lane_with_group_id()
    {
        var document = Create();
        document["lanes"]![0]!["group"]!["groupId"] = AnalystGroupId;

        AssertHasError(Validate(document), "WF017", "lane_a");
    }

    [Fact]
    public void Reports_all_errors_in_a_single_run()
    {
        var document = Create();
        Node(document, "task_1")["label"] = "";
        Node(document, "gw_1").Remove("question");
        FlowById(document, "f_2")["branch"] = "false";

        var errors = Validate(document);

        AssertHasError(errors, "WF012", "task_1");
        AssertHasError(errors, "WF013", "gw_1");
        AssertHasError(errors, "WF015", "f_2");
    }

    private static void AssertHasError(IReadOnlyList<ValidationError> errors, string code, string? elementId = null)
    {
        Assert.Contains(errors, e => e.Code == code && (elementId is null || e.ElementId == elementId));
    }
}
