using System.Text.Json;

namespace Chain.Workflows.Definitions;

/// <summary>
/// Structural publish validation, rules WF001–WF017 (specs/modules/workflow-definition.md §2).
/// Returns every finding in one run. Rules that need external data (group or form existence) belong to the application layer.
/// </summary>
public static class WorkflowValidator
{
    public const int MaxNodes = 500;
    public const int MaxFlows = 1000;
    public const int MaxLanes = 50;
    public const int MaxLabelLength = 120;

    public static IReadOnlyList<ValidationError> Validate(WorkflowDocument document)
    {
        ArgumentNullException.ThrowIfNull(document);

        // WF016 first: oversized documents are not analysed further.
        if (document.Nodes.Count > MaxNodes || document.Flows.Count > MaxFlows || document.Lanes.Count > MaxLanes)
        {
            return [new ValidationError("WF016", $"The workflow exceeds the size limits ({MaxNodes} nodes, {MaxFlows} flows, {MaxLanes} lanes).")];
        }

        var errors = new List<ValidationError>();
        CheckUniqueIds(document, errors);

        var nodes = document.Nodes.GroupBy(n => n.Id, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        var laneIds = document.Lanes.Select(l => l.Id).ToHashSet(StringComparer.Ordinal);

        CheckLanes(document.Lanes, errors);
        CheckNodes(document.Nodes, laneIds, errors);
        var validFlows = CheckFlows(document.Flows, nodes, errors);
        CheckStartAndEnd(document.Nodes, errors);
        CheckOutgoingFlows(document.Nodes, validFlows, errors);
        CheckReachability(document.Nodes, validFlows, errors);

        return errors;
    }

    private static void CheckUniqueIds(WorkflowDocument document, List<ValidationError> errors)
    {
        var duplicates = document.Lanes.Select(l => l.Id)
            .Concat(document.Nodes.Select(n => n.Id))
            .Concat(document.Flows.Select(f => f.Id))
            .GroupBy(id => id, StringComparer.Ordinal)
            .Where(g => g.Count() > 1)
            .Select(g => g.Key);

        foreach (var id in duplicates)
        {
            errors.Add(new ValidationError("WF003", $"The id '{id}' is used more than once.", id));
        }
    }

    private static void CheckLanes(IEnumerable<Lane> lanes, List<ValidationError> errors)
    {
        foreach (var lane in lanes)
        {
            var valid = lane.Group.Kind switch
            {
                LaneGroupKind.Requesters => lane.Group.GroupId is null,
                LaneGroupKind.Group => lane.Group.GroupId is { } id && id != Guid.Empty,
                _ => false,
            };

            if (!valid)
            {
                errors.Add(new ValidationError("WF017", "A lane must belong to the requesters (without groupId) or to a group (with groupId).", lane.Id));
            }
        }
    }

    private static void CheckNodes(IEnumerable<Node> nodes, HashSet<string> laneIds, List<ValidationError> errors)
    {
        foreach (var node in nodes)
        {
            if (node.LaneId is not null && !laneIds.Contains(node.LaneId))
            {
                errors.Add(new ValidationError("WF011", $"Lane '{node.LaneId}' does not exist.", node.Id));
            }

            if (string.IsNullOrWhiteSpace(node.Label) || node.Label.Length > MaxLabelLength)
            {
                errors.Add(new ValidationError("WF012", $"The label must be non-empty and at most {MaxLabelLength} characters.", node.Id));
            }

            if (node.Type == NodeType.Gateway)
            {
                CheckGatewayDecision(node, errors);
            }

            if (node.Type == NodeType.Task)
            {
                CheckTaskKind(node, errors);
            }
        }
    }

    private static void CheckGatewayDecision(Node gateway, List<ValidationError> errors)
    {
        var valid = gateway.DecisionMode switch
        {
            DecisionMode.Human => !string.IsNullOrWhiteSpace(gateway.Question),
            DecisionMode.Automatic => gateway.Condition is { ValueKind: JsonValueKind.Object } condition
                && Chain.Expressions.ExpressionParser.ParseCondition(condition).IsSuccess,
            _ => false,
        };

        if (!valid)
        {
            errors.Add(new ValidationError("WF013", "A human gateway needs a question; an automatic gateway needs a valid condition (expression-language.md §5.1).", gateway.Id));
        }
    }

    private static void CheckTaskKind(Node task, List<ValidationError> errors)
    {
        var valid = task.TaskKind switch
        {
            TaskKind.Human => true,
            TaskKind.Automation => task.Automation is not null,
            TaskKind.Subprocess => task.Workflow is not null,
            _ => false,
        };

        if (!valid)
        {
            errors.Add(new ValidationError("WF014", "A task needs a kind; automation tasks need an automation and subprocess tasks a workflow.", task.Id));
        }

        if (task.TaskKind == TaskKind.Subprocess && task.Workflow is { } reference)
        {
            // WF018/WF019: sub-workflow input and output mappings (workflow-engine.md §14.1).
            CheckMappings(task, reference.Inputs, reference.Outputs, treeCode: "WF018", keyCode: "WF019", errors);
        }

        if (task.TaskKind == TaskKind.Automation && task.Automation is { } automation)
        {
            // WF109: automation input and output mappings (automation.md §5.5).
            CheckMappings(task, automation.Inputs, automation.Outputs, treeCode: "WF109", keyCode: "WF109", errors);
        }
    }

    // \z: $ would also match before a trailing newline (#81).
    private static readonly System.Text.RegularExpressions.Regex MappingKey =
        new(@"^[a-zA-Z][a-zA-Z0-9_]{0,63}\z", System.Text.RegularExpressions.RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));

    private static void CheckMappings(
        Node task, IReadOnlyDictionary<string, JsonElement>? inputs, IReadOnlyDictionary<string, JsonElement>? outputs, string treeCode, string keyCode,
        List<ValidationError> errors)
    {
        var mappings = (inputs ?? new Dictionary<string, JsonElement>()).Concat(outputs ?? new Dictionary<string, JsonElement>()).ToList();
        if (mappings.Any(m => !MappingKey.IsMatch(m.Key)))
        {
            errors.Add(new ValidationError(keyCode, "Mapping keys start with a letter and use letters, digits or '_' (at most 64).", task.Id));
        }

        if (mappings.Any(m => !Chain.Expressions.ExpressionParser.ParseValue(m.Value).IsSuccess))
        {
            errors.Add(new ValidationError(treeCode, "Every input and output mapping must be a valid value tree (expression-language.md §5.1).", task.Id));
        }
    }

    /// <summary>Checks WF004, WF010 and WF015 and returns the flows whose endpoints exist.</summary>
    private static List<Flow> CheckFlows(IEnumerable<Flow> flows, Dictionary<string, Node> nodes, List<ValidationError> errors)
    {
        var valid = new List<Flow>();
        foreach (var flow in flows)
        {
            if (!nodes.TryGetValue(flow.Source, out var source) || !nodes.ContainsKey(flow.Target))
            {
                errors.Add(new ValidationError("WF004", "The flow's source or target does not exist.", flow.Id));
                continue;
            }

            if (string.Equals(flow.Source, flow.Target, StringComparison.Ordinal))
            {
                errors.Add(new ValidationError("WF010", "A flow cannot connect a node to itself.", flow.Id));
            }

            if (flow.Branch is not null && source.Type != NodeType.Gateway)
            {
                errors.Add(new ValidationError("WF015", "Only gateway flows may have a branch.", flow.Id));
            }

            valid.Add(flow);
        }

        return valid;
    }

    private static void CheckStartAndEnd(IReadOnlyList<Node> nodes, List<ValidationError> errors)
    {
        var starts = nodes.Where(n => n.Type == NodeType.Start).ToList();
        if (starts.Count == 0)
        {
            errors.Add(new ValidationError("WF001", "The workflow needs exactly one start node."));
        }

        foreach (var extra in starts.Skip(1))
        {
            errors.Add(new ValidationError("WF001", "The workflow needs exactly one start node.", extra.Id));
        }

        if (!nodes.Any(n => n.Type == NodeType.End))
        {
            errors.Add(new ValidationError("WF002", "The workflow needs at least one end node."));
        }
    }

    private static void CheckOutgoingFlows(IEnumerable<Node> nodes, List<Flow> flows, List<ValidationError> errors)
    {
        var outgoing = flows.ToLookup(f => f.Source, StringComparer.Ordinal);
        foreach (var node in nodes)
        {
            var exits = outgoing[node.Id].ToList();
            switch (node.Type)
            {
                case NodeType.Start or NodeType.Task when exits.Count != 1:
                    errors.Add(new ValidationError("WF005", "Start and task nodes need exactly one outgoing flow.", node.Id));
                    break;
                case NodeType.Gateway when exits.Count != 2
                    || exits.Count(f => f.Branch == Branch.True) != 1
                    || exits.Count(f => f.Branch == Branch.False) != 1:
                    errors.Add(new ValidationError("WF006", "A gateway needs exactly one 'true' and one 'false' outgoing flow.", node.Id));
                    break;
                case NodeType.End when exits.Count != 0:
                    errors.Add(new ValidationError("WF007", "End nodes cannot have outgoing flows.", node.Id));
                    break;
            }
        }
    }

    private static void CheckReachability(IReadOnlyList<Node> nodes, List<Flow> flows, List<ValidationError> errors)
    {
        var starts = nodes.Where(n => n.Type == NodeType.Start).ToList();
        if (starts.Count == 1)
        {
            var forward = flows.ToLookup(f => f.Source, f => f.Target, StringComparer.Ordinal);
            var reachable = Traverse([starts[0].Id], forward);
            foreach (var node in nodes.Where(n => !reachable.Contains(n.Id)))
            {
                errors.Add(new ValidationError("WF008", "The node is not reachable from the start node.", node.Id));
            }
        }

        var ends = nodes.Where(n => n.Type == NodeType.End).Select(n => n.Id).ToList();
        if (ends.Count > 0)
        {
            var backward = flows.ToLookup(f => f.Target, f => f.Source, StringComparer.Ordinal);
            var canFinish = Traverse(ends, backward);
            foreach (var node in nodes.Where(n => !canFinish.Contains(n.Id)))
            {
                errors.Add(new ValidationError("WF009", "No end node can be reached from this node.", node.Id));
            }
        }
    }

    private static HashSet<string> Traverse(IEnumerable<string> roots, ILookup<string, string> edges)
    {
        var visited = new HashSet<string>(StringComparer.Ordinal);
        var pending = new Stack<string>(roots);
        while (pending.TryPop(out var id))
        {
            if (!visited.Add(id))
            {
                continue;
            }

            foreach (var next in edges[id])
            {
                pending.Push(next);
            }
        }

        return visited;
    }
}
