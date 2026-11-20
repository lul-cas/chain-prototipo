using System.Text.Json;
using Chain.Expressions;

namespace Chain.Workflows.Definitions;

/// <summary>
/// The publish rules of sensitive data (sensitive-data.md §7, card #53): WF208 browser expressions, WF209 computed fields and
/// WF210 data flow. A key is sensitive when the version would record it (§2): the union of what its pinned forms mark.
/// </summary>
public static class SensitiveRules
{
    public static IReadOnlyList<ValidationError> Check(WorkflowDocument document, StepContracts contracts)
    {
        ArgumentNullException.ThrowIfNull(document);
        ArgumentNullException.ThrowIfNull(contracts);
        var sensitive = contracts.SensitiveKeys().ToHashSet(StringComparer.Ordinal);
        var errors = new List<ValidationError>();
        foreach (var node in document.Nodes.DistinctBy(n => n.Id))
        {
            if (contracts.Forms.TryGetValue(node.Id, out var form))
            {
                CheckForm(node.Id, form, sensitive, errors);
            }

            if (node.Workflow is { } workflow && contracts.Subworkflows.TryGetValue(node.Id, out var child))
            {
                CheckMappings(node.Id, workflow.Inputs, from: sensitive, into: child.SensitiveKeys, "the sub-workflow", errors);
                CheckMappings(node.Id, workflow.Outputs, from: child.SensitiveKeys, into: sensitive, "this workflow", errors);
            }
        }

        return errors;
    }

    private static void CheckForm(string nodeId, FormContract form, HashSet<string> sensitive, List<ValidationError> errors)
    {
        foreach (var read in form.Reads)
        {
            foreach (var key in read.Keys.Where(key => sensitive.Contains(key) && !form.Fields.Contains(key)).Order(StringComparer.Ordinal))
            {
                errors.Add(new ValidationError("WF208",
                    $"'{read.Path}' reads the sensitive key '{key}', which isn't a field of this form, so the browser can't evaluate it.", nodeId));
            }

            if (read.Computed && read.Keys.Any(sensitive.Contains) && (read.TopLevelKey is null || !sensitive.Contains(read.TopLevelKey)))
            {
                errors.Add(new ValidationError("WF209", $"The computed field '{read.Path}' reads a sensitive key, so it must be sensitive itself.", nodeId));
            }
        }
    }

    /// <summary>WF210: a mapping that reads a key sensitive on its side may only go into a key sensitive on the other side.</summary>
    private static void CheckMappings(
        string nodeId, IReadOnlyDictionary<string, JsonElement>? mappings, IReadOnlySet<string> from, IReadOnlySet<string> into, string target,
        List<ValidationError> errors)
    {
        foreach (var (key, value) in mappings ?? new Dictionary<string, JsonElement>())
        {
            if (ExpressionParser.ParseValue(value) is { IsSuccess: true } parsed && ExpressionReads.Keys(parsed.Value!).Any(from.Contains) && !into.Contains(key))
            {
                errors.Add(new ValidationError("WF210", $"The mapping into '{key}' carries a sensitive value, but '{key}' isn't sensitive in {target}.", nodeId));
            }
        }
    }
}
