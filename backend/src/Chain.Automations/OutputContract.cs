using System.Text.Json;
using System.Text.Json.Nodes;
using Chain.SharedKernel;

namespace Chain.Automations;

/// <summary>The output object of a succeeded result, or why it breaks the output contract (<c>automation_output_invalid</c>).</summary>
public sealed record OutputExtraction(JsonObject? Output, string? Problems);

/// <summary>
/// Builds <c>{ outputKey: value }</c> from a succeeded result (automation.md §7.2): <c>status</c> outputs take the final HTTP status,
/// <c>body</c> outputs follow their path through the parsed body. Each value must be text PostgreSQL can store, and is checked
/// against its declared type (§7.1). Only declared outputs are kept, so undeclared response data never reaches the workflow.
/// </summary>
public static class OutputContract
{
    public static OutputExtraction Extract(IReadOnlyList<AutomationOutput> outputs, int status, JsonNode? body)
    {
        ArgumentNullException.ThrowIfNull(outputs);
        var output = new JsonObject();
        var problems = new List<string>();
        foreach (var declared in outputs)
        {
            if (!TryRead(declared, status, body, out var value))
            {
                problems.Add($"The output '{declared.Key}' holds text that cannot be stored: the NUL character or an unpaired surrogate.");
            }
            else if (value is null)
            {
                if (declared.Required)
                {
                    problems.Add($"The output '{declared.Key}' is required.");
                }
            }
            else if (!ContractTypes.Fits(value, declared.Type))
            {
                problems.Add($"The output '{declared.Key}' must be {ContractTypes.Describe(declared.Type)}.");
            }
            else
            {
                output[declared.Key] = value.DeepClone();
            }
        }

        return problems.Count > 0 ? new OutputExtraction(null, string.Join(' ', problems)) : new OutputExtraction(output, null);
    }

    /// <summary>
    /// The output's value, null when it is missing; false when its text, keys included, can't be merged into the request's data
    /// (identity.md I1, card #154): NUL, or an unpaired surrogate, which System.Text.Json reads only by throwing, in the value or
    /// in a name on its path. This runs before the type check, which reads the text.
    /// </summary>
    private static bool TryRead(AutomationOutput declared, int status, JsonNode? body, out JsonNode? value)
    {
        try
        {
            value = declared.Source == "status" ? JsonValue.Create(status) : Follow(body, declared.Path ?? []);
            return value is null || ClientText.IsStorableJson(value.ToJsonString());
        }
        catch (InvalidOperationException)
        {
            value = null;
            return false;
        }
    }

    /// <summary>A name reads an object's property, a number an array's item; anything else on the way, or JSON null, is missing.</summary>
    private static JsonNode? Follow(JsonNode? node, IReadOnlyList<JsonElement> path)
    {
        foreach (var segment in path)
        {
            node = (node, segment.ValueKind) switch
            {
                (JsonObject item, JsonValueKind.String) => item[segment.GetString()!],
                (JsonArray list, JsonValueKind.Number) when segment.TryGetInt32(out var index) && index >= 0 && index < list.Count => list[index],
                _ => null, // once missing, it stays missing
            };
        }

        return node;
    }
}
