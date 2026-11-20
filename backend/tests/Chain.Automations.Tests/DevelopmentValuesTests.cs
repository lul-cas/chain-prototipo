using System.Text.Json;

namespace Chain.Automations.Tests;

/// <summary>
/// The development KEK and result token that docker-compose.yml supplies by default, which the API refuses outside Development
/// (automation.md §4.1, card #164). The values come from the shared fixture, which Elixir checks against docker-compose.yml.
/// </summary>
public sealed class DevelopmentValuesTests
{
    private static readonly JsonElement Fixture =
        JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "contract", "development-values.json"))).RootElement;

    private static readonly string OtherKey = Convert.ToBase64String(Enumerable.Repeat((byte)7, 32).ToArray());

    private static string Material => Fixture.GetProperty("keks").GetString()!.Split(':', 2)[1];

    private static string TokenHash => Fixture.GetProperty("resultTokenSha256").GetString()!;

    [Fact]
    public void The_development_key_is_found_under_any_id_and_named_without_its_material()
    {
        var found = DevelopmentValues.Find(KeyRing.Parse($"k2026-10:{Material},other:{OtherKey}", "other"), resultTokenSha256: null);

        var finding = Assert.Single(found);
        Assert.Contains("Chain:Automation:Keks", finding, StringComparison.Ordinal);
        Assert.Contains("'k2026-10'", finding, StringComparison.Ordinal);
        Assert.DoesNotContain(Material, finding, StringComparison.Ordinal);
    }

    [Fact]
    public void The_development_token_hash_is_found_in_either_case_and_named_without_it()
    {
        foreach (var hash in new[] { TokenHash, TokenHash.ToUpperInvariant() })
        {
            var finding = Assert.Single(DevelopmentValues.Find(KeyRing.Parse(null, null), hash));
            Assert.Contains("Chain:Automation:ResultTokenSha256", finding, StringComparison.Ordinal);
            Assert.DoesNotContain(TokenHash, finding, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public void Other_keys_and_hashes_are_not_development_values()
    {
        // The id alone doesn't count: a real key may be called "dev", and the development key may have any id.
        Assert.Empty(DevelopmentValues.Find(KeyRing.Parse($"dev:{OtherKey}", "dev"), new string('a', 64)));
        Assert.Empty(DevelopmentValues.Find(KeyRing.Parse(null, null), null));
    }
}
