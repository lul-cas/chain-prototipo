using System.Text.Json;

namespace Chain.Expressions;

public sealed record ExpressionIssue(string Message);

public sealed record ConditionParseResult(ConditionNode? Condition, ExpressionIssue? Error)
{
    public bool IsSuccess => Condition is not null;
}

public sealed record ValueParseResult(ValueNode? Value, ExpressionIssue? Error)
{
    public bool IsSuccess => Value is not null;
}

/// <summary>
/// Parses untrusted expression trees (expression-language.md §5.1): known node kinds and properties only,
/// valid literals and arities, and the size limits.
/// </summary>
public static class ExpressionParser
{
    public const int MaxGroupDepth = 10;
    public const int MaxComparisons = 50;
    public const int MaxNodes = 200;
    public const int MaxValueDepth = 10;
    public const int MaxPathSegments = 10;
    public const int MaxOffset = 10_000;

    public static readonly IReadOnlySet<string> UnaryOperators = new HashSet<string>(StringComparer.Ordinal) { "isEmpty", "isNotEmpty" };

    public static readonly IReadOnlySet<string> BinaryOperators = new HashSet<string>(StringComparer.Ordinal)
    {
        "equals", "notEquals", "contains", "greaterThan", "lessThan", "greaterOrEqual", "lessOrEqual",
    };

    private static readonly Dictionary<string, (int Min, int Max)> Functions = new(StringComparer.Ordinal)
    {
        ["abs"] = (1, 1), ["round"] = (1, 2), ["floor"] = (1, 1), ["ceil"] = (1, 1),
        ["min"] = (1, 50), ["max"] = (1, 50), ["sum"] = (1, 1), ["avg"] = (1, 1), ["count"] = (1, 1),
        ["string"] = (1, 1), ["number"] = (1, 1), ["date"] = (1, 1), ["time"] = (1, 1), ["datetime"] = (1, 2),
    };

    private static readonly HashSet<string> DateUnits = ["days", "months", "years"];
    private static readonly HashSet<string> DateTimeUnits = ["days", "months", "years", "hours", "minutes"];

    public static ConditionParseResult ParseCondition(JsonElement element)
    {
        var state = new State();
        try
        {
            var condition = state.Condition(element, groupDepth: 0);
            return new ConditionParseResult(condition, null);
        }
        catch (Exception ex) when (ex is FormatException or KeyNotFoundException)
        {
            return new ConditionParseResult(null, new ExpressionIssue(ex is KeyNotFoundException ? "A required property is missing." : ex.Message));
        }
    }

    public static ValueParseResult ParseValue(JsonElement element)
    {
        var state = new State();
        try
        {
            return new ValueParseResult(state.Value(element, depth: 0), null);
        }
        catch (Exception ex) when (ex is FormatException or KeyNotFoundException)
        {
            return new ValueParseResult(null, new ExpressionIssue(ex is KeyNotFoundException ? "A required property is missing." : ex.Message));
        }
    }

    private sealed class State
    {
        private int _nodes;
        private int _comparisons;

        public ConditionNode Condition(JsonElement element, int groupDepth)
        {
            Count();
            switch (Kind(element))
            {
                case "group":
                    Only(element, "kind", "op", "items");
                    if (groupDepth >= MaxGroupDepth)
                    {
                        throw new FormatException($"Groups nest at most {MaxGroupDepth} levels.");
                    }

                    var op = String(element, "op");
                    if (op is not ("and" or "or"))
                    {
                        throw new FormatException("A group's op must be 'and' or 'or'.");
                    }

                    return new GroupNode(op == "and", [.. Array(element, "items").Select(item => Condition(item, groupDepth + 1))]);

                case "compare":
                    Only(element, "kind", "left", "operator", "right");
                    if (++_comparisons > MaxComparisons)
                    {
                        throw new FormatException($"At most {MaxComparisons} comparisons per expression.");
                    }

                    var operation = String(element, "operator");
                    var hasRight = element.TryGetProperty("right", out var right);
                    if (UnaryOperators.Contains(operation) ? hasRight : !BinaryOperators.Contains(operation) || !hasRight)
                    {
                        throw new FormatException($"Invalid operator '{operation}' or operands.");
                    }

                    return new CompareNode(Value(element.GetProperty("left"), 0), operation, hasRight ? Value(right, 0) : null);

                default:
                    throw new FormatException("A condition must be a group or a comparison.");
            }
        }

        public ValueNode Value(JsonElement element, int depth)
        {
            Count();
            if (depth >= MaxValueDepth)
            {
                throw new FormatException($"Values nest at most {MaxValueDepth} levels.");
            }

            ValueNode node;
            var allowsOffset = true;
            switch (Kind(element))
            {
                case "path":
                    Only(element, "kind", "path", "offset");
                    var segments = Array(element, "path").Select(s => s.ValueKind == JsonValueKind.String ? s.GetString()! : throw new FormatException("Path segments are text.")).ToList();
                    if (segments.Count is 0 or > MaxPathSegments || segments[0] == "[]" || segments.Any(s => s.Length is 0 or > 64))
                    {
                        throw new FormatException("Invalid path.");
                    }

                    node = new PathNode(segments);
                    break;

                case "literal":
                    Only(element, "kind", "type", "value", "offset");
                    var literal = Literal(String(element, "type"), String(element, "value"));
                    allowsOffset = literal is ExprValue.DateValue or ExprValue.DateTimeValue;
                    node = new LiteralNode(literal);
                    break;

                case "system":
                    Only(element, "kind", "name", "offset");
                    var name = String(element, "name");
                    if (name is not ("currentDate" or "currentDateTime"))
                    {
                        throw new FormatException($"Unknown system value '{name}'.");
                    }

                    node = new SystemNode(name);
                    break;

                case "call":
                    Only(element, "kind", "function", "args", "offset");
                    var function = String(element, "function");
                    if (!Functions.TryGetValue(function, out var arity))
                    {
                        throw new FormatException($"Unknown function '{function}'.");
                    }

                    var args = Array(element, "args").Select(a => Value(a, depth + 1)).ToList();
                    if (args.Count < arity.Min || args.Count > arity.Max)
                    {
                        throw new FormatException($"'{function}' takes {arity.Min}–{arity.Max} arguments.");
                    }

                    allowsOffset = function is "date" or "datetime";
                    node = new CallNode(function, args);
                    break;

                case "arithmetic":
                    Only(element, "kind", "op", "left", "right");
                    var op = String(element, "op");
                    if (op is not ("add" or "subtract" or "multiply" or "divide"))
                    {
                        throw new FormatException($"Unknown arithmetic op '{op}'.");
                    }

                    node = new ArithmeticNode(op, Value(element.GetProperty("left"), depth + 1), Value(element.GetProperty("right"), depth + 1));
                    allowsOffset = false;
                    break;

                default:
                    throw new FormatException("Unknown value kind.");
            }

            if (element.TryGetProperty("offset", out var offset))
            {
                if (!allowsOffset)
                {
                    throw new FormatException("Only date and datetime values can carry an offset.");
                }

                var units = node is SystemNode { Name: "currentDate" } or LiteralNode { Value: ExprValue.DateValue } or CallNode { Function: "date" } ? DateUnits : DateTimeUnits;
                node = node with { Offset = ParseOffset(offset, units) };
            }

            return node;
        }

        private static DateOffset ParseOffset(JsonElement offset, HashSet<string> units)
        {
            if (offset.ValueKind != JsonValueKind.Object)
            {
                throw new FormatException("An offset is an object.");
            }

            Only(offset, "amount", "unit");
            if (!offset.TryGetProperty("amount", out var amount) || !amount.TryGetInt32(out var value) || Math.Abs(value) > MaxOffset)
            {
                throw new FormatException("An offset amount is an integer up to 10000.");
            }

            var unit = String(offset, "unit");
            return units.Contains(unit) ? new DateOffset(value, unit) : throw new FormatException($"Unknown offset unit '{unit}'.");
        }

        private static ExprValue Literal(string type, string value) => type switch
        {
            "text" => new ExprValue.TextValue(value),
            "number" => ExprValue.TryParseNumber(value, out var number) ? new ExprValue.NumberValue(number) : throw new FormatException("Invalid number literal."),
            "boolean" => value switch { "true" => new ExprValue.BoolValue(true), "false" => new ExprValue.BoolValue(false), _ => throw new FormatException("Invalid boolean literal.") },
            "date" => ExprValue.TryParseDate(value, out var date) ? new ExprValue.DateValue(date) : throw new FormatException("Invalid date literal."),
            "datetime" => ExprValue.TryParseDateTime(value, out var instant) ? new ExprValue.DateTimeValue(instant) : throw new FormatException("Invalid datetime literal."),
            "time" => ExprValue.TryParseTime(value, out var time) ? new ExprValue.TimeValue(time) : throw new FormatException("Invalid time literal."),
            _ => throw new FormatException($"Unknown literal type '{type}'."),
        };

        private void Count()
        {
            if (++_nodes > MaxNodes)
            {
                throw new FormatException($"Expressions are limited to {MaxNodes} nodes.");
            }
        }

        private static string Kind(JsonElement element) =>
            element.ValueKind == JsonValueKind.Object ? String(element, "kind") : throw new FormatException("A node is an object.");

        private static string String(JsonElement element, string property) =>
            element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
                ? value.GetString()!
                : throw new FormatException($"'{property}' must be text.");

        private static JsonElement.ArrayEnumerator Array(JsonElement element, string property) =>
            element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.Array
                ? value.EnumerateArray()
                : throw new FormatException($"'{property}' must be a list.");

        private static void Only(JsonElement element, params string[] allowed)
        {
            foreach (var property in element.EnumerateObject())
            {
                if (!allowed.Contains(property.Name))
                {
                    throw new FormatException($"Unknown property '{property.Name}'.");
                }
            }
        }
    }
}
