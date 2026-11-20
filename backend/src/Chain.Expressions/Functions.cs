using static Chain.Expressions.ExprValue;

namespace Chain.Expressions;

/// <summary>The POC's functions (expression-language.md §3b). Nothing else is callable.</summary>
internal static class Functions
{
    public static ExprValue Call(string function, IReadOnlyList<ExprValue> args, EvaluationContext context)
    {
        try
        {
            return Dispatch(function, args, context);
        }
        catch (ArgumentOutOfRangeException)
        {
            throw new ExpressionException("overflow", "The date is out of range."); // zone conversion before year 1 or after 9999
        }
    }

    private static ExprValue Dispatch(string function, IReadOnlyList<ExprValue> args, EvaluationContext context) => function switch
    {
        "abs" => Unary(args, Math.Abs),
        "floor" => Unary(args, decimal.Floor),
        "ceil" => Unary(args, decimal.Ceiling),
        "round" => Round(args),
        "min" => Aggregate(args, numbers => numbers.Min(), allowsEmpty: false),
        "max" => Aggregate(args, numbers => numbers.Max(), allowsEmpty: false),
        "avg" => Aggregate(args, numbers => numbers.Sum() / numbers.Count, allowsEmpty: false),
        "sum" => Aggregate(args, numbers => numbers.Sum(), allowsEmpty: true),
        "count" => args[0] switch
        {
            MissingValue => new NumberValue(0),
            ListValue list => new NumberValue(list.Items.Count),
            var other => throw new ExpressionException("type_mismatch", $"count needs a list, not {other.TypeName}."),
        },
        "string" => args[0] switch
        {
            MissingValue => MissingValue.Instance,
            ListValue or ExprValue.ObjectValue => throw new ExpressionException("type_mismatch", "string needs a single value."),
            var scalar => new TextValue(scalar.ToCanonicalString()),
        },
        "number" => args[0] switch
        {
            MissingValue => MissingValue.Instance,
            NumberValue number => number,
            TextValue text => TryParseNumber(text.Value, out var parsed) ? new NumberValue(parsed) : throw new ExpressionException("invalid_number", $"'{text.Value}' is not a number."),
            var other => throw new ExpressionException("type_mismatch", $"number needs text, not {other.TypeName}."),
        },
        "date" => args[0] switch
        {
            MissingValue => MissingValue.Instance,
            DateValue date => date,
            ExprValue.DateTimeValue instant => new DateValue(DateOnly.FromDateTime(instant.Value.ToOffset(context.Zone).DateTime)),
            TextValue text when TryParseDate(text.Value, out var date) => new DateValue(date),
            TextValue text when TryParseDateTime(text.Value, out var instant) => new DateValue(DateOnly.FromDateTime(instant.ToOffset(context.Zone).DateTime)),
            TextValue text => throw new ExpressionException("invalid_date", $"'{text.Value}' is not a date."),
            var other => throw new ExpressionException("type_mismatch", $"date needs text or a datetime, not {other.TypeName}."),
        },
        "time" => args[0] switch
        {
            MissingValue => MissingValue.Instance,
            TimeValue time => time,
            ExprValue.DateTimeValue instant => new TimeValue(TimeOnly.FromDateTime(instant.Value.ToOffset(context.Zone).DateTime)),
            TextValue text => TryParseTime(text.Value, out var time) ? new TimeValue(time) : throw new ExpressionException("invalid_date", $"'{text.Value}' is not a time."),
            var other => throw new ExpressionException("type_mismatch", $"time needs text or a datetime, not {other.TypeName}."),
        },
        "datetime" => DateTimeOf(args, context),
        _ => throw new ExpressionException("type_mismatch", $"Unknown function '{function}'."),
    };

    private static ExprValue Unary(IReadOnlyList<ExprValue> args, Func<decimal, decimal> operation) => args[0] switch
    {
        MissingValue => MissingValue.Instance,
        NumberValue number => new NumberValue(operation(number.Value)),
        var other => throw new ExpressionException("type_mismatch", $"Expected a number, not {other.TypeName}."),
    };

    private static ExprValue Round(IReadOnlyList<ExprValue> args)
    {
        var places = 0;
        if (args.Count == 2)
        {
            places = args[1] is NumberValue { Value: var p } && p == decimal.Truncate(p) && p is >= 0 and <= 28
                ? (int)p
                : throw new ExpressionException("type_mismatch", "round places must be a whole number from 0 to 28.");
        }

        return Unary(args, value => Math.Round(value, places, MidpointRounding.AwayFromZero));
    }

    /// <summary>Aggregates either one list argument or several number arguments.</summary>
    private static NumberValue Aggregate(IReadOnlyList<ExprValue> args, Func<List<decimal>, decimal> aggregate, bool allowsEmpty)
    {
        IEnumerable<ExprValue> items = args is [ListValue list] ? list.Items : args is [MissingValue] ? [] : args;
        var numbers = new List<decimal>();
        foreach (var item in items)
        {
            switch (item)
            {
                case MissingValue:
                    continue;
                case NumberValue number:
                    numbers.Add(number.Value);
                    break;
                default:
                    throw new ExpressionException("type_mismatch", $"Expected numbers, found {item.TypeName}.");
            }
        }

        if (numbers.Count == 0)
        {
            return allowsEmpty ? new NumberValue(0) : throw new ExpressionException("empty_list", "The list is empty.");
        }

        try
        {
            return new NumberValue(aggregate(numbers));
        }
        catch (OverflowException)
        {
            throw new ExpressionException("overflow", "The result is out of range.");
        }
    }

    // Stored dates and times are ISO text (§5.2): text arguments of datetime(date, time) are parsed strictly by position.
    private static DateOnly DateArgument(ExprValue value) => value switch
    {
        DateValue date => date.Value,
        TextValue text when TryParseDate(text.Value, out var date) => date,
        _ => throw new ExpressionException("invalid_date", $"'{((TextValue)value).Value}' is not a date."),
    };

    private static TimeOnly TimeArgument(ExprValue value) => value switch
    {
        TimeValue time => time.Value,
        TextValue text when TryParseTime(text.Value, out var time) => time,
        _ => throw new ExpressionException("invalid_date", $"'{((TextValue)value).Value}' is not a time."),
    };

    private static ExprValue DateTimeOf(IReadOnlyList<ExprValue> args, EvaluationContext context)
    {
        if (args.Count == 2)
        {
            return (args[0], args[1]) switch
            {
                (MissingValue, _) or (_, MissingValue) => MissingValue.Instance,
                (DateValue or TextValue, TimeValue or TextValue) => new ExprValue.DateTimeValue(
                    new DateTimeOffset(DateArgument(args[0]).ToDateTime(TimeArgument(args[1])), context.Zone).ToUniversalTime()),
                _ => throw new ExpressionException("type_mismatch", "datetime(date, time) needs a date and a time."),
            };
        }

        return args[0] switch
        {
            MissingValue => MissingValue.Instance,
            ExprValue.DateTimeValue instant => instant,
            TextValue text when TryParseDateTime(text.Value, out var instant) => new ExprValue.DateTimeValue(instant),
            TextValue text => throw new ExpressionException("invalid_date", $"'{text.Value}' is not a datetime."),
            var other => throw new ExpressionException("type_mismatch", $"datetime needs text, not {other.TypeName}."),
        };
    }
}
