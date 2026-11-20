using System.Text.Json;

namespace Chain.Forms.Tests;

/// <summary>
/// The shared format vectors (specs/testing/form-vectors/formats.json). The Angular renderer runs the same file, so the browser
/// and the server agree on every built-in format (forms.md F3).
/// </summary>
public sealed class FormatVectorTests
{
    public static TheoryData<string, string, bool> Cases()
    {
        using var file = File.OpenRead(Path.Combine(AppContext.BaseDirectory, "form-vectors", "formats.json"));
        using var json = JsonDocument.Parse(file);
        var cases = new TheoryData<string, string, bool>();
        foreach (var item in json.RootElement.GetProperty("cases").EnumerateArray())
        {
            cases.Add(item.GetProperty("format").GetString()!, item.GetProperty("value").GetString()!, item.GetProperty("valid").GetBoolean());
        }

        return cases;
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void Formats_follow_the_shared_vectors(string format, string value, bool valid) =>
        Assert.Equal(valid, Formats.IsValid(format, value));
}
