using System.Text.Json.Nodes;
using Chain.Workflows.Modeling;

namespace Chain.Workflows.Tests.Modeling;

public sealed class WorkflowDefinitionTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 15, 9, 0, 0, TimeSpan.Zero);

    [Fact]
    public void New_definition_is_inactive_with_an_empty_draft()
    {
        var definition = WorkflowDefinition.Create(WorkflowName.Create(" Concessão "), null, Guid.NewGuid(), Now);

        Assert.Equal("Concessão", definition.Name);
        Assert.Equal("concessão", definition.NormalizedName);
        Assert.False(definition.IsActive);
        Assert.Null(definition.LatestVersion);
        Assert.Equal(WorkflowDefinition.EmptyDraft, definition.Draft);
    }

    [Fact]
    public void First_publish_activates_and_later_publishes_keep_the_flag()
    {
        var definition = WorkflowDefinition.Create(WorkflowName.Create("Concessão"), null, Guid.NewGuid(), Now);

        definition.RecordPublished(1, Now);
        Assert.True(definition.IsActive);

        definition.Deactivate(Now);
        definition.RecordPublished(2, Now);
        Assert.False(definition.IsActive);
        Assert.Equal(2, definition.LatestVersion);
    }

    [Fact]
    public void Versions_must_be_consecutive()
    {
        var definition = WorkflowDefinition.Create(WorkflowName.Create("Concessão"), null, Guid.NewGuid(), Now);

        Assert.Throws<InvalidOperationException>(() => definition.RecordPublished(2, Now));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("  ")]
    public void Blank_names_are_rejected(string? raw) => Assert.False(WorkflowName.TryCreate(raw, out _));

    [Fact]
    public void Name_length_limit_is_100()
    {
        Assert.True(WorkflowName.TryCreate(new string('w', 100), out _));
        Assert.False(WorkflowName.TryCreate(new string('w', 101), out _));
    }

    // Regression #129: PostgreSQL text cannot store the NUL character, so saving a name with one failed in the database.

    [Fact]
    public void Names_postgresql_cannot_store_are_rejected()
    {
        Assert.False(WorkflowName.TryCreate("Concessão\u0000", out _));
        Assert.False(WorkflowName.TryCreate("Concessão\ud800", out _));
    }
}

public sealed class ReferencePinsTests
{
    private const string Draft = """
        {"schemaVersion":1,"lanes":[],"nodes":[
          {"id":"a","type":"task","taskKind":"subprocess","label":"A","workflow":{"workflowId":"child-1"}},
          {"id":"b","type":"task","taskKind":"subprocess","label":"B","workflow":{"workflowId":"child-2"}},
          {"id":"c","type":"task","taskKind":"human","label":"C","form":{"formId":"f","version":3}},
          {"id":"d","type":"task","taskKind":"automation","label":"D","automation":{"automationId":"auto-1","inputs":{}}}
        ],"flows":[]}
        """;

    private static readonly Dictionary<string, int> None = [];

    [Fact]
    public void Pins_each_subprocess_to_its_version()
    {
        var pinned = JsonNode.Parse(ReferencePins.Pin(Draft, new Dictionary<string, int> { ["child-1"] = 4, ["child-2"] = 1 }, None, None))!;

        Assert.Equal(4, (int)pinned["nodes"]![0]!["workflow"]!["version"]!);
        Assert.Equal(1, (int)pinned["nodes"]![1]!["workflow"]!["version"]!);
    }

    [Fact]
    public void Pins_forms_to_their_version()
    {
        var pinned = JsonNode.Parse(ReferencePins.Pin(Draft, None, new Dictionary<string, int> { ["f"] = 7 }, None))!;

        Assert.Equal(7, (int)pinned["nodes"]![2]!["form"]!["version"]!);
        Assert.Null(pinned["nodes"]![0]!["workflow"]!["version"]);
    }

    [Fact]
    public void Unpin_removes_every_pinned_version()
    {
        var pinned = ReferencePins.Pin(Draft, new Dictionary<string, int> { ["child-1"] = 4, ["child-2"] = 1 }, None, new Dictionary<string, int> { ["auto-1"] = 2 });

        var unpinned = JsonNode.Parse(ReferencePins.Unpin(pinned))!;

        Assert.Null(unpinned["nodes"]![0]!["workflow"]!["version"]);
        Assert.Null(unpinned["nodes"]![2]!["form"]!["version"]);
        Assert.Null(unpinned["nodes"]![3]!["automation"]!["version"]);
        Assert.Equal("child-1", (string?)unpinned["nodes"]![0]!["workflow"]!["workflowId"]);
    }

    [Fact]
    public void Pins_automations_to_their_version_and_keeps_their_mappings()
    {
        var pinned = JsonNode.Parse(ReferencePins.Pin(Draft, None, None, new Dictionary<string, int> { ["auto-1"] = 2 }))!;

        var automation = pinned["nodes"]![3]!["automation"]!;
        Assert.Equal(2, (int)automation["version"]!);
        Assert.Equal("auto-1", (string?)automation["automationId"]);
        Assert.NotNull(automation["inputs"]);
    }
}
