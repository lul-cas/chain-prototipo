using System.Text.Json;

namespace Chain.Expressions.Tests;

/// <summary>Runs every shared conformance vector (specs/testing/expression-vectors, expression-language.md §7).</summary>
public sealed class ConformanceTests
{
    public static TheoryData<string> Cases()
    {
        var data = new TheoryData<string>();
        foreach (var file in VectorFiles())
        {
            using var document = JsonDocument.Parse(File.ReadAllText(file));
            foreach (var testCase in document.RootElement.GetProperty("cases").EnumerateArray())
            {
                data.Add($"{Path.GetFileName(file)}::{testCase.GetProperty("name").GetString()}");
            }
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void Vector(string id)
    {
        var (fileName, name) = (id[..id.IndexOf("::", StringComparison.Ordinal)], id[(id.IndexOf("::", StringComparison.Ordinal) + 2)..]);
        using var document = JsonDocument.Parse(File.ReadAllText(VectorFiles().Single(f => Path.GetFileName(f) == fileName)));
        var root = document.RootElement;
        var testCase = root.GetProperty("cases").EnumerateArray().Single(c => c.GetProperty("name").GetString() == name);
        var now = DateTimeOffset.Parse((testCase.TryGetProperty("now", out var n) ? n : root.GetProperty("now")).GetString()!, System.Globalization.CultureInfo.InvariantCulture);
        var zone = TimeSpan.Parse(root.GetProperty("zone").GetString()!.TrimStart('+'), System.Globalization.CultureInfo.InvariantCulture);
        var context = new EvaluationContext(root.GetProperty("data"), now, zone);
        var expect = testCase.GetProperty("expect");

        object? Run()
        {
            if (testCase.TryGetProperty("condition", out var condition))
            {
                var parsed = ExpressionParser.ParseCondition(condition);
                Assert.True(parsed.IsSuccess, parsed.Error?.Message);
                return Evaluator.Evaluate(parsed.Condition!, context);
            }

            var value = ExpressionParser.ParseValue(testCase.GetProperty("value"));
            Assert.True(value.IsSuccess, value.Error?.Message);
            return Evaluator.Evaluate(value.Value!, context);
        }

        if (expect.TryGetProperty("error", out var error))
        {
            var exception = Assert.Throws<ExpressionException>(() => Run());
            Assert.Equal(error.GetString(), exception.Code);
        }
        else if (expect.TryGetProperty("result", out var result))
        {
            Assert.Equal(result.GetBoolean(), Run());
        }
        else
        {
            var value = Assert.IsAssignableFrom<ExprValue>(Run());
            Assert.Equal(expect.GetProperty("type").GetString(), value.TypeName);
            Assert.Equal(expect.GetProperty("value").GetString(), value.ToCanonicalString());
        }
    }

    private static string[] VectorFiles() => Directory.GetFiles(Path.Combine(AppContext.BaseDirectory, "vectors"), "*.json");
}
