using System.Text.Json;
using System.Text.Json.Nodes;
using Chain.Expressions;
using static Chain.Forms.Tests.SampleForm;

namespace Chain.Forms.Tests;

public sealed class TemporalNormaliseTests
{
    [Fact]
    public void Submitted_temporal_values_are_stored_in_canonical_form_at_every_depth()
    {
        var values = Store(Form(), new JsonObject
        {
            ["dia"] = "2026-10-15",
            ["hora"] = "09:00",
            ["quando"] = "2026-10-15T13:00:00-03:00",
            ["bloco"] = new JsonObject { ["hora"] = "09:00" },
            ["linhas"] = new JsonArray(new JsonObject { ["quando"] = "2026-10-15T13:00:00.100-03:00" }),
        });

        Assert.Equal("2026-10-15", values["dia"]!.GetValue<string>());
        Assert.Equal("09:00:00", values["hora"]!.GetValue<string>());
        Assert.Equal("2026-10-15T16:00:00Z", values["quando"]!.GetValue<string>());
        Assert.Equal("09:00:00", values["bloco"]!["hora"]!.GetValue<string>());
        Assert.Equal("2026-10-15T16:00:00.1Z", values["linhas"]![0]!["quando"]!.GetValue<string>());
        Assert.DoesNotContain("09:00\"", values.ToJsonString());
        Assert.DoesNotContain("-03:00", values.ToJsonString());
    }

    [Fact]
    public void Two_writings_of_the_same_instant_store_the_same_text()
    {
        var offset = Store(Form(), new JsonObject { ["dia"] = "2026-10-15", ["hora"] = "09:00", ["quando"] = "2026-10-15T13:00:00-03:00", ["bloco"] = new JsonObject { ["hora"] = "09:00:00" }, ["linhas"] = new JsonArray() });
        var utc = Store(Form(), new JsonObject { ["dia"] = "2026-10-15", ["hora"] = "09:00:00", ["quando"] = "2026-10-15T16:00:00Z", ["bloco"] = new JsonObject { ["hora"] = "09:00" }, ["linhas"] = new JsonArray() });

        Assert.Equal("2026-10-15T16:00:00Z", offset["quando"]!.GetValue<string>());
        Assert.Equal(offset["quando"]!.GetValue<string>(), utc["quando"]!.GetValue<string>());
        Assert.Equal(offset["hora"]!.GetValue<string>(), utc["hora"]!.GetValue<string>());
        Assert.Equal("09:00:00", offset["hora"]!.GetValue<string>());
        Assert.True(TextsAreEqual(offset["quando"]!.GetValue<string>(), utc["quando"]!.GetValue<string>()));
    }

    [Fact]
    public void Canonical_datetime_fractions_keep_significant_digits_only()
    {
        var values = Store(Form(), new JsonObject
        {
            ["dia"] = "2026-10-15",
            ["hora"] = "09:00:00",
            ["quando"] = "2026-10-15T16:00:00.1200000Z",
            ["bloco"] = new JsonObject { ["hora"] = "09:00:00" },
            ["linhas"] = new JsonArray(new JsonObject { ["quando"] = "2026-10-15T16:00:00.0000001Z" }),
        });

        Assert.Equal("2026-10-15T16:00:00.12Z", values["quando"]!.GetValue<string>());
        Assert.Equal("2026-10-15T16:00:00.0000001Z", values["linhas"]![0]!["quando"]!.GetValue<string>());
    }

    [Theory]
    [InlineData("quando", "\u0662\u0660\u0662\u0666-10-15T13:00:00Z")] // threw FormatException before #68
    [InlineData("quando", "2026-10-15T13:00:00.\u0661Z")] // was stored as a wrong instant before #68
    [InlineData("quando", "2026-10-15T13:00:00-\uff10\uff13:00")]
    [InlineData("dia", "\u0662\u0660\u0662\u0666-10-15")]
    [InlineData("hora", "\u0660\u0669:00")]
    [InlineData("quando", "2026-10-15T13:00:00Z\n")] // accepted before #81: in .NET, $ also matches before a final newline
    [InlineData("dia", "2026-10-15\n")]
    [InlineData("hora", "09:00\n")]
    public void Temporal_values_outside_the_iso_formats_are_a_type_mismatch(string key, string text)
    {
        var submission = new JsonObject
        {
            ["dia"] = "2026-10-15",
            ["hora"] = "09:00",
            ["quando"] = "2026-10-15T16:00:00Z",
            ["bloco"] = new JsonObject { ["hora"] = "09:00" },
            ["linhas"] = new JsonArray(),
        };
        submission[key] = text;
        using var json = JsonDocument.Parse(submission.ToJsonString());

        var result = SubmissionProcessor.Process(Parse(Form()), json.RootElement, SubmissionProcessor.EmptyObject, Now, Zone);

        var error = Assert.Single(result.Errors);
        Assert.Equal((key, "type_mismatch"), (error.Key, error.Code));
        Assert.False(result.Values.ContainsKey(key));
    }

    private static JsonObject Form() => new()
    {
        ["schemaVersion"] = 1,
        ["components"] = new JsonArray
        {
            Field("date", "dia"),
            Field("time", "hora"),
            Field("datetime", "quando"),
            new JsonObject
            {
                ["type"] = "group",
                ["key"] = "bloco",
                ["label"] = "Bloco",
                ["components"] = new JsonArray { Field("time", "hora") },
            },
            new JsonObject
            {
                ["type"] = "dynamicList",
                ["key"] = "linhas",
                ["label"] = "Linhas",
                ["components"] = new JsonArray { Field("datetime", "quando") },
            },
        },
    };

    private static bool TextsAreEqual(string left, string right)
    {
        using var data = JsonDocument.Parse(new JsonObject { ["a"] = left, ["b"] = right }.ToJsonString());
        using var tree = JsonDocument.Parse("""{"kind":"compare","left":{"kind":"path","path":["a"]},"operator":"equals","right":{"kind":"path","path":["b"]}}""");
        var parsed = ExpressionParser.ParseCondition(tree.RootElement);
        Assert.True(parsed.IsSuccess, parsed.Error?.Message);
        return Evaluator.Evaluate(parsed.Condition!, new EvaluationContext(data.RootElement, Now, Zone));
    }

    private static JsonObject Store(JsonObject form, JsonObject submission)
    {
        using var json = JsonDocument.Parse(submission.ToJsonString());
        var result = SubmissionProcessor.Process(Parse(form), json.RootElement, SubmissionProcessor.EmptyObject, Now, Zone);
        Assert.Empty(result.Errors);
        return result.Values;
    }
}
