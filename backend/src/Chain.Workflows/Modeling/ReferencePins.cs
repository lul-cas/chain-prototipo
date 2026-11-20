using System.Text.Json.Nodes;

namespace Chain.Workflows.Modeling;

/// <summary>
/// Pins and unpins references inside a workflow document (ADR-0004 §4). Drafts carry definition ids only;
/// published versions carry the exact version of each referenced definition.
/// </summary>
public static class ReferencePins
{
    private static readonly string[] ReferenceProperties = ["form", "automation", "workflow"];

    /// <summary>Returns the document with each sub-workflow, form and automation reference pinned to the given version.</summary>
    public static string Pin(
        string document, IReadOnlyDictionary<string, int> versionsByWorkflowId, IReadOnlyDictionary<string, int> versionsByFormId,
        IReadOnlyDictionary<string, int> versionsByAutomationId)
    {
        ArgumentNullException.ThrowIfNull(versionsByWorkflowId);
        ArgumentNullException.ThrowIfNull(versionsByFormId);
        ArgumentNullException.ThrowIfNull(versionsByAutomationId);
        var root = Parse(document);
        foreach (var node in Nodes(root))
        {
            PinOne(node, "workflow", "workflowId", versionsByWorkflowId);
            PinOne(node, "form", "formId", versionsByFormId);
            PinOne(node, "automation", "automationId", versionsByAutomationId);
        }

        return root.ToJsonString();
    }

    private static void PinOne(JsonObject node, string property, string idProperty, IReadOnlyDictionary<string, int> versions)
    {
        if (node[property] is JsonObject reference && (string?)reference[idProperty] is { } id && versions.TryGetValue(id, out var version))
        {
            reference["version"] = version;
        }
    }

    /// <summary>Removes every pinned version, turning a published document back into a draft.</summary>
    public static string Unpin(string document)
    {
        var root = Parse(document);
        foreach (var node in Nodes(root))
        {
            foreach (var property in ReferenceProperties)
            {
                (node[property] as JsonObject)?.Remove("version");
            }
        }

        return root.ToJsonString();
    }

    private static JsonObject Parse(string document) =>
        JsonNode.Parse(document) as JsonObject ?? throw new ArgumentException("The document must be a JSON object.", nameof(document));

    private static IEnumerable<JsonObject> Nodes(JsonObject root) =>
        (root["nodes"] as JsonArray ?? []).OfType<JsonObject>();
}
