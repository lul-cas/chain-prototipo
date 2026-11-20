using System.Text.Json;
using System.Text.Json.Nodes;

namespace Chain.Workflows.Application.Engine;

/// <summary>
/// A request's sensitive keys as one caller may see them (sensitive-data.md §4, §5; card #53): all of them, or none, which
/// are then left out of the data and masked in <c>data.corrected</c> events.
/// </summary>
internal sealed record SensitiveScope(IReadOnlySet<string> Keys, bool SeesAll)
{
    /// <summary>Nothing to hide: the version has no sensitive keys, or the caller may see them.</summary>
    public static SensitiveScope Nothing { get; } = new(new HashSet<string>(StringComparer.Ordinal), SeesAll: true);

    public bool Hides(string key) => !SeesAll && Keys.Contains(key);

    /// <summary>The data without the keys this caller may not see, and those keys, sorted.</summary>
    public (JsonElement Data, IReadOnlyList<string> Masked) Mask(string data)
    {
        var parsed = JsonNode.Parse(data)!.AsObject();
        var masked = parsed.Select(property => property.Key).Where(Hides).Order(StringComparer.Ordinal).ToList();
        foreach (var key in masked)
        {
            parsed.Remove(key);
        }

        return (JsonSerializer.SerializeToElement(parsed), masked);
    }

    /// <summary>
    /// The sensitive keys a view shows this caller, sorted (§6): those in the data, and those whose <c>before</c> and <c>after</c>
    /// a <c>data.corrected</c> event shows. None when the caller may not see them.
    /// </summary>
    public IReadOnlyList<string> Shown(string data, IEnumerable<(string Type, string Details)> events)
    {
        if (!SeesAll || Keys.Count == 0)
        {
            return [];
        }

        var shown = JsonNode.Parse(data)!.AsObject().Select(property => property.Key).Where(Keys.Contains).ToHashSet(StringComparer.Ordinal);
        foreach (var (type, details) in events.Where(e => e.Type == "data.corrected"))
        {
            if (JsonNode.Parse(details)?["changes"] is JsonArray changes)
            {
                shown.UnionWith(changes.Select(change => change?["key"]?.GetValue<string>()).OfType<string>().Where(Keys.Contains));
            }
        }

        return [.. shown.Order(StringComparer.Ordinal)];
    }

    /// <summary>A <c>data.corrected</c> event's details, each hidden change shown as <c>{ key, masked: true }</c> (§5).</summary>
    public JsonElement MaskCorrection(string details)
    {
        var parsed = JsonNode.Parse(details)!.AsObject();
        if (!SeesAll && parsed["changes"] is JsonArray changes)
        {
            for (var i = 0; i < changes.Count; i++)
            {
                if (changes[i]?["key"]?.GetValue<string>() is { } key && Hides(key))
                {
                    changes[i] = new JsonObject { ["key"] = key, ["masked"] = true };
                }
            }
        }

        return JsonSerializer.SerializeToElement(parsed);
    }
}
