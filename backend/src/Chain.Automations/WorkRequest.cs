using System.Globalization;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Chain.Expressions;

namespace Chain.Automations;

/// <summary>What the engine knows about the step activation it dispatches (automation-contract.md §3).</summary>
public sealed record DispatchContext(
    Guid RequestId, Guid InstanceId, string NodeId, int Activation, Guid AutomationId, int AutomationVersion, string AutomationName,
    string IdempotencyKey, DateTimeOffset Now, string CorrelationId, string? TraceParent);

/// <summary>
/// The payload of an <c>execute</c> work request and the deadline it carries, or why the inputs cannot be sent, as the message of
/// an <c>automation_input_invalid</c> fault (automation.md §6.1).
/// </summary>
public sealed record WorkRequestBuild(JsonObject? Payload, DateTimeOffset DeadlineAt, string? InputError);

/// <summary>
/// Builds the work-request payload (automation-contract.md §3) from a published automation version, its destination as it is now,
/// and the step's evaluated inputs (missing ones left out), after checking the inputs against the input contract (automation.md §7.1).
/// </summary>
public static partial class WorkRequestBuilder
{
    public const int ContractVersion = 1;

    // Bodies go out as UTF-8 text: non-ASCII characters are written as they are, not as \u escapes.
    private static readonly JsonSerializerOptions BodyOptions = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public static WorkRequestBuild Build(AutomationDocument document, Destination destination, JsonObject inputs, DispatchContext context)
    {
        ArgumentNullException.ThrowIfNull(document);
        ArgumentNullException.ThrowIfNull(destination);
        ArgumentNullException.ThrowIfNull(inputs);
        ArgumentNullException.ThrowIfNull(context);
        var execution = EffectiveExecution.Of(document.Execution);
        var deadline = StepDeadline.For(context.Now, execution);

        var problems = new List<string>();
        var values = CheckInputs(document.Inputs, inputs, problems);
        var path = BuildPath(document.Request.Path, values, problems);
        if (problems.Count > 0)
        {
            return new WorkRequestBuild(null, deadline, string.Join(' ', problems));
        }

        var request = document.Request;
        var payload = new JsonObject
        {
            ["contractVersion"] = ContractVersion,
            ["requestId"] = context.RequestId.ToString(),
            ["instanceId"] = context.InstanceId.ToString(),
            ["nodeId"] = context.NodeId,
            ["activation"] = context.Activation,
            ["automation"] = new JsonObject
            {
                ["id"] = context.AutomationId.ToString(), ["version"] = context.AutomationVersion, ["name"] = context.AutomationName,
            },
            ["destination"] = Snapshot(destination),
            ["request"] = new JsonObject
            {
                ["method"] = request.Method,
                ["url"] = $"{destination.Scheme}://{request.Host ?? destination.Host}{Port(destination)}{path}{Query(request.Query, values)}",
                ["headers"] = Headers(request),
                ["basicAuth"] = request.Auth is { } auth ? new JsonObject { ["username"] = auth.Username, ["password"] = auth.Password } : null,
                ["body"] = request.Body is { } body ? Body(body, document.Inputs, values) : null,
            },
            ["secrets"] = new JsonArray([.. AutomationRules.SecretsOf(document).Select(name => (JsonNode)name)]),
            ["response"] = new JsonObject { ["type"] = document.Response.Type },
            ["execution"] = new JsonObject
            {
                ["timeoutMs"] = execution.TimeoutSeconds * 1000,
                ["maxAttempts"] = execution.MaxAttempts,
                ["initialDelayMs"] = execution.InitialDelaySeconds * 1000,
                ["followRedirects"] = execution.FollowRedirects,
                ["maxRedirects"] = execution.MaxRedirects,
            },
            ["idempotency"] = execution.IdempotencyMode == "header"
                ? new JsonObject { ["header"] = execution.IdempotencyHeader, ["key"] = context.IdempotencyKey }
                : null,
            ["deadlineAt"] = deadline.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture),
            ["correlationId"] = context.CorrelationId,
            ["traceparent"] = context.TraceParent,
        };

        return new WorkRequestBuild(payload, deadline, null);
    }

    /// <summary>The declared inputs that are present and fit their type; a problem for each missing required or ill-typed one.</summary>
    private static Dictionary<string, JsonNode> CheckInputs(IReadOnlyList<AutomationInput> declared, JsonObject inputs, List<string> problems)
    {
        var values = new Dictionary<string, JsonNode>(StringComparer.Ordinal);
        foreach (var input in declared)
        {
            if (inputs[input.Key] is not { } value)
            {
                if (input.Required)
                {
                    problems.Add($"The input '{input.Key}' is required.");
                }
            }
            else if (!ContractTypes.Fits(value, input.Type))
            {
                problems.Add($"The input '{input.Key}' must be {ContractTypes.Describe(input.Type)}.");
            }
            else
            {
                values[input.Key] = value;
            }
        }

        return values;
    }

    /// <summary>The path with each <c>{key}</c> replaced by its value as one percent-encoded segment (automation.md §5.2).</summary>
    private static string BuildPath(string path, Dictionary<string, JsonNode> values, List<string> problems)
    {
        var reported = problems.Count > 0;
        return InputTemplate().Replace(path, match =>
        {
            var key = match.Groups["key"].Value;
            if (!values.TryGetValue(key, out var value))
            {
                if (!reported || !problems.Any(p => p.Contains($"'{key}'", StringComparison.Ordinal)))
                {
                    problems.Add($"The path input '{key}' is missing.");
                }

                return match.Value;
            }

            var text = Text(value);
            if (text is "" or "." or "..")
            {
                problems.Add($"The path input '{key}' cannot be empty, '.' or '..'.");
            }

            return Uri.EscapeDataString(text);
        });
    }

    /// <summary>Parameters in ordinal order of name; a <c>{key}</c> value whose input is missing leaves its parameter out.</summary>
    private static string Query(IReadOnlyDictionary<string, string> query, Dictionary<string, JsonNode> values)
    {
        var parameters = new List<string>();
        foreach (var (name, value) in query.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            var template = WholeTemplate().Match(value);
            if (!template.Success)
            {
                parameters.Add($"{Uri.EscapeDataString(name)}={Uri.EscapeDataString(value)}");
            }
            else if (values.TryGetValue(template.Groups["key"].Value, out var input))
            {
                parameters.Add($"{Uri.EscapeDataString(name)}={Uri.EscapeDataString(Text(input))}");
            }
        }

        return parameters.Count == 0 ? string.Empty : "?" + string.Join('&', parameters);
    }

    /// <summary>Headers in ordinal order of name, with <c>Content-Type: application/json</c> for a JSON body that sets none.</summary>
    private static JsonArray Headers(AutomationRequest request)
    {
        var headers = request.Headers.ToList();
        if (request.Body is { Type: "json" } && !headers.Any(header => header.Key.Equals("Content-Type", StringComparison.OrdinalIgnoreCase)))
        {
            headers.Add(KeyValuePair.Create("Content-Type", "application/json"));
        }

        return new JsonArray([.. headers.OrderBy(header => header.Key, StringComparer.Ordinal)
            .Select(header => (JsonNode)new JsonArray(header.Key, header.Value))]);
    }

    /// <summary>A JSON object of the listed inputs, or of every input, in that order; missing optional inputs are left out.</summary>
    private static string Body(RequestBody body, IReadOnlyList<AutomationInput> declared, Dictionary<string, JsonNode> values)
    {
        var json = new JsonObject();
        foreach (var key in body.Keys ?? [.. declared.Select(input => input.Key)])
        {
            if (values.TryGetValue(key, out var value))
            {
                json[key] = value.DeepClone();
            }
        }

        return json.ToJsonString(BodyOptions);
    }

    private static JsonObject Snapshot(Destination destination) => new()
    {
        ["name"] = destination.Name,
        ["scheme"] = destination.Scheme,
        ["host"] = destination.Host,
        ["port"] = destination.Port,
        ["pathPrefix"] = destination.PathPrefix,
        ["internal"] = destination.Internal,
        ["allowSecretsOverHttp"] = destination.AllowSecretsOverHttp,
        ["maxRequestBytes"] = destination.MaxRequestBytes,
        ["maxResponseBytes"] = destination.MaxResponseBytes,
    };

    /// <summary>The port only when it is set and not the scheme's default.</summary>
    private static string Port(Destination destination) =>
        destination.Port is { } port && port != (destination.Scheme == "http" ? 80 : 443) ? $":{port}" : string.Empty;

    /// <summary>A scalar as URL text: text as it is, booleans as <c>true</c>/<c>false</c>, numbers as JSON writes them.</summary>
    private static string Text(JsonNode value) => value.GetValueKind() switch
    {
        JsonValueKind.String => value.GetValue<string>(),
        JsonValueKind.True => "true",
        JsonValueKind.False => "false",
        _ => value.ToJsonString(),
    };

    [GeneratedRegex(@"\{(?<key>[a-zA-Z][a-zA-Z0-9_]{0,63})\}", RegexOptions.CultureInvariant)]
    private static partial Regex InputTemplate();

    [GeneratedRegex(@"^\{(?<key>[a-zA-Z][a-zA-Z0-9_]{0,63})\}\z", RegexOptions.CultureInvariant)]
    private static partial Regex WholeTemplate();
}

/// <summary>The types of an automation's input and output contracts (automation.md §7.1), with the accepted JSON values.</summary>
public static class ContractTypes
{
    public static bool Fits(JsonNode? value, string type)
    {
        ArgumentNullException.ThrowIfNull(type);
        if (type == "unknown")
        {
            return true;
        }

        if (value is null)
        {
            return false;
        }

        var kind = value.GetValueKind();
        return type switch
        {
            "text" => kind == JsonValueKind.String,
            "number" => kind == JsonValueKind.Number,
            "boolean" => kind is JsonValueKind.True or JsonValueKind.False,
            "date" => kind == JsonValueKind.String && ExprValue.TryParseDate(value.GetValue<string>(), out _),
            "datetime" => kind == JsonValueKind.String && ExprValue.TryParseDateTime(value.GetValue<string>(), out _),
            "time" => kind == JsonValueKind.String && ExprValue.TryParseTime(value.GetValue<string>(), out _),
            "object" => kind == JsonValueKind.Object,
            _ when ElementOf(type) is { } element => value is JsonArray list && list.All(item => Fits(item, element)),
            _ => false,
        };
    }

    /// <summary>
    /// The type as the workflow data catalog sees it (workflow-definition.md §6.1, card #76): <c>object</c> declares no fields, and a
    /// name that is not a type, which publishing refuses (AU002), is unknown.
    /// </summary>
    public static ExprType ToExprType(string type)
    {
        ArgumentNullException.ThrowIfNull(type);
        return type switch
        {
            "text" => ExprType.Text,
            "number" => ExprType.Number,
            "boolean" => ExprType.Boolean,
            "date" => ExprType.Date,
            "datetime" => ExprType.DateTime,
            "time" => ExprType.Time,
            "object" => ExprType.ObjectOf(new Dictionary<string, FieldType>(StringComparer.Ordinal)),
            _ when ElementOf(type) is { } element => ExprType.ListOf(ToExprType(element)),
            _ => ExprType.Unknown,
        };
    }

    /// <summary>The type as the end of "must be …", for messages.</summary>
    public static string Describe(string type) => type switch
    {
        "text" => "text",
        "number" => "a number",
        "boolean" => "true or false",
        "date" => "a date (yyyy-MM-dd)",
        "datetime" => "a date and time (ISO 8601)",
        "time" => "a time (HH:mm or HH:mm:ss)",
        "object" => "an object",
        _ => $"a {type}",
    };

    private static string? ElementOf(string type) =>
        type.StartsWith("list<", StringComparison.Ordinal) && type.EndsWith('>') ? type[5..^1] : null;
}

/// <summary>
/// When .NET stops waiting for a step (automation.md §8.2, ADR-0011 decision 7): every attempt's timeout, every backoff with
/// margin (at least a minute each), and ten minutes; rounded down to the whole second.
/// </summary>
public static class StepDeadline
{
    public const int MaxBackoffSeconds = 300;
    public const int MarginSeconds = 600;

    public static DateTimeOffset For(DateTimeOffset createdAt, EffectiveExecution execution)
    {
        ArgumentNullException.ThrowIfNull(execution);
        decimal seconds = (execution.MaxAttempts * execution.TimeoutSeconds) + MarginSeconds;
        for (var n = 1; n < execution.MaxAttempts; n++)
        {
            var backoff = Math.Min(execution.InitialDelaySeconds * (decimal)Math.Pow(2, Math.Min(n - 1, 30)), MaxBackoffSeconds);
            seconds += Math.Max(1.1m * backoff, 60m);
        }

        var deadline = createdAt.UtcTicks + (long)(seconds * TimeSpan.TicksPerSecond);
        return new DateTimeOffset(deadline - (deadline % TimeSpan.TicksPerSecond), TimeSpan.Zero);
    }
}
