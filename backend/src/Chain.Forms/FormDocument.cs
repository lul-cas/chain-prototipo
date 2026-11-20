using System.Text.Json;
using System.Text.Json.Serialization;
using Chain.SharedKernel;

namespace Chain.Forms;

// Chain form schema, schemaVersion 1 (ADR-0009; forms.md §F1).

public enum ComponentType
{
    Heading, Paragraph, Separator,
    Text, Textarea, Number, Checkbox, Select, Radio, Checklist, Date, Time, Datetime, File,
    Group, DynamicList, Computed,
}

public sealed record FormDocument
{
    public required int SchemaVersion { get; init; }
    public required IReadOnlyList<FormComponent> Components { get; init; }

    /// <summary>
    /// The keys this form marks sensitive, sorted: its top-level value-producing fields with the flag, files excepted. A flag
    /// <see cref="FormValidator"/> refuses (FM009, FM010) marks nothing (sensitive-data.md §1, card #53).
    /// </summary>
    public IReadOnlyList<string> SensitiveKeys() =>
        [.. Components
            .Where(component => component is { Sensitive: true, ProducesValue: true, Key: not null } && component.Type != ComponentType.File)
            .Select(component => component.Key!)
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)];
}

public sealed record FormComponent
{
    public required ComponentType Type { get; init; }
    public string? Key { get; init; }
    public string? Label { get; init; }

    /// <summary>Text of display components (heading, paragraph).</summary>
    public string? Text { get; init; }

    /// <summary>Help text, shown as the field's hint (forms.md F1, FM012; card #234).</summary>
    public string? Description { get; init; }

    public string? Placeholder { get; init; }
    public bool ReadOnly { get; init; }

    /// <summary>Hidden from callers who may not see it (sensitive-data.md §1); top-level value-producing fields only.</summary>
    public bool Sensitive { get; init; }
    public FieldValidation? Validate { get; init; }
    public IReadOnlyList<FieldOption>? Options { get; init; }

    /// <summary>Children of groups and dynamic lists.</summary>
    public IReadOnlyList<FormComponent>? Components { get; init; }

    /// <summary>ADR-0003 condition trees; evaluated from increment F2.</summary>
    public JsonElement? VisibleWhen { get; init; }

    public JsonElement? RequiredWhen { get; init; }

    /// <summary>ADR-0003 expression of a computed field; evaluated from increment F2.</summary>
    public JsonElement? Expression { get; init; }

    [JsonIgnore]
    public bool ProducesValue => Type is not (ComponentType.Heading or ComponentType.Paragraph or ComponentType.Separator);

    [JsonIgnore]
    public bool IsContainer => Type is ComponentType.Group or ComponentType.DynamicList;
}

public sealed record FieldValidation
{
    public bool Required { get; init; }
    public int? MinLength { get; init; }
    public int? MaxLength { get; init; }

    /// <summary>A number for number fields; a date bound (ISO text or <c>{ system, offset }</c>) for date and time fields.</summary>
    public JsonElement? Min { get; init; }

    public JsonElement? Max { get; init; }
    public int? DecimalDigits { get; init; }
    public decimal? Step { get; init; }
    public string? Format { get; init; }
    public string? Pattern { get; init; }
    public int? MinSelected { get; init; }
    public int? MaxSelected { get; init; }
    public int? MinRows { get; init; }
    public int? MaxRows { get; init; }
    public int? MaxFiles { get; init; }
    public IReadOnlyList<string>? Accept { get; init; }
}

public sealed record FieldOption
{
    public required string Value { get; init; }
    public required string Label { get; init; }
}

/// <summary>A structural problem in a form document (FM000–FM007).</summary>
public sealed record FormIssue(string Code, string Message, string? Path = null);

/// <summary>A submission error for the field at <see cref="Key"/> (dotted path; list rows as <c>name[i]</c>).</summary>
public sealed record FieldError(string Key, string Code);

public sealed record FormParseResult(FormDocument? Document, FormIssue? Error)
{
    public bool IsSuccess => Document is not null;
}

/// <summary>
/// Parses untrusted form JSON. Unknown properties or types, numeric enums, missing fields and text PostgreSQL cannot store (the
/// NUL character, or an unpaired surrogate, anywhere in the document; <see cref="ClientText"/>) are FM000.
/// </summary>
public static class FormDocumentParser
{
    public const int SupportedSchemaVersion = 1;

    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        RespectNullableAnnotations = true,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase, allowIntegerValues: false) },
    };

    public static FormParseResult Parse(string json)
    {
        ArgumentNullException.ThrowIfNull(json);
        FormDocument? document;
        try
        {
            document = JsonSerializer.Deserialize<FormDocument>(json, Options);
        }
        catch (JsonException ex)
        {
            return Malformed(ex.Path is null ? "The document is not valid form JSON." : $"Invalid value at '{ex.Path}'.");
        }

        if (document is null)
        {
            return Malformed("The document is empty.");
        }

        if (document.SchemaVersion != SupportedSchemaVersion)
        {
            return Malformed($"Unsupported schemaVersion {document.SchemaVersion}; expected {SupportedSchemaVersion}.");
        }

        if (HasNulls(document.Components))
        {
            return Malformed("Collections must not contain null elements.");
        }

        return ClientText.IsStorableJson(json) ? new FormParseResult(document, null) : Malformed(ClientText.UnstorableMessage);
    }

    private static bool HasNulls(IReadOnlyList<FormComponent>? components) =>
        components is not null && components.Any(c => c is null || HasNulls(c.Components) || (c.Options?.Contains(null!) ?? false));

    private static FormParseResult Malformed(string message) => new(null, new FormIssue("FM000", message));
}
