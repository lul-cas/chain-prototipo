using System.Text.Json;
using System.Text.RegularExpressions;

namespace Chain.Forms;

/// <summary>Structural rules FM001–FM011 for form documents (forms.md §F1). Returns every finding.</summary>
public static partial class FormValidator
{
    public const int MaxComponents = 200;
    public const int MaxDepth = 3;
    public const int MaxOptions = 200;
    public const int MaxDescriptionLength = 500;

    public static IReadOnlyList<FormIssue> Validate(FormDocument document)
    {
        ArgumentNullException.ThrowIfNull(document);
        var issues = new List<FormIssue>();

        if (Count(document.Components) > MaxComponents || Depth(document.Components) > MaxDepth)
        {
            issues.Add(new FormIssue("FM006", $"Forms are limited to {MaxComponents} components and nesting depth {MaxDepth}."));
        }

        CheckLevel(document.Components, prefix: null, issues);
        return issues;
    }

    private static void CheckLevel(IReadOnlyList<FormComponent> components, string? prefix, List<FormIssue> issues)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < components.Count; i++)
        {
            var component = components[i];
            var path = component.Key is { } key ? Join(prefix, key) : $"{Join(prefix, "components")}[{i}]";

            if (component.ProducesValue)
            {
                if (component.Key is null || !KeyFormat().IsMatch(component.Key))
                {
                    issues.Add(new FormIssue("FM001", "Fields need a key: a letter followed by up to 63 letters, digits or underscores.", path));
                }
                else if (!seen.Add(component.Key))
                {
                    issues.Add(new FormIssue("FM002", $"The key '{component.Key}' is used more than once at this level.", path));
                }

                if (string.IsNullOrWhiteSpace(component.Label))
                {
                    issues.Add(new FormIssue("FM011", "Fields need a label.", path)); // form-designer.md FD16
                }

                if (component.Description is { Length: > MaxDescriptionLength })
                {
                    issues.Add(new FormIssue("FM012", $"A description has at most {MaxDescriptionLength} characters.", path));
                }
            }
            else if (component.Description is not null)
            {
                issues.Add(new FormIssue("FM012", "Only fields have a description; a heading or a paragraph shows its text.", path));
            }

            CheckOptions(component, path, issues);
            CheckValidation(component, path, issues);
            CheckSensitive(component, nested: prefix is not null, path, issues);

            if (component.Type == ComponentType.Computed
                && (component.Expression is not { ValueKind: JsonValueKind.Object } expression || !Chain.Expressions.ExpressionParser.ParseValue(expression).IsSuccess))
            {
                issues.Add(new FormIssue("FM007", "Computed fields need a valid expression (expression-language.md §5.1).", path));
            }

            foreach (var condition in new[] { component.VisibleWhen, component.RequiredWhen })
            {
                if (condition is { } tree && !Chain.Expressions.ExpressionParser.ParseCondition(tree).IsSuccess)
                {
                    issues.Add(new FormIssue("FM008", "Conditions must be valid condition trees (expression-language.md §5.1).", path));
                }
            }

            if (component.IsContainer != (component.Components is not null) || component.Components is { Count: 0 })
            {
                issues.Add(new FormIssue("FM004", "Groups and lists need child components; other components cannot have them.", path));
            }

            if (component.Components is { Count: > 0 } children)
            {
                CheckLevel(children, path, issues); // the full path, so a problem names every ancestor (#237)
            }
        }
    }

    /// <summary>FM009 and FM010: only a top-level value-producing field, not a file, can be sensitive (sensitive-data.md §1).</summary>
    private static void CheckSensitive(FormComponent component, bool nested, string path, List<FormIssue> issues)
    {
        if (!component.Sensitive)
        {
            return;
        }

        if (nested || !component.ProducesValue)
        {
            issues.Add(new FormIssue("FM009", "Only top-level fields, groups and lists can be sensitive.", path));
        }
        else if (component.Type == ComponentType.File)
        {
            issues.Add(new FormIssue("FM010", "File fields can't be sensitive.", path));
        }
    }

    private static void CheckOptions(FormComponent component, string path, List<FormIssue> issues)
    {
        var isChoice = component.Type is ComponentType.Select or ComponentType.Radio or ComponentType.Checklist;
        if (!isChoice)
        {
            if (component.Options is not null)
            {
                issues.Add(new FormIssue("FM004", "Only select, radio and checklist fields have options.", path));
            }

            return;
        }

        var options = component.Options ?? [];
        if (options.Count is 0 or > MaxOptions || options.Select(o => o.Value).Distinct(StringComparer.Ordinal).Count() != options.Count)
        {
            issues.Add(new FormIssue("FM003", $"Choice fields need 1–{MaxOptions} options with unique values.", path));
        }
    }

    private static void CheckValidation(FormComponent component, string path, List<FormIssue> issues)
    {
        if (component.Validate is not { } v)
        {
            return;
        }

        void Problem(string message) => issues.Add(new FormIssue("FM004", message, path));

        var type = component.Type;
        var isText = type is ComponentType.Text or ComponentType.Textarea;
        var isNumber = type == ComponentType.Number;
        var isDate = type is ComponentType.Date or ComponentType.Time or ComponentType.Datetime;

        var isFile = type == ComponentType.File;
        if (v.Required && !(isText || isNumber || isDate || isFile || type is ComponentType.Checkbox or ComponentType.Select or ComponentType.Radio or ComponentType.Checklist))
        {
            Problem("This component cannot be required.");
        }

        if ((v.MaxFiles is not null || v.Accept is not null) && !isFile)
        {
            Problem("File limits apply to file fields only.");
        }

        if (isFile && v.MaxFiles is < 1 or > FileRules.MaxFiles)
        {
            Problem($"A file field accepts at most {FileRules.MaxFiles} files.");
        }

        if (isFile && v.Accept is { } accept
            && (accept.Count == 0 || accept.Distinct(StringComparer.Ordinal).Count() != accept.Count || accept.Any(item => !FileRules.IsAllowedContentType(item))))
        {
            Problem("accept may only list types from the global allowlist.");
        }

        if ((v.MinLength is not null || v.MaxLength is not null || v.Format is not null || v.Pattern is not null) && !isText)
        {
            Problem("Length, format and pattern apply to text fields only.");
        }

        if ((v.DecimalDigits is not null || v.Step is not null) && !isNumber)
        {
            Problem("Decimal digits and step apply to number fields only.");
        }

        if ((v.MinSelected is not null || v.MaxSelected is not null) && type != ComponentType.Checklist)
        {
            Problem("Selection limits apply to checklists only.");
        }

        if ((v.MinRows is not null || v.MaxRows is not null) && type != ComponentType.DynamicList)
        {
            Problem("Row limits apply to dynamic lists only.");
        }

        if ((v.Min is not null || v.Max is not null) && !(isNumber || isDate))
        {
            Problem("Min and max apply to number and date fields only.");
        }

        CheckRange(v.MinLength, v.MaxLength, Problem);
        CheckRange(v.MinSelected, v.MaxSelected, Problem);
        CheckRange(v.MinRows, v.MaxRows, Problem);

        if (v.DecimalDigits is < 0 or > 10)
        {
            Problem("Decimal digits must be between 0 and 10.");
        }

        if (v.Step is <= 0)
        {
            Problem("Step must be positive.");
        }

        if (v.Format is { } format && !Formats.Known.Contains(format))
        {
            Problem($"Unknown format '{format}'.");
        }

        if (isNumber)
        {
            decimal? min = null, max = null;
            if (v.Min is { } minElement && !IsDecimal(minElement))
            {
                Problem("Min must be a number.");
            }
            else if (v.Min is { } m)
            {
                min = m.GetDecimal();
            }

            if (v.Max is { } maxElement && !IsDecimal(maxElement))
            {
                Problem("Max must be a number.");
            }
            else if (v.Max is { } x)
            {
                max = x.GetDecimal();
            }

            if (min > max)
            {
                Problem("Min cannot be greater than max.");
            }
        }

        if (isDate)
        {
            if ((v.Min is { } dmin && !DateBounds.IsValid(dmin, type)) || (v.Max is { } dmax && !DateBounds.IsValid(dmax, type)))
            {
                Problem("Date bounds must be ISO values or { system, offset } matching the field type.");
            }
        }

        if (v.Pattern is { } pattern && Patterns.Check(pattern) is { } reason)
        {
            issues.Add(new FormIssue("FM005", reason, path));
        }
    }

    private static void CheckRange(int? min, int? max, Action<string> problem)
    {
        if (min < 0 || max < 0)
        {
            problem("Limits cannot be negative.");
        }

        if (min > max)
        {
            problem("The minimum cannot be greater than the maximum.");
        }
    }

    // TryGetDecimal throws on a value that isn't a number, and a draft's bound can be any JSON (#238).
    private static bool IsDecimal(JsonElement element) => element.ValueKind == JsonValueKind.Number && element.TryGetDecimal(out _);

    private static int Count(IReadOnlyList<FormComponent>? components) =>
        components?.Sum(c => 1 + Count(c.Components)) ?? 0;

    private static int Depth(IReadOnlyList<FormComponent>? components) =>
        components is null ? 0 : components.Select(c => c.IsContainer ? 1 + Depth(c.Components) : 0).DefaultIfEmpty(0).Max();

    private static string Join(string? prefix, string key) => prefix is null ? key : $"{prefix}.{key}";

    [GeneratedRegex(@"^[a-zA-Z][a-zA-Z0-9_]{0,63}\z", RegexOptions.CultureInvariant, 100)] // \z: $ would also match before a trailing newline
    private static partial Regex KeyFormat();
}
