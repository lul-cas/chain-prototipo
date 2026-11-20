using Chain.Expressions;

namespace Chain.Forms;

/// <summary>The data contract of a form as the workflow data catalog sees it (workflow-definition.md §6.1, §6.2, §6.4).</summary>
public static class FormDataTypes
{
    /// <summary>
    /// The top-level keys an accepted submission stores, with their types. A field is definite when it is always stored:
    /// unconditionally visible, not read-only or computed, and required (or a group, which is always stored when visible).
    /// </summary>
    public static IReadOnlyDictionary<string, FieldType> Stored(FormDocument form)
    {
        ArgumentNullException.ThrowIfNull(form);
        return Fields(form.Components, conditional: false);
    }

    /// <summary>
    /// The top-level keys an accepted submission can remove from the request's data (workflow-definition.md §6.2), because an
    /// empty value in a visible, editable field clears it (forms.md F2, "Empty values").
    /// </summary>
    public static IReadOnlySet<string> Clearable(FormDocument form)
    {
        ArgumentNullException.ThrowIfNull(form);
        return Valued(form.Components).Where(CanClear).Select(field => field.Key!).ToHashSet(StringComparer.Ordinal);
    }

    /// <summary>
    /// Whether an empty answer in the field can remove its key. Every field can, except a required one (once visible, its empty
    /// value is rejected), a group (always written when visible), and read-only and computed fields (neither ever writes null).
    /// Visibility doesn't matter: a hidden field changes nothing.
    /// </summary>
    private static bool CanClear(FormComponent field) =>
        !field.ReadOnly && field.Type is not (ComponentType.Group or ComponentType.Computed) && !(field.Validate?.Required ?? false);

    /// <summary>
    /// The top-level keys a submission accepts, with the type of value each one takes; null for fields that ignore the value
    /// (computed and read-only fields).
    /// </summary>
    public static IReadOnlyDictionary<string, ExprType?> Accepted(FormDocument form)
    {
        ArgumentNullException.ThrowIfNull(form);
        var accepted = new Dictionary<string, ExprType?>(StringComparer.Ordinal);
        foreach (var field in Valued(form.Components))
        {
            accepted[field.Key!] = field.ReadOnly || field.Type == ComponentType.Computed ? null : TypeOf(field, conditional: false);
        }

        return accepted;
    }

    /// <summary>
    /// The top-level keys a submission must always hold, in form order: fields with <c>validate.required</c> and no
    /// <c>visibleWhen</c> that aren't read-only (forms.md F1, F2). <c>requiredWhen</c> doesn't matter then, and groups, lists and
    /// computed fields can't be required (FM004). A sub-workflow step must map them (WF207, workflow-definition.md §6.4).
    /// </summary>
    public static IReadOnlyList<string> AlwaysRequired(FormDocument form)
    {
        ArgumentNullException.ThrowIfNull(form);
        return [.. Valued(form.Components)
            .Where(field => (field.Validate?.Required ?? false) && field.VisibleWhen is null && !field.ReadOnly)
            .Select(field => field.Key!)];
    }

    /// <summary>The form's top-level value-producing keys: the fields a task's prefill can hold (sensitive-data.md §4, §7).</summary>
    public static IReadOnlySet<string> TopLevelKeys(FormDocument form)
    {
        ArgumentNullException.ThrowIfNull(form);
        return form.Components.Where(c => c.ProducesValue && c.Key is not null).Select(c => c.Key!).ToHashSet(StringComparer.Ordinal);
    }

    /// <summary>
    /// Each condition (<c>visibleWhen</c>, <c>requiredWhen</c>) and computed expression of the form, with the top-level keys it reads,
    /// which the browser evaluates (sensitive-data.md §7). Expressions that don't parse are left to FM007 and FM008.
    /// </summary>
    public static IReadOnlyList<FieldRead> Reads(FormDocument form)
    {
        ArgumentNullException.ThrowIfNull(form);
        var reads = new List<FieldRead>();
        Collect(form.Components, prefix: null, topLevelKey: null, reads);
        return reads;
    }

    private static void Collect(IReadOnlyList<FormComponent> components, string? prefix, string? topLevelKey, List<FieldRead> reads)
    {
        for (var i = 0; i < components.Count; i++)
        {
            var component = components[i];
            var path = component.Key is { } key ? (prefix is null ? key : $"{prefix}.{key}") : $"{(prefix is null ? "components" : $"{prefix}.components")}[{i}]";
            var top = topLevelKey ?? (component.ProducesValue ? component.Key : null);
            foreach (var condition in new[] { component.VisibleWhen, component.RequiredWhen })
            {
                if (condition is { } tree && ExpressionParser.ParseCondition(tree) is { IsSuccess: true } parsed)
                {
                    reads.Add(new FieldRead(path, top, Computed: false, ExpressionReads.Keys(parsed.Condition!).ToHashSet(StringComparer.Ordinal)));
                }
            }

            if (component.Type == ComponentType.Computed && component.Expression is { } expression
                && ExpressionParser.ParseValue(expression) is { IsSuccess: true } value)
            {
                reads.Add(new FieldRead(path, top, Computed: true, ExpressionReads.Keys(value.Value!).ToHashSet(StringComparer.Ordinal)));
            }

            if (component.Components is { Count: > 0 } children)
            {
                Collect(children, component.Key ?? path, top, reads);
            }
        }
    }

    private static IEnumerable<FormComponent> Valued(IReadOnlyList<FormComponent>? components) =>
        (components ?? []).Where(c => c.ProducesValue && c.Key is not null);

    /// <summary>Field types of one level; <paramref name="conditional"/> when an enclosing group has a <c>visibleWhen</c>.</summary>
    private static Dictionary<string, FieldType> Fields(IReadOnlyList<FormComponent>? components, bool conditional)
    {
        var fields = new Dictionary<string, FieldType>(StringComparer.Ordinal);
        foreach (var field in Valued(components))
        {
            fields[field.Key!] = new FieldType(TypeOf(field, conditional), !conditional && IsDefinite(field));
        }

        return fields;
    }

    private static bool IsDefinite(FormComponent field) =>
        field.VisibleWhen is null
        && !field.ReadOnly
        && field.Type is not (ComponentType.Computed or ComponentType.DynamicList)
        && (field.Type == ComponentType.Group || (field.Validate?.Required ?? false));

    private static ExprType TypeOf(FormComponent field, bool conditional) => field.Type switch
    {
        ComponentType.Text or ComponentType.Textarea or ComponentType.Select or ComponentType.Radio => ExprType.Text,
        ComponentType.Number => ExprType.Number,
        ComponentType.Checkbox => ExprType.Boolean,
        ComponentType.Date => ExprType.Date,
        ComponentType.Time => ExprType.Time,
        ComponentType.Datetime => ExprType.DateTime,
        ComponentType.Checklist => ExprType.ListOf(ExprType.Text),
        ComponentType.File => ExprType.ListOf(ExprType.File),
        ComponentType.Group => ExprType.ObjectOf(Fields(field.Components, conditional || field.VisibleWhen is not null)),
        ComponentType.DynamicList => ExprType.ListOf(ExprType.ObjectOf(Fields(field.Components, conditional || field.VisibleWhen is not null))),
        ComponentType.Computed => Computed(field),
        _ => ExprType.Unknown,
    };

    /// <summary>A computed field's type, inferred from its expression with every path unknown (§6.1).</summary>
    private static ExprType Computed(FormComponent field)
    {
        if (field.Expression is not { } expression || ExpressionParser.ParseValue(expression) is not { IsSuccess: true } parsed)
        {
            return ExprType.Unknown;
        }

        var type = TypeChecker.Infer(parsed.Value!, ExprType.Unknown, new List<TypeIssue>());
        return type.IsScalar ? type : ExprType.Unknown; // lists and objects can't be stored by a computed field
    }
}

/// <summary>
/// A condition or computed expression of a form field (sensitive-data.md §7): the field's path, its top-level key (its own, or its
/// group's or list's; null for a display component at the top), whether it is a computed value, and the top-level keys it reads.
/// </summary>
public sealed record FieldRead(string Path, string? TopLevelKey, bool Computed, IReadOnlySet<string> Keys);
