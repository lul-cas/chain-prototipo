using Chain.SharedKernel;
using Chain.Workflows.Definitions;

namespace Chain.Workflows.Tests.Definitions;

/// <summary>Content hash (specs/modules/workflow-definition.md §3, ADR-0004).</summary>
public sealed class ContentHashTests
{
    [Fact]
    public void Hash_is_sha256_prefixed_lowercase_hex()
    {
        var hash = ContentHash.Compute(SampleWorkflow.Create().ToJsonString());

        Assert.Matches("^sha256:[0-9a-f]{64}$", hash);
    }

    [Fact]
    public void Hash_ignores_property_order_and_whitespace()
    {
        const string compact = """{"a":1,"b":{"x":"é","y":[1,2]}}""";
        const string reordered = """
            {
              "b": { "y": [1, 2], "x": "é" },
              "a": 1
            }
            """;

        Assert.Equal(ContentHash.Compute(compact), ContentHash.Compute(reordered));
    }

    [Fact]
    public void Hash_is_sensitive_to_array_order()
    {
        Assert.NotEqual(ContentHash.Compute("""{"a":[1,2]}"""), ContentHash.Compute("""{"a":[2,1]}"""));
    }

    [Fact]
    public void Hash_changes_when_any_value_changes()
    {
        var original = SampleWorkflow.Create();
        var changed = SampleWorkflow.Create();
        SampleWorkflow.Node(changed, "task_1")["label"] = "Analisar documentos!";

        Assert.NotEqual(ContentHash.Compute(original.ToJsonString()), ContentHash.Compute(changed.ToJsonString()));
    }

    [Fact]
    public void Hash_is_deterministic_for_a_known_document()
    {
        // The hash of a reordered, spaced document equals the SHA-256 of its canonical form.
        Assert.Equal(
            Sha256Hex("""{"a":1,"b":"x"}"""),
            ContentHash.Compute("""{ "b": "x", "a": 1 }"""));
    }

    private static string Sha256Hex(string canonical) =>
        "sha256:" + Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(canonical)));
}
