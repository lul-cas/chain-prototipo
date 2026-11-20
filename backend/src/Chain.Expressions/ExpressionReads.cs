namespace Chain.Expressions;

/// <summary>The top-level keys a condition or an expression reads: the first segment of each path in it (sensitive-data.md §7).</summary>
public static class ExpressionReads
{
    public static IEnumerable<string> Keys(ConditionNode condition) => condition switch
    {
        GroupNode group => group.Items.SelectMany(Keys),
        CompareNode compare => compare.Right is { } right ? Keys(compare.Left).Concat(Keys(right)) : Keys(compare.Left),
        _ => [],
    };

    public static IEnumerable<string> Keys(ValueNode value) => value switch
    {
        PathNode { Segments: [var first, ..] } => [first],
        CallNode call => call.Args.SelectMany(Keys),
        ArithmeticNode arithmetic => Keys(arithmetic.Left).Concat(Keys(arithmetic.Right)),
        _ => [],
    };
}
