using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Chain.Expressions;

// Condition and expression trees (ADR-0003; expression-language.md §5.1).

public abstract record ConditionNode;

public sealed record GroupNode(bool IsAnd, IReadOnlyList<ConditionNode> Items) : ConditionNode;

public sealed record CompareNode(ValueNode Left, string Operator, ValueNode? Right) : ConditionNode;

/// <summary>A date offset (§3a). A negative amount subtracts.</summary>
public sealed record DateOffset(int Amount, string Unit);

public abstract record ValueNode
{
    public DateOffset? Offset { get; init; }
}

public sealed record PathNode(IReadOnlyList<string> Segments) : ValueNode;

public sealed record LiteralNode(ExprValue Value) : ValueNode;

public sealed record SystemNode(string Name) : ValueNode;

public sealed record CallNode(string Function, IReadOnlyList<ValueNode> Args) : ValueNode;

public sealed record ArithmeticNode(string Op, ValueNode Left, ValueNode Right) : ValueNode;

/// <summary>An evaluation failure with a stable code (expression-language.md §5.3).</summary>
public sealed class ExpressionException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

/// <summary>What expressions read: <c>data</c>, the current instant and the evaluation zone (ADR-0003 §2).</summary>
public sealed record EvaluationContext(JsonElement Data, DateTimeOffset Now, TimeSpan Zone);

/// <summary>A runtime value of the language (§2).</summary>
public abstract record ExprValue
{
    public abstract string TypeName { get; }

    public abstract string ToCanonicalString();

    public sealed record MissingValue : ExprValue
    {
        public static readonly MissingValue Instance = new();

        public override string TypeName => "missing";

        public override string ToCanonicalString() => string.Empty;
    }

    public sealed record TextValue(string Value) : ExprValue
    {
        public override string TypeName => "text";

        public override string ToCanonicalString() => Value;
    }

    public sealed record NumberValue(decimal Value) : ExprValue
    {
        public override string TypeName => "number";

        public override string ToCanonicalString() => Value.ToString("0.############################", CultureInfo.InvariantCulture);
    }

    public sealed record BoolValue(bool Value) : ExprValue
    {
        public override string TypeName => "boolean";

        public override string ToCanonicalString() => Value ? "true" : "false";
    }

    public sealed record DateValue(DateOnly Value) : ExprValue
    {
        public override string TypeName => "date";

        public override string ToCanonicalString() => Value.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
    }

    public sealed record DateTimeValue(DateTimeOffset Value) : ExprValue
    {
        public override string TypeName => "datetime";

        public override string ToCanonicalString() =>
            Value.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.FFFFFFF'Z'", CultureInfo.InvariantCulture);
    }

    public sealed record TimeValue(TimeOnly Value) : ExprValue
    {
        public override string TypeName => "time";

        public override string ToCanonicalString() => Value.ToString("HH:mm:ss", CultureInfo.InvariantCulture);
    }

    public sealed record ListValue(IReadOnlyList<ExprValue> Items) : ExprValue
    {
        public override string TypeName => "list";

        public override string ToCanonicalString() => $"[{string.Join(',', Items.Select(i => i.ToCanonicalString()))}]";
    }

    public sealed record ObjectValue(JsonElement Value) : ExprValue
    {
        public override string TypeName => "object";

        public override string ToCanonicalString() => Value.GetRawText();
    }

    /// <summary>Converts a value back into JSON data; dates and times become ISO text (§5.2). Missing becomes null.</summary>
    public JsonNode? ToJsonNode() => this switch
    {
        MissingValue => null,
        TextValue text => JsonValue.Create(text.Value),
        NumberValue number => JsonValue.Create(number.Value),
        BoolValue flag => JsonValue.Create(flag.Value),
        ListValue list => new JsonArray([.. list.Items.Select(item => item.ToJsonNode())]),
        ObjectValue obj => JsonNode.Parse(obj.Value.GetRawText()),
        _ => JsonValue.Create(ToCanonicalString()),
    };

    /// <summary>Converts JSON data into a value, typed by its JSON kind (§5.2).</summary>
    public static ExprValue FromJson(JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.String => new TextValue(element.GetString()!),
        JsonValueKind.Number => element.TryGetDecimal(out var number) ? new NumberValue(number) : throw new ExpressionException("overflow", "The number is out of range."),
        JsonValueKind.True => new BoolValue(true),
        JsonValueKind.False => new BoolValue(false),
        JsonValueKind.Array => new ListValue([.. element.EnumerateArray().Select(FromJson)]),
        JsonValueKind.Object => new ObjectValue(element),
        _ => MissingValue.Instance,
    };

    // Shared parsing of ISO text, used by literals, coercion and conversion functions.

    public static bool TryParseNumber(string text, out decimal value)
    {
        // .NET's parser ignores trailing NUL characters and reads "12\0" as 12; the TypeScript interpreter refuses it (#126).
        if (text.Contains('\0', StringComparison.Ordinal))
        {
            value = 0;
            return false;
        }

        return decimal.TryParse(text, NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out value);
    }

    public static bool TryParseDate(string text, out DateOnly value) =>
        DateOnly.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out value);

    public static bool TryParseTime(string text, out TimeOnly value) =>
        TimeOnly.TryParseExact(text, ["HH:mm", "HH:mm:ss"], CultureInfo.InvariantCulture, DateTimeStyles.None, out value);

    public static bool TryParseDateTime(string text, out DateTimeOffset value) =>
        IsoDateTime.TryParse(text, out value);
}
