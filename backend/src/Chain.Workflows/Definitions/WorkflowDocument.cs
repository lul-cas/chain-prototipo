using System.Text.Json;

namespace Chain.Workflows.Definitions;

// Workflow definition document, schemaVersion 1. See specs/modules/workflow-definition.md §1.

public enum NodeType { Start, Task, Gateway, End }

public enum TaskKind { Human, Automation, Subprocess }

public enum DecisionMode { Human, Automatic }

public enum Branch { True, False }

public enum LaneGroupKind { Requesters, Group }

public sealed record WorkflowDocument
{
    public required int SchemaVersion { get; init; }
    public required IReadOnlyList<Lane> Lanes { get; init; }
    public required IReadOnlyList<Node> Nodes { get; init; }
    public required IReadOnlyList<Flow> Flows { get; init; }
}

public sealed record Lane
{
    public required string Id { get; init; }
    public string? Title { get; init; }
    public required LaneGroup Group { get; init; }
    public JsonElement? Layout { get; init; }
}

public sealed record LaneGroup
{
    public required LaneGroupKind Kind { get; init; }
    public Guid? GroupId { get; init; }
}

public sealed record Node
{
    public required string Id { get; init; }
    public required NodeType Type { get; init; }
    public string? Label { get; init; }
    public string? LaneId { get; init; }
    public JsonElement? Layout { get; init; }

    // Start and human task.
    public FormReference? Form { get; init; }

    // Task.
    public TaskKind? TaskKind { get; init; }
    public AutomationReference? Automation { get; init; }
    public WorkflowReference? Workflow { get; init; }

    // Gateway.
    public DecisionMode? DecisionMode { get; init; }
    public string? Question { get; init; }
    public JsonElement? Condition { get; init; }
}

public sealed record Flow
{
    public required string Id { get; init; }
    public required string Source { get; init; }
    public required string Target { get; init; }
    public Branch? Branch { get; init; }
    public JsonElement? Layout { get; init; }
}

public sealed record FormReference
{
    public required string FormId { get; init; }
    public int? Version { get; init; }
}

public sealed record AutomationReference
{
    public required string AutomationId { get; init; }
    public int? Version { get; init; }

    /// <summary>Automation inputs: <c>{ inputKey: valueTree }</c> evaluated over the instance's data (automation.md §5.6).</summary>
    public IReadOnlyDictionary<string, JsonElement>? Inputs { get; init; }

    /// <summary>Returned data: <c>{ instanceKey: valueTree }</c> evaluated over the automation's output object.</summary>
    public IReadOnlyDictionary<string, JsonElement>? Outputs { get; init; }
}

public sealed record WorkflowReference
{
    public required string WorkflowId { get; init; }
    public int? Version { get; init; }

    /// <summary>Child start data: <c>{ childKey: valueTree }</c> evaluated over the parent's data (workflow-engine.md §14.1).</summary>
    public IReadOnlyDictionary<string, JsonElement>? Inputs { get; init; }

    /// <summary>Returned data: <c>{ parentKey: valueTree }</c> evaluated over the child's data on completion.</summary>
    public IReadOnlyDictionary<string, JsonElement>? Outputs { get; init; }
}
