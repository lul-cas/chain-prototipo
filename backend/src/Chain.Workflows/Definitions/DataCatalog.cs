using System.Text.Json;
using Chain.Expressions;

namespace Chain.Workflows.Definitions;

/// <summary>What the catalog knows about one data key at a step: its type, whether it is always present, and who may have written it.</summary>
public sealed record KeyState(ExprType Type, bool Definite, IReadOnlyList<string> Sources);

/// <summary>The data a step can see (workflow-definition.md §6.3).</summary>
public sealed class DataState
{
    public DataState(IReadOnlyDictionary<string, KeyState> keys) => Keys = keys;

    public static DataState Empty { get; } = new(new Dictionary<string, KeyState>(StringComparer.Ordinal));

    public IReadOnlyDictionary<string, KeyState> Keys { get; }

    /// <summary>The instance data as an object type, for the type checker.</summary>
    public ExprType AsType() =>
        ExprType.ObjectOf(Keys.ToDictionary(k => k.Key, k => new FieldType(k.Value.Type, k.Value.Definite), StringComparer.Ordinal));

    /// <summary>Data that may come from either state: definite only if definite in both, types merged, sources combined (§6.3).</summary>
    public static DataState Join(DataState a, DataState b)
    {
        ArgumentNullException.ThrowIfNull(a);
        ArgumentNullException.ThrowIfNull(b);
        var keys = new Dictionary<string, KeyState>(StringComparer.Ordinal);
        foreach (var key in a.Keys.Keys.Union(b.Keys.Keys, StringComparer.Ordinal))
        {
            var x = a.Keys.GetValueOrDefault(key);
            var y = b.Keys.GetValueOrDefault(key);
            keys[key] = x is not null && y is not null
                ? new KeyState(ExprType.Merge(x.Type, y.Type), x.Definite && y.Definite, Union(x.Sources, y.Sources))
                : (x ?? y)! with { Definite = false };
        }

        return new DataState(keys);
    }

    internal static IReadOnlyList<string> Union(IEnumerable<string> a, IEnumerable<string> b) =>
        [.. a.Union(b, StringComparer.Ordinal).Order(StringComparer.Ordinal)];

    /// <summary>Structural equality, used to detect the fixpoint.</summary>
    public bool SameAs(DataState other)
    {
        ArgumentNullException.ThrowIfNull(other);
        return Keys.Count == other.Keys.Count && Keys.All(k =>
            other.Keys.TryGetValue(k.Key, out var o)
            && o.Definite == k.Value.Definite
            && o.Type.Equals(k.Value.Type)
            && o.Sources.SequenceEqual(k.Value.Sources, StringComparer.Ordinal));
    }
}

/// <summary>What a sub-workflow step needs to know about its pinned child.</summary>
/// <param name="StartFields">The child start form's accepted fields (null values ignore their input), or null if the child has no start form.</param>
/// <param name="Completion">The child's catalog at completion.</param>
public sealed record SubworkflowContract(IReadOnlyDictionary<string, ExprType?>? StartFields, DataState Completion)
{
    /// <summary>The start form's fields that are certainly required, in form order: a step must map them (WF207, card #203).</summary>
    public IReadOnlyList<string> RequiredStartFields { get; init; } = [];

    /// <summary>The pinned child version's sensitive keys (sensitive-data.md §2), which WF210 maps against.</summary>
    public IReadOnlySet<string> SensitiveKeys { get; init; } = new HashSet<string>(StringComparer.Ordinal);
}

/// <summary>What a pinned form writes (workflow-definition.md §6.2).</summary>
/// <param name="Stored">The top-level fields an accepted submission stores, with their types and presence.</param>
/// <param name="Clearable">The top-level keys an empty answer can remove from the data (forms.md F2, "Empty values").</param>
public sealed record FormContract(IReadOnlyDictionary<string, FieldType> Stored, IReadOnlySet<string> Clearable)
{
    /// <summary>The top-level keys the form marks sensitive (sensitive-data.md §1, card #53).</summary>
    public IReadOnlySet<string> Sensitive { get; init; } = new HashSet<string>(StringComparer.Ordinal);

    /// <summary>The form's top-level value-producing keys, read-only and computed ones included (sensitive-data.md §7).</summary>
    public IReadOnlySet<string> Fields { get; init; } = new HashSet<string>(StringComparer.Ordinal);

    /// <summary>The form's conditions and computed expressions, which the browser evaluates (sensitive-data.md §7).</summary>
    public IReadOnlyList<FormRead> Reads { get; init; } = [];
}

/// <summary>
/// A condition or computed expression of a form field (sensitive-data.md §7): the field's path, its top-level key (null for a
/// display component at the top), whether it is a computed value, and the top-level keys it reads.
/// </summary>
public sealed record FormRead(string Path, string? TopLevelKey, bool Computed, IReadOnlySet<string> Keys);

/// <summary>What an automation step needs to know about its pinned automation version (automation.md §7, card #76).</summary>
/// <param name="Version">The pinned version, which messages name.</param>
/// <param name="Inputs">The declared type of each input (§7.1).</param>
/// <param name="Outputs">The output object (§7.2): each output's type, definite when a succeeded step always has it.</param>
public sealed record AutomationContract(int Version, IReadOnlyDictionary<string, ExprType> Inputs, IReadOnlyDictionary<string, FieldType> Outputs);

/// <summary>Resolved references by node id: each pinned form's contract, each sub-workflow's and each automation's.</summary>
public sealed record StepContracts(
    IReadOnlyDictionary<string, FormContract> Forms,
    IReadOnlyDictionary<string, SubworkflowContract> Subworkflows)
{
    public static StepContracts None { get; } = new(
        new Dictionary<string, FormContract>(StringComparer.Ordinal),
        new Dictionary<string, SubworkflowContract>(StringComparer.Ordinal));

    /// <summary>Each automation step's pinned contract; a step whose automation doesn't resolve has none.</summary>
    public IReadOnlyDictionary<string, AutomationContract> Automations { get; init; } = new Dictionary<string, AutomationContract>(StringComparer.Ordinal);

    /// <summary>
    /// The workflow's sensitive keys, sorted: the union of what its pinned forms mark (sensitive-data.md §2, card #53). A
    /// sub-workflow's keys are its own version's.
    /// </summary>
    public IReadOnlyList<string> SensitiveKeys() =>
        [.. Forms.Values.SelectMany(form => form.Sensitive).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal)];
}

/// <summary>One pickable path of the catalog (workflow-definition.md §6.5).</summary>
public sealed record CatalogEntry(IReadOnlyList<string> Path, string Type, bool Definite, IReadOnlyList<string> Sources);

/// <summary>A step that can write a top-level key, with the type it writes (workflow-engine.md §16.3).</summary>
public sealed record KeyWriter(string NodeId, ExprType Type);

/// <summary>
/// The data catalog of a workflow: which keys each step can see, with types and presence, computed by flow analysis
/// (workflow-definition.md §6), and the type rules WF201–WF206 checked against it.
/// </summary>
public sealed class DataCatalog
{
    private const int MaxIterations = 100_000;

    private readonly Dictionary<string, DataState> _atNode;

    private DataCatalog(
        Dictionary<string, DataState> atNode, DataState atCompletion, IReadOnlyDictionary<string, IReadOnlyList<KeyWriter>> writers,
        IReadOnlyList<ValidationError> typeErrors)
    {
        _atNode = atNode;
        AtCompletion = atCompletion;
        Writers = writers;
        TypeErrors = typeErrors;
    }

    /// <summary>The catalog when the token leaves through an end node.</summary>
    public DataState AtCompletion { get; }

    /// <summary>
    /// Every top-level key that a step reachable from the start can write, with each such step and the type it writes, in
    /// document order: the keys an admin correction may set (workflow-engine.md §16.3).
    /// </summary>
    public IReadOnlyDictionary<string, IReadOnlyList<KeyWriter>> Writers { get; }

    /// <summary>WF201–WF206 findings.</summary>
    public IReadOnlyList<ValidationError> TypeErrors { get; }

    /// <summary>The data the step sees when the token arrives; null for steps the start can't reach.</summary>
    public DataState? At(string nodeId) => _atNode.GetValueOrDefault(nodeId);

    /// <param name="Clears">The write can also remove the key: an empty answer in a form field that can clear it (§6.2).</param>
    private sealed record Write(string Key, ExprType Type, bool Definite, bool Clears = false);

    public static DataCatalog Analyze(WorkflowDocument document, StepContracts contracts)
    {
        ArgumentNullException.ThrowIfNull(document);
        ArgumentNullException.ThrowIfNull(contracts);
        var errors = new List<ValidationError>();
        var nodes = document.Nodes.GroupBy(n => n.Id, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        var successors = document.Flows.Where(f => nodes.ContainsKey(f.Source) && nodes.ContainsKey(f.Target))
            .ToLookup(f => f.Source, f => f.Target, StringComparer.Ordinal);
        var writes = nodes.Values.ToDictionary(n => n.Id, n => WritesOf(n, contracts, errors), StringComparer.Ordinal);

        // Forward flow analysis to a fixpoint (§6.3). Joining into a step's state accumulates every path that reaches it.
        var atNode = new Dictionary<string, DataState>(StringComparer.Ordinal);
        var pending = new Queue<string>();
        foreach (var start in nodes.Values.Where(n => n.Type == NodeType.Start))
        {
            atNode[start.Id] = DataState.Empty; // an instance starts with no data
            pending.Enqueue(start.Id);
        }

        for (var iterations = 0; pending.TryDequeue(out var id); iterations++)
        {
            if (iterations > MaxIterations)
            {
                throw new InvalidOperationException("The data catalog analysis did not converge.");
            }

            var after = Apply(atNode[id], writes[id], id);
            foreach (var next in successors[id])
            {
                var known = atNode.TryGetValue(next, out var current);
                var joined = known ? DataState.Join(current!, after) : after;
                if (!known || !joined.SameAs(current!))
                {
                    atNode[next] = joined;
                    pending.Enqueue(next);
                }
            }
        }

        var completion = nodes.Values.Where(n => n.Type == NodeType.End && atNode.ContainsKey(n.Id))
            .Select(n => atNode[n.Id]).Aggregate((DataState?)null, (acc, s) => acc is null ? s : DataState.Join(acc, s)) ?? DataState.Empty;

        var writers = new Dictionary<string, IReadOnlyList<KeyWriter>>(StringComparer.Ordinal);
        foreach (var node in nodes.Values.Where(n => atNode.ContainsKey(n.Id)))
        {
            CheckNode(node, atNode[node.Id], contracts, errors);
            foreach (var write in writes[node.Id])
            {
                writers[write.Key] = [.. writers.GetValueOrDefault(write.Key) ?? [], new KeyWriter(node.Id, write.Type)];
            }
        }

        return new DataCatalog(atNode, completion, writers, errors);
    }

    /// <summary>
    /// Last write wins (§6.2): a definite write replaces the key; an optional one merges into it and keeps its presence, unless
    /// it can clear the key, which is then optional.
    /// </summary>
    private static DataState Apply(DataState state, List<Write> writes, string nodeId)
    {
        if (writes.Count == 0)
        {
            return state;
        }

        var keys = new Dictionary<string, KeyState>(state.Keys, StringComparer.Ordinal);
        foreach (var write in writes)
        {
            keys[write.Key] = write.Definite || !keys.TryGetValue(write.Key, out var earlier)
                ? new KeyState(write.Type, write.Definite, [nodeId])
                : new KeyState(ExprType.Merge(earlier.Type, write.Type), earlier.Definite && !write.Clears, DataState.Union(earlier.Sources, [nodeId]));
        }

        return new DataState(keys);
    }

    private static List<Write> WritesOf(Node node, StepContracts contracts, List<ValidationError> errors)
    {
        if (contracts.Forms.TryGetValue(node.Id, out var form))
        {
            return [.. form.Stored.Select(f => new Write(f.Key, f.Value.Type, f.Value.Definite, form.Clearable.Contains(f.Key)))];
        }

        if (node.TaskKind == TaskKind.Automation)
        {
            // Outputs are evaluated over the output object when the result is applied (automation.md §7.2); WF205 (card #76).
            var automation = contracts.Automations.GetValueOrDefault(node.Id);
            return Outputs(node, node.Automation?.Outputs, automation is null ? null : ExprType.ObjectOf(automation.Outputs), "WF205", errors);
        }

        if (node.TaskKind != TaskKind.Subprocess)
        {
            return [];
        }

        // Outputs are evaluated over the child's data when it completes (workflow-engine.md §14.1); WF203.
        return Outputs(node, node.Workflow?.Outputs, contracts.Subworkflows.GetValueOrDefault(node.Id)?.Completion.AsType(), "WF203", errors);
    }

    /// <summary>
    /// What an output mapping writes, evaluated over <paramref name="source"/>: the child's data at completion, or an automation's
    /// output object. Each key has its tree's type, and is definite only when the tree never yields missing. Without a source (the
    /// reference doesn't resolve) every path is unknown and every key optional. Trees that don't parse are WF018 or WF109.
    /// </summary>
    private static List<Write> Outputs(
        Node node, IReadOnlyDictionary<string, JsonElement>? outputs, ExprType? source, string code, List<ValidationError> errors)
    {
        var data = source ?? ExprType.Unknown;
        var result = new List<Write>();
        foreach (var (key, tree) in outputs ?? new Dictionary<string, JsonElement>())
        {
            if (Parse(tree) is not { } value)
            {
                continue;
            }

            var issues = new List<TypeIssue>();
            var type = TypeChecker.Infer(value, data, issues);
            errors.AddRange(issues.Select(i => new ValidationError(code, $"Output '{key}': {i.Message}", node.Id)));
            result.Add(new Write(key, type, source is not null && NeverMissing(value, data)));
        }

        return result;
    }

    /// <summary>Whether a mapping always yields a value: a literal, a system value, or a path through definite fields.</summary>
    private static bool NeverMissing(ValueNode value, ExprType data)
    {
        switch (value)
        {
            case LiteralNode or SystemNode:
                return true;
            case PathNode path:
                var current = data;
                foreach (var segment in path.Segments)
                {
                    if (current.Kind != TypeKind.Record || !current.Fields.TryGetValue(segment, out var field) || !field.Definite)
                    {
                        return false;
                    }

                    current = field.Type;
                }

                return true;
            default:
                return false;
        }
    }

    /// <summary>
    /// WF207 (card #203): a step that leaves a certainly required field of the child's start form unmapped would fault with
    /// <c>subprocess_input_invalid</c> every time it runs. A required file field can't be mapped at all (WF206), so the finding says
    /// the child can't be called. Without a start form the child takes any keys (TC-5).
    /// </summary>
    private static void CheckRequiredStartFields(
        Node node, SubworkflowContract? contract, IReadOnlyDictionary<string, JsonElement> inputs, List<ValidationError> errors)
    {
        if (contract?.StartFields is not { } startFields)
        {
            return;
        }

        foreach (var key in contract.RequiredStartFields.Where(key => !inputs.ContainsKey(key)))
        {
            errors.Add(new ValidationError("WF207", startFields.GetValueOrDefault(key) is { Kind: TypeKind.List, Element.Kind: TypeKind.File }
                ? $"The sub-workflow's start form requires the file field '{key}', and a sub-workflow can't receive files, so this step can't start it."
                : $"The sub-workflow's start form requires '{key}', and no input maps it.", node.Id));
        }
    }

    /// <summary>WF201 for automatic gateways, WF202, WF206 and WF207 for sub-workflow inputs, WF204 for automation inputs.</summary>
    private static void CheckNode(Node node, DataState state, StepContracts contracts, List<ValidationError> errors)
    {
        var data = state.AsType();
        if (node.Type == NodeType.Gateway && node.DecisionMode == DecisionMode.Automatic && node.Condition is { ValueKind: JsonValueKind.Object } condition
            && ExpressionParser.ParseCondition(condition) is { IsSuccess: true } parsed)
        {
            errors.AddRange(TypeChecker.Check(parsed.Condition!, data).Select(i => new ValidationError("WF201", $"Condition: {i.Message}", node.Id)));
        }

        if (node.TaskKind == TaskKind.Automation)
        {
            CheckAutomationInputs(node, data, contracts.Automations.GetValueOrDefault(node.Id), errors);
            return;
        }

        if (node.TaskKind != TaskKind.Subprocess || node.Workflow is not { } workflow)
        {
            return;
        }

        var inputs = workflow.Inputs ?? new Dictionary<string, JsonElement>();
        var contract = contracts.Subworkflows.GetValueOrDefault(node.Id);
        var startFields = contract?.StartFields;
        foreach (var (key, tree) in inputs)
        {
            if (Parse(tree) is not { } value)
            {
                continue; // WF018
            }

            var issues = new List<TypeIssue>();
            var type = TypeChecker.Infer(value, data, issues);
            errors.AddRange(issues.Select(i => new ValidationError("WF202", $"Input '{key}': {i.Message}", node.Id)));
            var intoFileField = startFields?.GetValueOrDefault(key) is { Kind: TypeKind.List, Element.Kind: TypeKind.File };
            if (intoFileField || HoldsFiles(type))
            {
                // Files don't pass into sub-workflows (owner decision A, card #69); this takes the place of the field check.
                errors.Add(new ValidationError("WF206", intoFileField
                    ? $"Input '{key}' is a file field of the sub-workflow's start form; a sub-workflow can't receive files."
                    : $"Input '{key}' passes files ({type}); a sub-workflow can't receive files.", node.Id));
                continue;
            }

            if (startFields is null)
            {
                continue; // without a start form, the child takes its inputs as they are
            }

            if (!startFields.TryGetValue(key, out var field))
            {
                errors.Add(new ValidationError("WF202", $"Input '{key}' is not a field of the sub-workflow's start form.", node.Id));
            }
            else if (field is not null && !Fits(field, type))
            {
                errors.Add(new ValidationError("WF202", $"Input '{key}': the start form field takes {field}, not {type}.", node.Id));
            }
        }

        CheckRequiredStartFields(node, contract, inputs, errors);
    }

    /// <summary>
    /// WF204 (card #76): each input tree type-checks against the data at the step and, when the automation resolves, its value
    /// fits the input's declared type. A key the version doesn't declare is WF110; trees that don't parse are WF109.
    /// </summary>
    private static void CheckAutomationInputs(Node node, ExprType data, AutomationContract? automation, List<ValidationError> errors)
    {
        foreach (var (key, tree) in node.Automation?.Inputs ?? new Dictionary<string, JsonElement>())
        {
            if (Parse(tree) is not { } value)
            {
                continue;
            }

            var issues = new List<TypeIssue>();
            var type = TypeChecker.Infer(value, data, issues);
            errors.AddRange(issues.Select(i => new ValidationError("WF204", $"Input '{key}': {i.Message}", node.Id)));
            if (automation is not null && automation.Inputs.TryGetValue(key, out var declared) && !FitsInput(declared, type))
            {
                errors.Add(new ValidationError("WF204", $"Input '{key}': automation version {automation.Version} takes {declared}, not {type}.", node.Id));
            }
        }
    }

    /// <summary>
    /// Values an automation input accepts (workflow-definition.md §6.4), as the check at dispatch does (automation.md §7.1):
    /// temporal values are sent as ISO text, text may stand for a temporal value (TC-4), and a file is sent as an object.
    /// </summary>
    private static bool FitsInput(ExprType input, ExprType value)
    {
        if (input.IsUnknown || value.IsUnknown)
        {
            return true;
        }

        return input.Kind switch
        {
            TypeKind.Text => value.Kind == TypeKind.Text || value.IsTemporal,
            TypeKind.Date or TypeKind.DateTime or TypeKind.Time => value.Kind == input.Kind || value.Kind == TypeKind.Text,
            TypeKind.Record => value.Kind is TypeKind.Record or TypeKind.File,
            TypeKind.List => value.Kind == TypeKind.List && FitsInput(input.Element!, value.Element!),
            _ => value.Kind == input.Kind,
        };
    }

    /// <summary>Whether values of the type carry files: a file, or a list or object holding one at any depth (WF206).</summary>
    private static bool HoldsFiles(ExprType type) => type.Kind switch
    {
        TypeKind.File => true,
        TypeKind.List => HoldsFiles(type.Element!),
        TypeKind.Record => type.Fields.Values.Any(field => HoldsFiles(field.Type)),
        _ => false,
    };

    /// <summary>Values a start-form field accepts (workflow-definition.md §6.4); temporal values are sent as ISO text.</summary>
    private static bool Fits(ExprType field, ExprType value)
    {
        if (field.IsUnknown || value.IsUnknown)
        {
            return true;
        }

        return field.Kind switch
        {
            TypeKind.Text => value.Kind == TypeKind.Text || value.IsTemporal,
            TypeKind.Date or TypeKind.DateTime or TypeKind.Time => value.Kind == field.Kind || value.Kind == TypeKind.Text,
            TypeKind.List => value.Kind == TypeKind.List && Fits(field.Element!, value.Element!),
            _ => value.Kind == field.Kind,
        };
    }

    private static ValueNode? Parse(JsonElement tree) => ExpressionParser.ParseValue(tree) is { IsSuccess: true } parsed ? parsed.Value : null;

    /// <summary>Flattens a state into pickable paths, sorted (§6.5).</summary>
    public static IReadOnlyList<CatalogEntry> Entries(DataState state)
    {
        ArgumentNullException.ThrowIfNull(state);
        var entries = new List<CatalogEntry>();
        foreach (var (key, value) in state.Keys)
        {
            Flatten([key], value.Type, value.Definite, 0, value.Sources, entries);
        }

        return [.. entries.OrderBy(e => string.Join('\u0001', e.Path), StringComparer.Ordinal)];
    }

    private static void Flatten(List<string> path, ExprType type, bool definite, int lists, IReadOnlyList<string> sources, List<CatalogEntry> entries)
    {
        var shown = type;
        for (var i = 0; i < lists; i++)
        {
            shown = ExprType.ListOf(shown);
        }

        entries.Add(new CatalogEntry([.. path], shown.ToString(), definite, sources));
        if (type.Kind == TypeKind.Record)
        {
            foreach (var (name, field) in type.Fields)
            {
                Flatten([.. path, name], field.Type, definite && field.Definite, lists, sources, entries);
            }
        }
        else if (type.Kind == TypeKind.List && type.Element!.Kind == TypeKind.Record)
        {
            foreach (var (name, field) in type.Element.Fields)
            {
                Flatten([.. path, "[]", name], field.Type, false, lists + 1, sources, entries);
            }
        }
    }
}
