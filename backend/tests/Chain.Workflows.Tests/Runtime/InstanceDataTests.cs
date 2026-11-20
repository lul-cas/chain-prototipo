using System.Text.Json.Nodes;
using Chain.Workflows.Runtime;

namespace Chain.Workflows.Tests.Runtime;

/// <summary>Writing accepted values into the request's data (workflow-engine.md §13.1).</summary>
public sealed class InstanceDataTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 17, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Values_merge_at_the_top_level_and_null_removes_the_key()
    {
        var instance = Instance.Start(Guid.CreateVersion7(Now), "Crédito", 1, Guid.CreateVersion7(Now), "start", Now);
        instance.MergeData(JsonNode.Parse("""{"aceite":true,"obs":"x","endereco":{"cep":"01310-100","numero":"1"}}""")!.AsObject());

        // Regression #86: an unchecked box arrives as null and must not leave the stored true behind.
        instance.MergeData(JsonNode.Parse("""{"aceite":null,"endereco":{"cep":"01310-200"},"novo":1}""")!.AsObject());

        Assert.Equal("""{"obs":"x","endereco":{"cep":"01310-200"},"novo":1}""", instance.Data);
    }
}
