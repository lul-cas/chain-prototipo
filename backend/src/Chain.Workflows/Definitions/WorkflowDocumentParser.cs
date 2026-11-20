using System.Text.Json;
using System.Text.Json.Serialization;
using Chain.SharedKernel;

namespace Chain.Workflows.Definitions;

/// <summary>Result of parsing untrusted workflow JSON: either a document or a single <c>WF000</c> error.</summary>
public sealed record ParseResult(WorkflowDocument? Document, ValidationError? Error)
{
    public bool IsSuccess => Document is not null;
}

/// <summary>
/// Parses workflow definition JSON (schemaVersion 1). The input is untrusted: unknown properties,
/// unknown enum values, numeric enums, missing required fields, nulls and text PostgreSQL cannot store
/// (the NUL character, or an unpaired surrogate, anywhere in the document; <see cref="ClientText"/>) are
/// rejected with <c>WF000</c>.
/// </summary>
public static class WorkflowDocumentParser
{
    public const int SupportedSchemaVersion = 1;
    private const string MalformedCode = "WF000";

    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        RespectNullableAnnotations = true,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase, allowIntegerValues: false) },
    };

    public static ParseResult Parse(string json)
    {
        ArgumentNullException.ThrowIfNull(json);

        WorkflowDocument? document;
        try
        {
            document = JsonSerializer.Deserialize<WorkflowDocument>(json, Options);
        }
        catch (JsonException ex)
        {
            return Malformed(ex.Path is null ? "The document is not valid workflow JSON." : $"Invalid value at '{ex.Path}'.");
        }

        if (document is null)
        {
            return Malformed("The document is empty.");
        }

        if (document.SchemaVersion != SupportedSchemaVersion)
        {
            return Malformed($"Unsupported schemaVersion {document.SchemaVersion}; expected {SupportedSchemaVersion}.");
        }

        if (document.Lanes.Contains(null!) || document.Nodes.Contains(null!) || document.Flows.Contains(null!))
        {
            return Malformed("Collections must not contain null elements.");
        }

        return ClientText.IsStorableJson(json) ? new ParseResult(document, null) : Malformed(ClientText.UnstorableMessage);
    }

    private static ParseResult Malformed(string message) => new(null, new ValidationError(MalformedCode, message));
}
