using System.Text.Json;
using System.Text.Json.Nodes;

namespace Chain.Expressions.Tests;

/// <summary>Structural rules of expression trees (expression-language.md §5.1).</summary>
public sealed class ParserTests
{
    [Theory]
    [InlineData("""{"kind":"compare","left":{"kind":"path","path":["a"]},"operator":"like","right":{"kind":"literal","type":"text","value":"x"}}""")]
    [InlineData("""{"kind":"compare","left":{"kind":"path","path":["a"]},"operator":"equals"}""")]
    [InlineData("""{"kind":"compare","left":{"kind":"path","path":["a"]},"operator":"isEmpty","right":{"kind":"literal","type":"text","value":"x"}}""")]
    [InlineData("""{"kind":"group","op":"xor","items":[]}""")]
    [InlineData("""{"kind":"script","code":"alert(1)"}""")]
    [InlineData("""{"kind":"compare","left":{"kind":"literal","type":"number","value":"1,5"},"operator":"equals","right":{"kind":"literal","type":"number","value":"1"}}""")]
    [InlineData("""{"kind":"compare","left":{"kind":"path","path":[]},"operator":"isEmpty"}""")]
    [InlineData("""{"kind":"compare","left":{"kind":"system","name":"tomorrow"},"operator":"isEmpty"}""")]
    [InlineData("""{"kind":"compare","left":{"kind":"call","function":"eval","args":[]},"operator":"isEmpty"}""")]
    [InlineData("""{"kind":"compare","left":{"kind":"call","function":"abs","args":[]},"operator":"isEmpty"}""")]
    [InlineData("""{"kind":"compare","left":{"kind":"system","name":"currentDate","offset":{"amount":1,"unit":"weeks"}},"operator":"isEmpty"}""")]
    [InlineData("""{"kind":"compare","left":{"kind":"literal","type":"text","value":"x","offset":{"amount":1,"unit":"days"}},"operator":"isEmpty"}""")]
    public void Malformed_conditions_are_rejected(string json)
    {
        using var document = JsonDocument.Parse(json);

        Assert.False(ExpressionParser.ParseCondition(document.RootElement).IsSuccess);
    }

    // .NET's parser ignores a trailing NUL and read "12\0" as 12; the TypeScript parser refuses it (#126).
    [Fact]
    public void A_number_literal_ending_in_NUL_does_not_parse()
    {
        var literal = new JsonObject { ["kind"] = "literal", ["type"] = "number", ["value"] = "12\0" };
        using var document = JsonDocument.Parse(literal.ToJsonString());

        Assert.False(ExpressionParser.ParseValue(document.RootElement).IsSuccess);
    }

    [Fact]
    public void Groups_nest_at_most_ten_levels()
    {
        Assert.True(Parse(NestedGroups(10)).IsSuccess);
        Assert.False(Parse(NestedGroups(11)).IsSuccess);
    }

    [Fact]
    public void At_most_fifty_comparisons()
    {
        Assert.True(Parse(ManyComparisons(50)).IsSuccess);
        Assert.False(Parse(ManyComparisons(51)).IsSuccess);
    }

    [Fact]
    public void Value_trees_nest_at_most_ten_levels()
    {
        var value = """{"kind":"literal","type":"number","value":"1"}""";
        for (var i = 0; i < 11; i++)
        {
            value = $$"""{"kind":"call","function":"abs","args":[{{value}}]}""";
        }

        using var document = JsonDocument.Parse(value);
        Assert.False(ExpressionParser.ParseValue(document.RootElement).IsSuccess);
    }

    private static ConditionParseResult Parse(string json)
    {
        using var document = JsonDocument.Parse(json);
        return ExpressionParser.ParseCondition(document.RootElement);
    }

    private static string NestedGroups(int depth)
    {
        var json = """{"kind":"compare","left":{"kind":"path","path":["a"]},"operator":"isEmpty"}""";
        for (var i = 0; i < depth; i++)
        {
            json = $$"""{"kind":"group","op":"and","items":[{{json}}]}""";
        }

        return json;
    }

    private static string ManyComparisons(int count) =>
        $$"""{"kind":"group","op":"or","items":[{{string.Join(',', Enumerable.Repeat("""{"kind":"compare","left":{"kind":"path","path":["a"]},"operator":"isEmpty"}""", count))}}]}""";
}
