using Chain.Workflows.Definitions;

namespace Chain.Workflows.Runtime;

public enum TaskKindAtNode
{
    /// <summary>A human task (or the start node re-entered through a loop): completed by an eligible actor.</summary>
    Task,

    /// <summary>A human gateway: decided true or false by an eligible actor.</summary>
    Decision,
}

/// <summary>Where the token stops after moving.</summary>
public abstract record Arrival
{
    /// <summary>A wait state; <see cref="GroupId"/> is null when the requester acts (requesters lane or no lane).</summary>
    public sealed record Wait(Node Node, TaskKindAtNode Kind, Guid? GroupId) : Arrival;

    public sealed record Finished(Node Node) : Arrival;

    /// <summary>An automatic gateway: the engine evaluates its condition and moves on in the same command (workflow-engine.md §13.2).</summary>
    public sealed record Automatic(Node Node) : Arrival;

    /// <summary>A sub-workflow step: the engine starts a child instance (workflow-engine.md §14.2).</summary>
    public sealed record Subprocess(Node Node) : Arrival;

    /// <summary>An automation step: the engine dispatches a work request, and the instance waits for its result (automation.md §6.1).</summary>
    public sealed record Automation(Node Node) : Arrival;
}

/// <summary>
/// Moves the single token through a pinned workflow version (workflow-engine.md §3). Pure: no I/O, no clock.
/// E1 supports start, human tasks, human gateways and end; other node kinds are rejected before starting.
/// </summary>
public sealed class FlowNavigator
{
    private readonly Dictionary<string, Node> _nodes;
    private readonly ILookup<string, Flow> _outgoing;
    private readonly Dictionary<string, Lane> _lanes;

    public FlowNavigator(WorkflowDocument document)
    {
        ArgumentNullException.ThrowIfNull(document);
        Document = document;
        _nodes = document.Nodes.ToDictionary(n => n.Id, StringComparer.Ordinal);
        _outgoing = document.Flows.ToLookup(f => f.Source, StringComparer.Ordinal);
        _lanes = document.Lanes.ToDictionary(l => l.Id, StringComparer.Ordinal);
        StartNode = document.Nodes.Single(n => n.Type == NodeType.Start);
    }

    /// <summary>The pinned version being navigated.</summary>
    public WorkflowDocument Document { get; }

    public Node StartNode { get; }

    /// <summary>The sub-workflow steps of this version.</summary>
    public IEnumerable<Node> Calls => _nodes.Values.Where(n => n.Type == NodeType.Task && n.TaskKind == TaskKind.Subprocess);

    /// <summary>Moves from the start node along its single outgoing flow.</summary>
    public Arrival Start() => After(StartNode.Id);

    /// <summary>Moves from <paramref name="nodeId"/> along its outgoing flow (for gateways, the flow of <paramref name="branch"/>).</summary>
    public Arrival After(string nodeId, Branch? branch = null)
    {
        var flow = _outgoing[nodeId].Single(f => f.Branch == branch);
        return ArriveAt(_nodes[flow.Target]);
    }

    /// <summary>The arrival at a node the token already sits on (used to re-run a faulted step).</summary>
    public Arrival At(string nodeId) => ArriveAt(_nodes[nodeId]);

    public Node NodeById(string nodeId) => _nodes[nodeId];

    private Arrival ArriveAt(Node node) => node.Type switch
    {
        NodeType.End => new Arrival.Finished(node),
        NodeType.Gateway when node.DecisionMode == DecisionMode.Automatic => new Arrival.Automatic(node),
        NodeType.Gateway => new Arrival.Wait(node, TaskKindAtNode.Decision, GroupOf(node)),
        NodeType.Task when node.TaskKind == TaskKind.Subprocess => new Arrival.Subprocess(node),
        NodeType.Task when node.TaskKind == TaskKind.Automation => new Arrival.Automation(node),
        NodeType.Task or NodeType.Start => new Arrival.Wait(node, TaskKindAtNode.Task, GroupOf(node)),
        _ => throw new InvalidOperationException($"Unsupported node type {node.Type}."),
    };

    private Guid? GroupOf(Node node) =>
        node.LaneId is { } laneId && _lanes.TryGetValue(laneId, out var lane) && lane.Group.Kind == LaneGroupKind.Group
            ? lane.Group.GroupId
            : null;
}
