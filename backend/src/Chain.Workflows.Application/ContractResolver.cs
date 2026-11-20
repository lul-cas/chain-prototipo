using Chain.Automations;
using Chain.Expressions;
using Chain.Forms;
using Chain.Workflows.Definitions;
using Chain.Workflows.Modeling;

namespace Chain.Workflows.Application;

/// <summary>
/// Loads the pinned forms, sub-workflows and automations a document references and turns them into the data contracts the
/// catalog needs (workflow-definition.md §6.2, §6.3). Children are analysed on their own, from their pinned versions, to depth 10.
/// Unresolvable references contribute nothing, so they are treated as unknown rather than as errors (those are WF103–WF105).
/// </summary>
internal sealed class ContractResolver(
    Func<Guid, int, CancellationToken, Task<WorkflowVersion?>> findVersion,
    Func<Guid, int, CancellationToken, Task<string?>> formDocument,
    Func<Guid, int, CancellationToken, Task<AutomationDocument?>> automationDocument,
    CancellationToken cancellationToken)
{
    public const int MaxDepth = 10;

    public ContractResolver(IWorkflowStore store, IFormDirectory forms, IAutomationDirectory automations, CancellationToken cancellationToken)
        : this(store.FindVersionAsync, forms.GetVersionDocumentAsync, automations.GetVersionDocumentAsync, cancellationToken)
    {
    }

    private readonly Dictionary<(Guid, int), FormDocument?> _forms = [];
    private readonly Dictionary<(Guid, int), SubworkflowContract?> _children = [];
    private readonly Dictionary<(Guid, int), AutomationContract?> _automations = [];

    /// <param name="formVersion">The form version each node's reference is (or would be) pinned to; likewise the others.</param>
    public async Task<StepContracts> ContractsAsync(
        WorkflowDocument document, Func<Node, int?> formVersion, Func<Node, int?> workflowVersion, Func<Node, int?> automationVersion, int depth)
    {
        var formContracts = new Dictionary<string, FormContract>(StringComparer.Ordinal);
        var children = new Dictionary<string, SubworkflowContract>(StringComparer.Ordinal);
        var automations = new Dictionary<string, AutomationContract>(StringComparer.Ordinal);
        foreach (var node in document.Nodes.DistinctBy(n => n.Id))
        {
            if (await FormAsync(node.Form?.FormId, formVersion(node)) is { } form)
            {
                formContracts[node.Id] = new FormContract(FormDataTypes.Stored(form), FormDataTypes.Clearable(form))
                {
                    Sensitive = form.SensitiveKeys().ToHashSet(StringComparer.Ordinal),
                    Fields = FormDataTypes.TopLevelKeys(form),
                    Reads = [.. FormDataTypes.Reads(form).Select(read => new FormRead(read.Path, read.TopLevelKey, read.Computed, read.Keys))],
                };
            }

            if (node.TaskKind == TaskKind.Subprocess && Guid.TryParse(node.Workflow?.WorkflowId, out var childId)
                && workflowVersion(node) is { } version && await ChildAsync(childId, version, depth + 1) is { } child)
            {
                children[node.Id] = child;
            }

            if (node.TaskKind == TaskKind.Automation && await AutomationAsync(node.Automation?.AutomationId, automationVersion(node)) is { } automation)
            {
                automations[node.Id] = automation;
            }
        }

        return new StepContracts(formContracts, children) { Automations = automations };
    }

    /// <summary>A published version's contract as a sub-workflow (workflow-definition.md §6.5); null when it can't be read.</summary>
    public Task<SubworkflowContract?> SubworkflowAsync(Guid id, int version) => ChildAsync(id, version, 0);

    private async Task<SubworkflowContract?> ChildAsync(Guid id, int version, int depth)
    {
        if (depth > MaxDepth)
        {
            return null;
        }

        if (_children.TryGetValue((id, version), out var known))
        {
            return known;
        }

        SubworkflowContract? contract = null;
        if (await findVersion(id, version, cancellationToken) is { } pinned
            && WorkflowDocumentParser.Parse(pinned.Document) is { IsSuccess: true } parsed)
        {
            var document = parsed.Document!;
            var contracts = await ContractsAsync(document, n => n.Form?.Version, n => n.Workflow?.Version, n => n.Automation?.Version, depth);
            var start = document.Nodes.FirstOrDefault(n => n.Type == NodeType.Start);
            var startForm = await FormAsync(start?.Form?.FormId, start?.Form?.Version);
            contract = new SubworkflowContract(
                startForm is null ? null : FormDataTypes.Accepted(startForm),
                DataCatalog.Analyze(document, contracts).AtCompletion)
            {
                RequiredStartFields = startForm is null ? [] : FormDataTypes.AlwaysRequired(startForm),
                SensitiveKeys = pinned.SensitiveKeys.ToHashSet(StringComparer.Ordinal),
            };
        }

        _children[(id, version)] = contract;
        return contract;
    }

    /// <summary>A pinned automation version's contracts, or null when the reference doesn't resolve; loaded once per version.</summary>
    private async Task<AutomationContract?> AutomationAsync(string? automationId, int? version)
    {
        if (!Guid.TryParse(automationId, out var id) || version is not { } number)
        {
            return null;
        }

        if (!_automations.TryGetValue((id, number), out var contract))
        {
            contract = await automationDocument(id, number, cancellationToken) is { } automation ? Contract(number, automation) : null;
            _automations[(id, number)] = contract;
        }

        return contract;
    }

    /// <summary>
    /// The contracts as the catalog types them (workflow-definition.md §6.1, §6.2, card #76): a succeeded step always has a
    /// <c>status</c> output and every <c>required</c> one (automation.md §7.2), so those are definite.
    /// </summary>
    private static AutomationContract Contract(int version, AutomationDocument automation)
    {
        var inputs = new Dictionary<string, ExprType>(StringComparer.Ordinal);
        foreach (var input in automation.Inputs)
        {
            inputs.TryAdd(input.Key, ContractTypes.ToExprType(input.Type));
        }

        var outputs = new Dictionary<string, FieldType>(StringComparer.Ordinal);
        foreach (var output in automation.Outputs)
        {
            outputs.TryAdd(output.Key, new FieldType(ContractTypes.ToExprType(output.Type), output.Required || output.Source == "status"));
        }

        return new AutomationContract(version, inputs, outputs);
    }

    /// <summary>A pinned form version's document, or null when the reference doesn't resolve; loaded once per version.</summary>
    public async Task<FormDocument?> FormAsync(string? formId, int? version)
    {
        if (!Guid.TryParse(formId, out var id) || version is not { } number)
        {
            return null;
        }

        if (!_forms.TryGetValue((id, number), out var form))
        {
            var json = await formDocument(id, number, cancellationToken);
            form = json is null ? null : FormDocumentParser.Parse(json).Document;
            _forms[(id, number)] = form;
        }

        return form;
    }
}
