using System.Text.Json.Nodes;

namespace Chain.Workflows.Application.Engine;

/// <summary>A request's diagram (workflow-engine.md §9, "Diagram"): its pinned version, and the step it is at.</summary>
public sealed record DiagramView(Guid DefinitionId, int VersionNumber, string CurrentNodeId, JsonObject Document);

/// <summary>
/// A published document with only what drawing it needs (workflow-engine.md §9, "Diagram"). Forms, questions, conditions,
/// mappings, references and lane groups are left out: a request's viewers aren't its modelers.
/// </summary>
public static class InstanceDiagram
{
    private static readonly string[] LaneFields = ["id", "title", "layout"];
    private static readonly string[] NodeFields = ["id", "type", "taskKind", "decisionMode", "label", "laneId", "layout"];
    private static readonly string[] FlowFields = ["id", "source", "target", "branch", "layout"];

    public static JsonObject Of(string document)
    {
        var source = JsonNode.Parse(document)!.AsObject();
        return new JsonObject
        {
            ["schemaVersion"] = source["schemaVersion"]?.DeepClone(),
            ["lanes"] = Pick(source["lanes"], LaneFields),
            ["nodes"] = Pick(source["nodes"], NodeFields),
            ["flows"] = Pick(source["flows"], FlowFields),
        };
    }

    private static JsonArray Pick(JsonNode? items, string[] fields)
    {
        var picked = new JsonArray();
        foreach (var item in items?.AsArray() ?? [])
        {
            if (item is not JsonObject element)
            {
                continue;
            }

            var kept = new JsonObject();
            foreach (var field in fields)
            {
                if (element.TryGetPropertyValue(field, out var value))
                {
                    kept[field] = value?.DeepClone();
                }
            }

            picked.Add(kept);
        }

        return picked;
    }
}
