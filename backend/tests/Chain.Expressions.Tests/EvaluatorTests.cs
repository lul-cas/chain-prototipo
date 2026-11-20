using System.Text.Json;

namespace Chain.Expressions.Tests;

/// <summary>
/// Regression tests for card #46: temporal values are stored as ISO text (expression-language.md §5.2), so two stored
/// date fields reach the evaluator as two texts. Ordering them, or combining them with datetime(date, time), must work.
/// </summary>
public sealed class EvaluatorTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 15, 12, 0, 0, TimeSpan.Zero);
    private static readonly TimeSpan Zone = TimeSpan.FromHours(-3);

    [Theory]
    [InlineData("2026-01-01", "lessThan", "2026-02-01", true)]
    [InlineData("2026-01-01", "greaterThan", "2026-02-01", false)]
    [InlineData("2026-02-01", "greaterOrEqual", "2026-02-01", true)]
    [InlineData("2026-03-01", "lessOrEqual", "2026-02-01", false)]
    [InlineData("10:30", "lessThan", "10:30:01", true)]
    [InlineData("09:00", "greaterOrEqual", "18:00", false)]
    // The same instant written with two offsets: compared as instants, not as text.
    [InlineData("2026-10-15T12:00:00Z", "greaterOrEqual", "2026-10-15T09:00:00-03:00", true)]
    [InlineData("2026-10-15T12:00:00Z", "greaterThan", "2026-10-15T09:00:00-03:00", false)]
    public void Orders_two_stored_temporal_texts_as_that_temporal_type(string a, string op, string b, bool expected)
    {
        Assert.Equal(expected, Evaluator.Evaluate(Compare("a", op, "b"), Context(new { a, b })));
    }

    [Theory]
    [InlineData("2026-01-01", "2026-01-01T10:00:00Z")] // date with datetime: an error, as in §3
    [InlineData("2026-01-01", "10:00")]
    [InlineData("aprovado", "reprovado")] // plain text still has no order
    [InlineData("2026-01-01", "01/02/2026")]
    public void Ordering_two_texts_that_are_not_the_same_temporal_type_is_a_type_mismatch(string a, string b)
    {
        var error = Assert.Throws<ExpressionException>(() => Evaluator.Evaluate(Compare("a", "lessThan", "b"), Context(new { a, b })));
        Assert.Equal("type_mismatch", error.Code);
    }

    [Fact]
    public void Equality_of_two_texts_stays_exact_text_equality()
    {
        var context = Context(new { a = "2026-10-15T12:00:00Z", b = "2026-10-15T09:00:00-03:00" });
        Assert.False(Evaluator.Evaluate(Compare("a", "equals", "b"), context));
    }

    [Fact]
    public void Datetime_of_a_stored_date_and_a_stored_time_is_interpreted_in_the_evaluation_zone()
    {
        var value = Evaluator.Evaluate(Call("datetime", Path("d"), Path("t")), Context(new { d = "2026-10-15", t = "09:00" }));
        Assert.Equal("datetime", value.TypeName);
        Assert.Equal("2026-10-15T12:00:00Z", value.ToCanonicalString());
    }

    [Theory]
    [InlineData("15/10/2026", "09:00")]
    [InlineData("2026-10-15", "9h")]
    public void Datetime_of_unparsable_stored_text_is_an_invalid_date(string d, string t)
    {
        var error = Assert.Throws<ExpressionException>(() => Evaluator.Evaluate(Call("datetime", Path("d"), Path("t")), Context(new { d, t })));
        Assert.Equal("invalid_date", error.Code);
    }

    private static EvaluationContext Context(object data) => new(JsonSerializer.SerializeToElement(data), Now, Zone);

    private static ConditionNode Compare(string left, string op, string right) =>
        Parse($$"""{ "kind": "compare", "left": { "kind": "path", "path": ["{{left}}"] }, "operator": "{{op}}", "right": { "kind": "path", "path": ["{{right}}"] } }""");

    private static string Path(string key) => $$"""{ "kind": "path", "path": ["{{key}}"] }""";

    private static ValueNode Call(string function, params string[] args)
    {
        using var document = JsonDocument.Parse($$"""{ "kind": "call", "function": "{{function}}", "args": [{{string.Join(',', args)}}] }""");
        var parsed = ExpressionParser.ParseValue(document.RootElement);
        Assert.True(parsed.IsSuccess, parsed.Error?.Message);
        return parsed.Value!;
    }

    private static ConditionNode Parse(string json)
    {
        using var document = JsonDocument.Parse(json);
        var parsed = ExpressionParser.ParseCondition(document.RootElement);
        Assert.True(parsed.IsSuccess, parsed.Error?.Message);
        return parsed.Condition!;
    }
}
