using System.Text.Json;
using static Chain.Expressions.ExprValue;

namespace Chain.Expressions;

/// <summary>
/// Evaluates condition and value trees (expression-language.md §2–§5). Failures raise <see cref="ExpressionException"/>
/// with the codes of §5.3; callers decide what an error means (a faulted gateway, a form field error).
/// </summary>
public static class Evaluator
{
    public static bool Evaluate(ConditionNode condition, EvaluationContext context)
    {
        ArgumentNullException.ThrowIfNull(condition);
        ArgumentNullException.ThrowIfNull(context);
        return condition switch
        {
            // Short-circuit, left to right (§4).
            GroupNode { IsAnd: true } group => group.Items.All(item => Evaluate(item, context)),
            GroupNode group => group.Items.Any(item => Evaluate(item, context)),
            CompareNode compare => Compare(compare, context),
            _ => throw new ArgumentOutOfRangeException(nameof(condition)),
        };
    }

    public static ExprValue Evaluate(ValueNode node, EvaluationContext context)
    {
        ArgumentNullException.ThrowIfNull(node);
        ArgumentNullException.ThrowIfNull(context);
        var value = node switch
        {
            PathNode path => Read(context.Data, path.Segments, 0),
            LiteralNode literal => literal.Value,
            SystemNode { Name: "currentDate" } => new DateValue(DateOnly.FromDateTime(context.Now.ToOffset(context.Zone).DateTime)),
            SystemNode => new DateTimeValue(context.Now.ToUniversalTime()),
            ArithmeticNode arithmetic => Arithmetic(arithmetic, context),
            CallNode call => Functions.Call(call.Function, [.. call.Args.Select(a => Evaluate(a, context))], context),
            _ => throw new ArgumentOutOfRangeException(nameof(node)),
        };

        return node.Offset is { } offset ? ApplyOffset(value, offset) : value;
    }

    // Comparisons (§3)

    private static bool Compare(CompareNode compare, EvaluationContext context)
    {
        var left = Evaluate(compare.Left, context);
        switch (compare.Operator)
        {
            case "isEmpty":
                return IsEmpty(left);
            case "isNotEmpty":
                return !IsEmpty(left);
        }

        var right = Evaluate(compare.Right!, context);
        if (left is MissingValue || right is MissingValue)
        {
            return compare.Operator == "notEquals"; // §3: missing compares false, except notEquals
        }

        (left, right) = Coerce(left, right);
        return compare.Operator switch
        {
            "equals" => Equal(left, right),
            "notEquals" => !Equal(left, right),
            "contains" => Contains(left, right),
            "greaterThan" => Order(left, right) > 0,
            "lessThan" => Order(left, right) < 0,
            "greaterOrEqual" => Order(left, right) >= 0,
            "lessOrEqual" => Order(left, right) <= 0,
            _ => throw new ExpressionException("type_mismatch", $"Unknown operator '{compare.Operator}'."),
        };
    }

    private static bool IsEmpty(ExprValue value) => value switch
    {
        MissingValue => true,
        TextValue text => text.Value.Length == 0,
        ListValue list => list.Items.Count == 0,
        _ => false,
    };

    /// <summary>Dates and times are stored as ISO text: parse text when the other side is temporal (§5.2).</summary>
    private static (ExprValue Left, ExprValue Right) Coerce(ExprValue left, ExprValue right) => (left, right) switch
    {
        (TextValue text, DateValue or DateTimeValue or TimeValue) => (Parse(text, right), right),
        (DateValue or DateTimeValue or TimeValue, TextValue text) => (left, Parse(text, left)),
        _ => (left, right),
    };

    private static ExprValue Parse(TextValue text, ExprValue like) => like switch
    {
        DateValue when TryParseDate(text.Value, out var date) => new DateValue(date),
        DateTimeValue when TryParseDateTime(text.Value, out var instant) => new DateTimeValue(instant),
        TimeValue when TryParseTime(text.Value, out var time) => new TimeValue(time),
        _ => throw new ExpressionException("type_mismatch", $"'{text.Value}' is not a {like.TypeName}."),
    };

    /// <summary>The temporal value an ISO text denotes, or null. The three formats are disjoint, so at most one applies.</summary>
    private static ExprValue? AsTemporal(TextValue text) =>
        TryParseDate(text.Value, out var date) ? new DateValue(date)
        : TryParseTime(text.Value, out var time) ? new TimeValue(time)
        : TryParseDateTime(text.Value, out var instant) ? new DateTimeValue(instant)
        : null;

    private static bool Equal(ExprValue left, ExprValue right) => (left, right) switch
    {
        (TextValue a, TextValue b) => string.Equals(a.Value, b.Value, StringComparison.Ordinal),
        (NumberValue a, NumberValue b) => a.Value == b.Value,
        (BoolValue a, BoolValue b) => a.Value == b.Value,
        (DateValue a, DateValue b) => a.Value == b.Value,
        (DateTimeValue a, DateTimeValue b) => a.Value == b.Value,
        (TimeValue a, TimeValue b) => a.Value == b.Value,
        _ => throw Mismatch(left, right),
    };

    private static bool Contains(ExprValue left, ExprValue right) => (left, right) switch
    {
        (TextValue a, TextValue b) => a.Value.Contains(b.Value, StringComparison.Ordinal),
        (ListValue list, _) => list.Items.Any(item => item is not MissingValue && Equal(Coerce(item, right).Left, right)),
        _ => throw Mismatch(left, right),
    };

    private static int Order(ExprValue left, ExprValue right) => (left, right) switch
    {
        // Two stored temporal values are two ISO texts (§5.2): order them as the temporal type both parse as.
        (TextValue a, TextValue b) when AsTemporal(a) is { } x && AsTemporal(b) is { } y => Order(x, y), // different kinds still mismatch
        (NumberValue a, NumberValue b) => a.Value.CompareTo(b.Value),
        (DateValue a, DateValue b) => a.Value.CompareTo(b.Value),
        (DateTimeValue a, DateTimeValue b) => a.Value.CompareTo(b.Value),
        (TimeValue a, TimeValue b) => a.Value.CompareTo(b.Value),
        _ => throw Mismatch(left, right),
    };

    // Values

    private static ExprValue Read(JsonElement current, IReadOnlyList<string> segments, int index)
    {
        for (var i = index; i < segments.Count; i++)
        {
            if (segments[i] == "[]")
            {
                return current.ValueKind == JsonValueKind.Array
                    ? new ListValue([.. current.EnumerateArray().Select(row => Read(row, segments, i + 1))])
                    : MissingValue.Instance;
            }

            if (current.ValueKind != JsonValueKind.Object || !current.TryGetProperty(segments[i], out current))
            {
                return MissingValue.Instance;
            }
        }

        return FromJson(current);
    }

    private static ExprValue Arithmetic(ArithmeticNode node, EvaluationContext context)
    {
        var left = Evaluate(node.Left, context);
        var right = Evaluate(node.Right, context);
        if (left is MissingValue || right is MissingValue)
        {
            return MissingValue.Instance;
        }

        if (left is not NumberValue a || right is not NumberValue b)
        {
            throw Mismatch(left, right);
        }

        try
        {
            return new NumberValue(node.Op switch
            {
                "add" => a.Value + b.Value,
                "subtract" => a.Value - b.Value,
                "multiply" => a.Value * b.Value,
                _ when b.Value == 0 => throw new ExpressionException("division_by_zero", "Division by zero."),
                _ => a.Value / b.Value,
            });
        }
        catch (OverflowException)
        {
            throw new ExpressionException("overflow", "The result is out of range.");
        }
    }

    /// <summary>DateValue arithmetic (§3a); month and year steps clamp to the last valid day.</summary>
    private static ExprValue ApplyOffset(ExprValue value, DateOffset offset)
    {
        if (value is TextValue text)
        {
            value = TryParseDate(text.Value, out var date) ? new DateValue(date)
                : TryParseDateTime(text.Value, out var instant) ? new DateTimeValue(instant)
                : throw new ExpressionException("type_mismatch", $"'{text.Value}' is not a date.");
        }

        try
        {
            return Offset(value, offset);
        }
        catch (ArgumentOutOfRangeException)
        {
            throw new ExpressionException("overflow", "The date is out of range."); // before year 1 or after 9999
        }
    }

    private static ExprValue Offset(ExprValue value, DateOffset offset)
    {
        return value switch
        {
            MissingValue => value,
            DateValue date => offset.Unit switch
            {
                "days" => new DateValue(date.Value.AddDays(offset.Amount)),
                "months" => new DateValue(date.Value.AddMonths(offset.Amount)),
                "years" => new DateValue(date.Value.AddYears(offset.Amount)),
                _ => throw new ExpressionException("type_mismatch", "Dates move by days, months or years."),
            },
            DateTimeValue instant => new DateTimeValue(offset.Unit switch
            {
                "days" => instant.Value.AddDays(offset.Amount),
                "months" => instant.Value.AddMonths(offset.Amount),
                "years" => instant.Value.AddYears(offset.Amount),
                "hours" => instant.Value.AddHours(offset.Amount),
                _ => instant.Value.AddMinutes(offset.Amount),
            }),
            _ => throw new ExpressionException("type_mismatch", $"A {value.TypeName} cannot carry a date offset."),
        };
    }

    internal static ExpressionException Mismatch(ExprValue left, ExprValue right) =>
        new("type_mismatch", $"Cannot combine {left.TypeName} and {right.TypeName}.");
}
