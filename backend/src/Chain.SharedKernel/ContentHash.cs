using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace Chain.SharedKernel;

/// <summary>
/// Content hash of a definition version (ADR-0004): <c>sha256:</c> + lowercase hex SHA-256 of the canonical JSON.
/// Canonical JSON = object properties sorted by ordinal name, compact, System.Text.Json default escaping;
/// array order is preserved.
/// </summary>
public static class ContentHash
{
    public static string Compute(string json) => ForCanonical(Canonicalize(json));

    /// <summary>The canonical JSON text whose hash is the content hash.</summary>
    public static string Canonicalize(string json) => Canonicalize(JsonNode.Parse(json))?.ToJsonString() ?? "null";

    /// <summary>The content hash of text that is already canonical.</summary>
    public static string ForCanonical(string canonicalJson) =>
        "sha256:" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(canonicalJson)));

    private static JsonNode? Canonicalize(JsonNode? node) => node switch
    {
        JsonObject obj => new JsonObject(
            obj.OrderBy(p => p.Key, StringComparer.Ordinal)
               .Select(p => KeyValuePair.Create(p.Key, Canonicalize(p.Value)))),
        JsonArray array => new JsonArray(array.Select(Canonicalize).ToArray()),
        null => null,
        _ => node.DeepClone(),
    };
}
