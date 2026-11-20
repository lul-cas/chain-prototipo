namespace Chain.Expressions;

/// <summary>A definite type error found at publish time (workflow-definition.md §6.4).</summary>
public sealed record TypeIssue(string Message);

/// <summary>
/// Publish-time type checking of condition and value trees (workflow-definition.md §6.4). Conservative: <see cref="ExprType.Unknown"/>
/// is compatible with everything, so only expressions that fail for every value of their declared types are reported.
/// </summary>
public static class TypeChecker
{
    private static readonly HashSet<string> Ordering = new(StringComparer.Ordinal) { "greaterThan", "lessThan", "greaterOrEqual", "lessOrEqual" };

    /// <summary>Checks a condition against <paramref name="data"/>, the object type of the instance data.</summary>
    public static IReadOnlyList<TypeIssue> Check(ConditionNode condition, ExprType data)
    {
        ArgumentNullException.ThrowIfNull(condition);
        ArgumentNullException.ThrowIfNull(data);
        var issues = new List<TypeIssue>();
        CheckCondition(condition, data, issues);
        return issues;
    }

    /// <summary>Infers the type of a value tree, adding any definite type errors to <paramref name="issues"/>.</summary>
    public static ExprType Infer(ValueNode value, ExprType data, ICollection<TypeIssue> issues)
    {
        ArgumentNullException.ThrowIfNull(value);
        ArgumentNullException.ThrowIfNull(data);
        ArgumentNullException.ThrowIfNull(issues);
        var type = value switch
        {
            PathNode path => Resolve(data, path.Segments),
            LiteralNode literal => OfLiteral(literal.Value),
            SystemNode { Name: "currentDate" } => ExprType.Date,
            SystemNode => ExprType.DateTime,
            ArithmeticNode arithmetic => Arithmetic(arithmetic, data, issues),
            CallNode call => Call(call, [.. call.Args.Select(a => Infer(a, data, issues))], issues),
            _ => throw new ArgumentOutOfRangeException(nameof(value)),
        };

        return value.Offset is { } offset ? Offset(type, offset, issues) : type;
    }

    /// <summary>The type of a path read from <paramref name="data"/>; unknown keys and impossible steps are <see cref="ExprType.Unknown"/>.</summary>
    public static ExprType Resolve(ExprType data, IReadOnlyList<string> path)
    {
        ArgumentNullException.ThrowIfNull(data);
        ArgumentNullException.ThrowIfNull(path);
        var current = data;
        for (var i = 0; i < path.Count; i++)
        {
            if (path[i] == "[]")
            {
                // A projection: the rest of the path applies to each row (expression-language.md §3b).
                return current.Kind == TypeKind.List ? ExprType.ListOf(Resolve(current.Element!, [.. path.Skip(i + 1)])) : ExprType.Unknown;
            }

            // TC-1: a key that is never written, or a step into a non-object, reads as missing; its type is unknown.
            if (current.Kind != TypeKind.Record || !current.Fields.TryGetValue(path[i], out var field))
            {
                return ExprType.Unknown;
            }

            current = field.Type;
        }

        return current;
    }

    // Conditions (expression-language.md §3)

    private static void CheckCondition(ConditionNode condition, ExprType data, List<TypeIssue> issues)
    {
        switch (condition)
        {
            case GroupNode group:
                foreach (var item in group.Items)
                {
                    CheckCondition(item, data, issues);
                }

                break;
            case CompareNode compare:
                var left = Infer(compare.Left, data, issues);
                if (compare.Right is null)
                {
                    return; // isEmpty / isNotEmpty accept anything
                }

                var right = Infer(compare.Right, data, issues);
                if (!Comparable(compare.Operator, left, right))
                {
                    issues.Add(new TypeIssue($"Cannot compare {left} with {right} using '{compare.Operator}'."));
                }

                break;
        }
    }

    private static bool Comparable(string op, ExprType left, ExprType right)
    {
        if (op == "contains")
        {
            return left.Kind switch
            {
                TypeKind.Unknown => true,
                TypeKind.Text => right.IsUnknown || right.Kind == TypeKind.Text,
                TypeKind.List => Equatable(left.Element!, right),
                _ => false,
            };
        }

        if (Ordering.Contains(op))
        {
            return Equatable(left, right) && (left.IsUnknown || right.IsUnknown || Orderable(left) || Orderable(right));
        }

        return Equatable(left, right); // equals, notEquals
    }

    /// <summary>Two values <c>equals</c> can compare: scalars of the same type, or text with a temporal value (TC-4).</summary>
    private static bool Equatable(ExprType left, ExprType right)
    {
        if (left.IsUnknown || right.IsUnknown)
        {
            return true;
        }

        if (!left.IsScalar || !right.IsScalar)
        {
            return false;
        }

        return left.Kind == right.Kind
            || (left.Kind == TypeKind.Text && right.IsTemporal)
            || (right.Kind == TypeKind.Text && left.IsTemporal);
    }

    /// <summary>Types the ordering operators accept; text only counts when the other side is temporal.</summary>
    private static bool Orderable(ExprType type) => type.Kind == TypeKind.Number || type.IsTemporal;

    // Values

    private static ExprType OfLiteral(ExprValue value) => value switch
    {
        ExprValue.TextValue => ExprType.Text,
        ExprValue.NumberValue => ExprType.Number,
        ExprValue.BoolValue => ExprType.Boolean,
        ExprValue.DateValue => ExprType.Date,
        ExprValue.DateTimeValue => ExprType.DateTime,
        ExprValue.TimeValue => ExprType.Time,
        _ => ExprType.Unknown,
    };

    private static ExprType Arithmetic(ArithmeticNode node, ExprType data, ICollection<TypeIssue> issues)
    {
        var left = Infer(node.Left, data, issues);
        var right = Infer(node.Right, data, issues);
        if (!Is(left, TypeKind.Number) || !Is(right, TypeKind.Number))
        {
            issues.Add(new TypeIssue($"Arithmetic '{node.Op}' needs numbers, not {left} and {right}."));
        }

        return ExprType.Number;
    }

    private static ExprType Offset(ExprType type, DateOffset offset, ICollection<TypeIssue> issues)
    {
        if (!Is(type, TypeKind.Date, TypeKind.DateTime, TypeKind.Text))
        {
            issues.Add(new TypeIssue($"A {type} cannot carry a date offset."));
            return type;
        }

        if (type.Kind == TypeKind.Date && offset.Unit is "hours" or "minutes")
        {
            issues.Add(new TypeIssue("A date moves by days, months or years."));
        }

        return type.Kind == TypeKind.Text ? ExprType.Unknown : type;
    }

    /// <summary>Argument types of the functions (expression-language.md §3b); returns the result type.</summary>
    private static ExprType Call(CallNode call, IReadOnlyList<ExprType> args, ICollection<TypeIssue> issues)
    {
        void Need(bool ok, string expected)
        {
            if (!ok)
            {
                issues.Add(new TypeIssue($"'{call.Function}' needs {expected}, not ({string.Join(", ", args)})."));
            }
        }

        switch (call.Function)
        {
            case "abs" or "floor" or "ceil":
                Need(Is(args[0], TypeKind.Number), "a number");
                return ExprType.Number;
            case "round":
                Need(args.All(a => Is(a, TypeKind.Number)), "numbers");
                return ExprType.Number;
            case "min" or "max" or "sum" or "avg":
                Need(args.Count == 1
                    ? Is(args[0], TypeKind.Number) || (args[0].Kind == TypeKind.List && Is(args[0].Element!, TypeKind.Number))
                    : args.All(a => Is(a, TypeKind.Number)), "numbers or a list of numbers");
                return ExprType.Number;
            case "count":
                Need(Is(args[0], TypeKind.List), "a list");
                return ExprType.Number;
            case "string":
                Need(args[0].IsUnknown || args[0].IsScalar, "a single value");
                return ExprType.Text;
            case "number":
                Need(Is(args[0], TypeKind.Text, TypeKind.Number), "text or a number");
                return ExprType.Number;
            case "date":
                Need(Is(args[0], TypeKind.Text, TypeKind.Date, TypeKind.DateTime), "text, a date or a datetime");
                return ExprType.Date;
            case "time":
                Need(Is(args[0], TypeKind.Text, TypeKind.Time, TypeKind.DateTime), "text, a time or a datetime");
                return ExprType.Time;
            case "datetime":
                Need(args.Count == 2
                    ? Is(args[0], TypeKind.Date, TypeKind.Text) && Is(args[1], TypeKind.Time, TypeKind.Text)
                    : Is(args[0], TypeKind.Text, TypeKind.DateTime), "text or a datetime, or a date and a time");
                return ExprType.DateTime;
            default:
                return ExprType.Unknown;
        }
    }

    private static bool Is(ExprType type, params TypeKind[] kinds) => type.IsUnknown || kinds.Contains(type.Kind);
}
