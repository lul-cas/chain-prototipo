using System.Text.Json.Nodes;
using Chain.Workflows.Definitions;

namespace Chain.Workflows.Tests.Definitions;

/// <summary>
/// A valid credit-approval workflow (specs/modules/workflow-definition.md §1):
/// start → analyse documents → "Docs ok?" (true → end, false → back to analysis).
/// Tests mutate a fresh copy to violate exactly one rule.
/// </summary>
internal static class SampleWorkflow
{
    public const string AnalystGroupId = "8c6d0f6e-5a3b-4c1e-9d7a-2f4b6c8e0a12";

    public static JsonObject Create() => new()
    {
        ["schemaVersion"] = 1,
        ["lanes"] = new JsonArray
        {
            new JsonObject
            {
                ["id"] = "lane_a",
                ["title"] = "Solicitantes",
                ["group"] = new JsonObject { ["kind"] = "requesters" },
                ["layout"] = new JsonObject { ["x"] = 40, ["y"] = 30, ["w"] = 1060, ["h"] = 200 },
            },
            new JsonObject
            {
                ["id"] = "lane_b",
                ["title"] = "Análise de Crédito",
                ["group"] = new JsonObject { ["kind"] = "group", ["groupId"] = AnalystGroupId },
            },
        },
        ["nodes"] = new JsonArray
        {
            new JsonObject
            {
                ["id"] = "start_1", ["type"] = "start", ["label"] = "Início", ["laneId"] = "lane_a",
                ["form"] = new JsonObject { ["formId"] = "proposta" },
            },
            new JsonObject
            {
                ["id"] = "task_1", ["type"] = "task", ["taskKind"] = "human", ["label"] = "Analisar documentos",
                ["laneId"] = "lane_b", ["form"] = new JsonObject { ["formId"] = "analise" },
            },
            new JsonObject
            {
                ["id"] = "gw_1", ["type"] = "gateway", ["label"] = "Docs ok?", ["laneId"] = "lane_b",
                ["decisionMode"] = "human", ["question"] = "Documentação correta?",
            },
            new JsonObject { ["id"] = "end_1", ["type"] = "end", ["label"] = "Fim", ["laneId"] = "lane_b" },
        },
        ["flows"] = new JsonArray
        {
            Flow("f_1", "start_1", "task_1"),
            Flow("f_2", "task_1", "gw_1"),
            Flow("f_3", "gw_1", "end_1", "true"),
            Flow("f_4", "gw_1", "task_1", "false"),
        },
    };

    public static JsonObject Flow(string id, string source, string target, string? branch = null)
    {
        var flow = new JsonObject { ["id"] = id, ["source"] = source, ["target"] = target };
        if (branch is not null)
        {
            flow["branch"] = branch;
        }

        return flow;
    }

    public static JsonObject Node(JsonObject document, string id) =>
        document["nodes"]!.AsArray().Select(n => n!.AsObject()).Single(n => (string?)n["id"] == id);

    public static JsonObject FlowById(JsonObject document, string id) =>
        document["flows"]!.AsArray().Select(f => f!.AsObject()).Single(f => (string?)f["id"] == id);

    public static void RemoveFlow(JsonObject document, string id)
    {
        var flows = document["flows"]!.AsArray();
        flows.Remove(flows.Single(f => (string?)f!["id"] == id));
    }

    public static void RemoveNode(JsonObject document, string id)
    {
        var nodes = document["nodes"]!.AsArray();
        nodes.Remove(nodes.Single(n => (string?)n!["id"] == id));
    }

    /// <summary>Parses and validates; fails the test if parsing itself fails.</summary>
    public static IReadOnlyList<ValidationError> Validate(JsonObject document)
    {
        var result = WorkflowDocumentParser.Parse(document.ToJsonString());
        Assert.True(result.IsSuccess, $"Expected the document to parse, got {result.Error}");
        return WorkflowValidator.Validate(result.Document!);
    }
}
