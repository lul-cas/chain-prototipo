using System.Text.Json;
using Chain.SharedKernel;
using Chain.Workflows.Application.Engine;
using Chain.Workflows.Runtime;
using ModelContextProtocol.Protocol;

namespace Chain.Mcp;

/// <summary>
/// Reads one call's arguments against its tool's schema. Each problem becomes a <c>validation_failed</c> detail (mcp.md §3), so a
/// model can correct its input; the application service still validates everything it receives.
/// </summary>
internal sealed class ToolArguments
{
    public const int MaxIdempotencyKeyLength = 200;

    private readonly IReadOnlyDictionary<string, JsonElement> _values;
    private readonly IReadOnlyList<string> _known;
    private readonly UnreadableArguments _unreadable;
    private readonly List<string> _problems = [];
    private bool _unreadableData;

    public ToolArguments(IDictionary<string, JsonElement>? values, IReadOnlyList<string> known, UnreadableArguments? unreadable = null)
    {
        _values = values is null ? new Dictionary<string, JsonElement>() : new Dictionary<string, JsonElement>(values);
        _known = known;
        _unreadable = unreadable ?? UnreadableArguments.None;
        if (_values.Keys.Any(name => !known.Contains(name)))
        {
            _problems.Add("unknown_argument");
        }
    }

    /// <summary>
    /// A <c>validation_failed</c> result when any argument was wrong, then <c>submission_invalid</c> when the data is not Unicode
    /// text, as on the HTTP API (workflow-engine.md §13.1); otherwise null. Arguments whose names could not be read are only
    /// <c>unknown_argument</c>, since none of them was seen (mcp.md §3).
    /// </summary>
    public CallToolResult? Invalid
    {
        get
        {
            if (_unreadable.Names)
            {
                return Unknown(["unknown_argument"]);
            }

            if (_problems.Count > 0)
            {
                return _problems.Contains("unknown_argument")
                    ? Unknown(_problems)
                    : ToolResults.Error("validation_failed", "The arguments are invalid.", details: _problems);
            }

            return _unreadableData
                ? ToolResults.Error("submission_invalid", "The submitted data is invalid.", fieldErrors: [new FieldErrorView(string.Empty, "invalid_value")])
                : null;
        }
    }

    /// <summary>A required id: a UUID in its usual hyphenated form.</summary>
    public Guid Id(string name, string problem)
    {
        if (!_unreadable.Values.Contains(name) && _values.TryGetValue(name, out var value) && value.ValueKind == JsonValueKind.String
            && Guid.TryParseExact(value.GetString(), "D", out var id))
        {
            return id;
        }

        _problems.Add(problem);
        return Guid.Empty;
    }

    /// <summary>Optional request data, passed on as the HTTP API does: the pinned form validates it (FR-022). JSON null means absent.</summary>
    public JsonElement? Data(string name)
    {
        if (_unreadable.Values.Contains(name))
        {
            _unreadableData = true;
            return null;
        }

        return _values.TryGetValue(name, out var value) && value.ValueKind != JsonValueKind.Null ? value : null;
    }

    /// <summary>Optional text. JSON null means absent.</summary>
    public string? Text(string name, string problem)
    {
        if (_unreadable.Values.Contains(name))
        {
            _problems.Add(problem);
            return null;
        }

        if (!_values.TryGetValue(name, out var value) || value.ValueKind == JsonValueKind.Null)
        {
            return null;
        }

        if (value.ValueKind != JsonValueKind.String)
        {
            _problems.Add(problem);
            return null;
        }

        return value.GetString();
    }

    /// <summary>A required boolean.</summary>
    public bool Boolean(string name, string problem)
    {
        if (!_unreadable.Values.Contains(name) && _values.TryGetValue(name, out var value) && value.ValueKind is JsonValueKind.True or JsonValueKind.False)
        {
            return value.GetBoolean();
        }

        _problems.Add(problem);
        return false;
    }

    /// <summary>An optional value out of <paramref name="allowed"/>, exactly as listed in the schema.</summary>
    public string? Choice(string name, IReadOnlyList<string> allowed, string problem)
    {
        var text = Text(name, problem);
        if (text is not null && !allowed.Contains(text))
        {
            _problems.Add(problem);
            return null;
        }

        return text;
    }

    /// <summary>An optional request status, one of <see cref="ToolCatalog.Statuses"/>.</summary>
    public InstanceStatus? Status(string name, string problem) =>
        Choice(name, ToolCatalog.Statuses, problem) is { } text ? Enum.Parse<InstanceStatus>(text, ignoreCase: true) : null;

    /// <summary>
    /// The required <c>idempotencyKey</c> of a write tool (mcp.md §4), trimmed like the HTTP header. It is stored as text, so text
    /// PostgreSQL cannot store, NUL or an unpaired surrogate, is <c>invalid_idempotency_key</c> (identity.md I1, card #205).
    /// </summary>
    public string IdempotencyKey()
    {
        if (_unreadable.Values.Contains("idempotencyKey"))
        {
            _problems.Add("invalid_idempotency_key");
            return string.Empty;
        }

        var key = Text("idempotencyKey", "idempotency_key_required")?.Trim();
        if (!ClientText.IsStorable(key))
        {
            _problems.Add("invalid_idempotency_key");
            return string.Empty;
        }

        if (string.IsNullOrEmpty(key))
        {
            if (!_problems.Contains("idempotency_key_required"))
            {
                _problems.Add("idempotency_key_required");
            }

            return string.Empty;
        }

        if (key.Length > MaxIdempotencyKeyLength)
        {
            _problems.Add("idempotency_key_too_long");
        }

        return key;
    }

    /// <summary><c>validation_failed</c> whose message lists the tool's arguments, for <c>unknown_argument</c>.</summary>
    private CallToolResult Unknown(IReadOnlyList<string> problems) =>
        ToolResults.Error("validation_failed", $"The arguments are invalid. This tool takes: {string.Join(", ", _known)}.", details: problems);
}
