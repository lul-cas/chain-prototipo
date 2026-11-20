using System.Text.Json;

namespace Chain.Forms.Tests;

/// <summary>Modeler patterns, matched against the whole value (forms.md F1, "Patterns").</summary>
public sealed class PatternTests
{
    public static TheoryData<string, string, bool> Cases()
    {
        using var file = File.OpenRead(Path.Combine(AppContext.BaseDirectory, "form-vectors", "patterns.json"));
        using var json = JsonDocument.Parse(file);
        var cases = new TheoryData<string, string, bool>();
        foreach (var item in json.RootElement.GetProperty("cases").EnumerateArray())
        {
            cases.Add(item.GetProperty("pattern").GetString()!, item.GetProperty("value").GetString()!, item.GetProperty("valid").GetBoolean());
        }

        return cases;
    }

    /// <summary>The shared vectors (specs/testing/form-vectors/patterns.json), which the Angular renderer runs too.</summary>
    [Theory]
    [MemberData(nameof(Cases))]
    public void Patterns_follow_the_shared_vectors(string pattern, string value, bool valid) =>
        Assert.Equal(valid, Patterns.IsMatch(pattern, value, out _));

    // The server reads a $ as \z only where .NET's parser takes it as an anchor (#125). These constructs are read that way by
    // .NET alone, so they can't be shared vectors: a ] right after [ is literal, -[ subtracts a class, (?# starts a comment
    // that ends at the first ), and \c takes the next character, even a backslash.
    [Theory]
    [InlineData("[]$]", "$", true)]              // the class holds ] and $
    [InlineData("[^]$]", "a", true)]
    [InlineData("[a-z-[]$]]", "b", true)]        // a to z without ] and $
    [InlineData("(?#[)a$\\n", "a\n", false)]    // the [ is in the comment, so the $ is an anchor
    [InlineData("(?#$)a", "a", true)]
    [InlineData("\\c\\$\\n", "\x1C\n", false)]  // \c\ is U+001C, so the $ is an anchor
    [InlineData("a$+\\n", "a\n", false)]        // a quantified anchor
    public void A_dollar_is_an_anchor_where_dotnet_reads_one(string pattern, string value, bool valid) =>
        Assert.Equal(valid, Patterns.IsMatch(pattern, value, out _));
}
