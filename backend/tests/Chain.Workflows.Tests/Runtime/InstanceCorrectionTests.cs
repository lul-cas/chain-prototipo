using System.Text.Json.Nodes;
using Chain.Workflows.Runtime;

namespace Chain.Workflows.Tests.Runtime;

/// <summary>Admin data correction on the instance (workflow-engine.md §16.2, §16.5).</summary>
public sealed class InstanceCorrectionTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 16, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void A_correction_replaces_top_level_keys_removes_nulls_and_reports_before_and_after()
    {
        var instance = Started("""{"valor":7000000,"obs":"x","endereco":{"cep":"01310-100","numero":"1"}}""");
        instance.Fault("gw");

        var changes = instance.CorrectData(
        [
            new("valor", JsonValue.Create(7000)),
            new("obs", null),
            new("endereco", JsonNode.Parse("""{"cep":"01310-200"}""")), // a group is replaced as a whole
            new("novo", JsonValue.Create(true)),
        ]);

        Assert.Equal("""{"valor":7000,"endereco":{"cep":"01310-200"},"novo":true}""", instance.Data);
        Assert.Equal(["valor", "obs", "endereco", "novo"], changes.Select(c => c.Key));
        Assert.Equal(["7000000", "\"x\"", """{"cep":"01310-100","numero":"1"}""", null], changes.Select(c => c.Before?.ToJsonString()));
        Assert.Equal(["7000", null, """{"cep":"01310-200"}""", "true"], changes.Select(c => c.After?.ToJsonString()));
        Assert.Equal(InstanceStatus.Faulted, instance.Status); // correction never moves the request on
    }

    [Fact]
    public void A_completed_instance_can_be_corrected_for_its_faulted_parent()
    {
        var child = Started("""{"score":"alto"}""");
        child.Complete(Now);

        child.CorrectData([new("score", JsonValue.Create(80))]);

        Assert.Equal("""{"score":80}""", child.Data);
        Assert.Equal(InstanceStatus.Completed, child.Status);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Running_and_cancelled_instances_cannot_be_corrected(bool cancelled)
    {
        var instance = Started("""{"valor":1}""");
        if (cancelled)
        {
            instance.Cancel(Now);
        }

        Assert.Throws<InvalidOperationException>(() => instance.CorrectData([new("valor", JsonValue.Create(2))]));
        Assert.Equal("""{"valor":1}""", instance.Data);
    }

    private static Instance Started(string data)
    {
        var instance = Instance.Start(Guid.CreateVersion7(Now), "Crédito", 1, Guid.CreateVersion7(Now), "start", Now);
        instance.MergeData(JsonNode.Parse(data)!.AsObject());
        return instance;
    }
}
