using System.Text.Json;

namespace Chain.Forms.Tests;

/// <summary>
/// The pattern allowlist of forms.md F1 (FM005; owner decision on card #149): only constructs that .NET and JavaScript read
/// alike, from the vectors the designer runs too (specs/testing/form-vectors/pattern-subset.json).
/// </summary>
public sealed class PatternSubsetTests
{
    public static TheoryData<string, bool, string?, string?> Cases()
    {
        using var file = File.OpenRead(Path.Combine(AppContext.BaseDirectory, "form-vectors", "pattern-subset.json"));
        using var json = JsonDocument.Parse(file);
        var cases = new TheoryData<string, bool, string?, string?>();
        foreach (var item in json.RootElement.GetProperty("cases").EnumerateArray())
        {
            cases.Add(
                item.GetProperty("pattern").GetString()!,
                item.GetProperty("allowed").GetBoolean(),
                item.TryGetProperty("construct", out var construct) ? construct.GetString() : null,
                item.TryGetProperty("replacement", out var replacement) ? replacement.GetString() : null);
        }

        return cases;
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void The_allowlist_follows_the_shared_vectors(string pattern, bool allowed, string? construct, string? replacement)
    {
        var refused = PatternSubset.FirstRefused(pattern);

        Assert.Equal(allowed ? (null, null) : (construct, replacement), (refused?.Construct, refused?.Replacement));
    }

    [Fact]
    public void FM005_names_the_construct_and_its_replacement()
    {
        Assert.Equal("Patterns may not use '\\d' (forms.md F1): write [0-9] instead.", Patterns.Check("\\d{3}"));
        Assert.Equal("Patterns may not use '(?<=' (forms.md F1).", Patterns.Check("(?<=a)b"));
        Assert.Null(Patterns.Check("[0-9]{3}"));
        Assert.Equal("The pattern does not compile.", Patterns.Check("[a-")); // every construct is allowed, but the class never ends
    }
}
