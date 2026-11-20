using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Chain.SharedKernel;

namespace Chain.Automations;

// Automation document, schemaVersion 1, kind "http" (automation.md §5.2). Absent fields take their defaults; the published version
// stores them explicitly (AutomationDocumentParser.Normalize).

public sealed record AutomationDocument
{
    public required int SchemaVersion { get; init; }
    public required string Kind { get; init; }
    public IReadOnlyList<AutomationInput> Inputs { get; init; } = [];
    public required AutomationRequest Request { get; init; }
    public required AutomationResponse Response { get; init; }
    public IReadOnlyList<AutomationOutput> Outputs { get; init; } = [];
    public AutomationExecution? Execution { get; init; }
}

/// <summary>A key of the input contract.</summary>
public sealed record AutomationInput
{
    public required string Key { get; init; }
    public required string Type { get; init; }
    public bool Required { get; init; }
}

public sealed record AutomationRequest
{
    private static readonly IReadOnlyDictionary<string, string> None = new Dictionary<string, string>(StringComparer.Ordinal);

    public required string Method { get; init; }

    /// <summary>A destination name; the host is never templated (ADR-0012 Part 2 §2).</summary>
    public required string Destination { get; init; }

    /// <summary>A literal subdomain, required when the destination's host is a <c>*.</c> wildcard.</summary>
    public string? Host { get; init; }

    public required string Path { get; init; }
    public IReadOnlyDictionary<string, string> Query { get; init; } = None;
    public IReadOnlyDictionary<string, string> Headers { get; init; } = None;
    public BasicAuth? Auth { get; init; }
    public RequestBody? Body { get; init; }
}

public sealed record BasicAuth
{
    public required string Type { get; init; }
    public required string Username { get; init; }
    public required string Password { get; init; }
}

/// <summary>A JSON object of the listed inputs, or of every input when <see cref="Keys"/> is absent.</summary>
public sealed record RequestBody
{
    public required string Type { get; init; }
    public IReadOnlyList<string>? Keys { get; init; }
}

public sealed record AutomationResponse
{
    public required string Type { get; init; }
}

/// <summary>A key of the output contract: the HTTP status, or a value read from the parsed body at <see cref="Path"/>.</summary>
public sealed record AutomationOutput
{
    public required string Key { get; init; }
    public required string Type { get; init; }
    public bool Required { get; init; }
    public required string Source { get; init; }

    /// <summary>Property names and array indexes, for <c>source: "body"</c>.</summary>
    public IReadOnlyList<JsonElement>? Path { get; init; }
}

public sealed record AutomationExecution
{
    public int? TimeoutSeconds { get; init; }
    public RetryPolicy? Retry { get; init; }
    public IdempotencyPolicy? Idempotency { get; init; }
    public RedirectPolicy? Redirects { get; init; }
}

public sealed record RetryPolicy
{
    public int? MaxAttempts { get; init; }
    public int? InitialDelaySeconds { get; init; }
}

public sealed record IdempotencyPolicy
{
    public required string Mode { get; init; }
    public string? Header { get; init; }
}

public sealed record RedirectPolicy
{
    public bool Follow { get; init; }
    public int? Max { get; init; }
}

/// <summary>The execution settings with the defaults of automation.md §5.2 applied.</summary>
public sealed record EffectiveExecution(
    int TimeoutSeconds, int MaxAttempts, int InitialDelaySeconds, string IdempotencyMode, string? IdempotencyHeader, bool FollowRedirects, int MaxRedirects)
{
    public const int DefaultTimeoutSeconds = 30;
    public const int DefaultMaxAttempts = 5;
    public const int DefaultInitialDelaySeconds = 5;
    public const string DefaultIdempotencyHeader = "Idempotency-Key";

    public static EffectiveExecution Of(AutomationExecution? execution)
    {
        var mode = execution?.Idempotency?.Mode ?? "header";
        return new(
            execution?.TimeoutSeconds ?? DefaultTimeoutSeconds,
            execution?.Retry?.MaxAttempts ?? DefaultMaxAttempts,
            execution?.Retry?.InitialDelaySeconds ?? DefaultInitialDelaySeconds,
            mode,
            mode == "header" ? execution?.Idempotency?.Header ?? DefaultIdempotencyHeader : execution?.Idempotency?.Header,
            execution?.Redirects?.Follow ?? false,
            execution?.Redirects?.Max ?? 0);
    }
}

/// <summary>A problem in an automation document: <c>AU000</c> when it does not parse, otherwise a rule of §5.3–§5.4.</summary>
public sealed record AutomationIssue(string Code, string Message, string? Path = null);

public sealed record AutomationParseResult(AutomationDocument? Document, AutomationIssue? Error)
{
    public bool IsSuccess => Document is not null;
}

/// <summary>
/// Parses untrusted automation JSON (<c>AU000</c>): known properties only, each once, with the right JSON types; schemaVersion 1;
/// kind <c>http</c>; no null elements in lists or maps; no text PostgreSQL cannot store (the NUL character, or an unpaired surrogate;
/// <see cref="ClientText"/>).
/// </summary>
public static class AutomationDocumentParser
{
    public const int SupportedSchemaVersion = 1;

    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        RespectNullableAnnotations = true,
        AllowDuplicateProperties = false,
    };

    public static AutomationParseResult Parse(string json)
    {
        ArgumentNullException.ThrowIfNull(json);
        AutomationDocument? document;
        try
        {
            document = JsonSerializer.Deserialize<AutomationDocument>(json, Options);
        }
        catch (JsonException ex)
        {
            return Malformed(ex.Path is null or "$" ? "The document is not valid automation JSON." : $"Invalid value at '{ex.Path}'.");
        }

        if (document is null)
        {
            return Malformed("The document is empty.");
        }

        if (document.SchemaVersion != SupportedSchemaVersion)
        {
            return Malformed($"Unsupported schemaVersion {document.SchemaVersion}; expected {SupportedSchemaVersion}.");
        }

        if (document.Kind != "http")
        {
            return Malformed($"Unsupported kind '{document.Kind}'; expected 'http'.");
        }

        if (HasNulls(document))
        {
            return Malformed("Lists and maps must not contain null elements.");
        }

        return ClientText.IsStorableJson(json) ? new AutomationParseResult(document, null) : Malformed(ClientText.UnstorableMessage);
    }

    /// <summary>The document as a published version stores it: every default explicit, so the content hash covers them (§5.2).</summary>
    public static string Normalize(AutomationDocument document)
    {
        ArgumentNullException.ThrowIfNull(document);
        var request = document.Request;
        var execution = EffectiveExecution.Of(document.Execution);

        var requestNode = new JsonObject { ["method"] = request.Method, ["destination"] = request.Destination };
        if (request.Host is { } host)
        {
            requestNode["host"] = host;
        }

        requestNode["path"] = request.Path;
        requestNode["query"] = Map(request.Query);
        requestNode["headers"] = Map(request.Headers);
        requestNode["auth"] = request.Auth is { } auth
            ? new JsonObject { ["type"] = auth.Type, ["username"] = auth.Username, ["password"] = auth.Password }
            : null;
        requestNode["body"] = request.Body is { } body ? Body(body) : null;

        var idempotency = new JsonObject { ["mode"] = execution.IdempotencyMode };
        if (execution.IdempotencyMode == "header")
        {
            idempotency["header"] = execution.IdempotencyHeader;
        }

        return new JsonObject
        {
            ["schemaVersion"] = document.SchemaVersion,
            ["kind"] = document.Kind,
            ["inputs"] = new JsonArray([.. document.Inputs.Select(input => (JsonNode)new JsonObject
            {
                ["key"] = input.Key, ["type"] = input.Type, ["required"] = input.Required,
            })]),
            ["request"] = requestNode,
            ["response"] = new JsonObject { ["type"] = document.Response.Type },
            ["outputs"] = new JsonArray([.. document.Outputs.Select(Output)]),
            ["execution"] = new JsonObject
            {
                ["timeoutSeconds"] = execution.TimeoutSeconds,
                ["retry"] = new JsonObject { ["maxAttempts"] = execution.MaxAttempts, ["initialDelaySeconds"] = execution.InitialDelaySeconds },
                ["idempotency"] = idempotency,
                ["redirects"] = new JsonObject { ["follow"] = execution.FollowRedirects, ["max"] = execution.MaxRedirects },
            },
        }.ToJsonString();
    }

    private static JsonObject Map(IReadOnlyDictionary<string, string> map) => new(map.Select(pair => KeyValuePair.Create(pair.Key, (JsonNode?)pair.Value)));

    private static JsonObject Body(RequestBody body)
    {
        var node = new JsonObject { ["type"] = body.Type };
        if (body.Keys is { } keys)
        {
            node["keys"] = new JsonArray([.. keys.Select(key => (JsonNode)key)]);
        }

        return node;
    }

    private static JsonNode Output(AutomationOutput output)
    {
        var node = new JsonObject { ["key"] = output.Key, ["type"] = output.Type, ["required"] = output.Required, ["source"] = output.Source };
        if (output.Path is { } path)
        {
            node["path"] = new JsonArray([.. path.Select(segment => JsonNode.Parse(segment.GetRawText()))]);
        }

        return node;
    }

    private static bool HasNulls(AutomationDocument document) =>
        document.Inputs.Contains(null!)
        || document.Outputs.Contains(null!)
        || document.Request.Query.Values.Contains(null!)
        || document.Request.Headers.Values.Contains(null!)
        || (document.Request.Body?.Keys?.Contains(null!) ?? false);

    private static AutomationParseResult Malformed(string message) => new(null, new AutomationIssue("AU000", message));
}
