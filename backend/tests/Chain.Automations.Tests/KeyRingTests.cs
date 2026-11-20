namespace Chain.Automations.Tests;

/// <summary>The KEK configuration, identical in .NET and Elixir (automation-contract.md §5).</summary>
public sealed class KeyRingTests
{
    private static readonly string KeyA = Convert.ToBase64String(Enumerable.Repeat((byte)1, 32).ToArray());
    private static readonly string KeyB = Convert.ToBase64String(Enumerable.Repeat((byte)2, 32).ToArray());

    [Fact]
    public void Reads_several_keys_and_the_active_one()
    {
        var ring = KeyRing.Parse($"old:{KeyA},new-2:{KeyB}", "new-2");

        Assert.Equal("new-2", ring.Active!.Id);
        Assert.Equal(["new-2", "old"], ring.Ids.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void Without_configuration_there_is_no_active_key()
    {
        Assert.Null(KeyRing.Parse(null, null).Active);
        Assert.Null(KeyRing.Parse($"old:{KeyA}", null).Active);
    }

    [Theory]
    [InlineData("old", "active")] // no key material
    [InlineData("Old:A", "Old")] // id not [a-z0-9_-]
    [InlineData("old:not-base64!", "old")]
    [InlineData("old:AAAA", "old")] // 3 bytes, not 32
    [InlineData("dup:KEY,dup:KEY", "dup")]
    [InlineData("old:KEY", "missing")] // the active id names no key
    [InlineData("", "missing")]
    public void Rejects_a_malformed_configuration_without_echoing_key_material(string keks, string active)
    {
        var configuration = keks.Replace("KEY", KeyA, StringComparison.Ordinal);

        var error = Assert.Throws<FormatException>(() => KeyRing.Parse(configuration, active));

        Assert.DoesNotContain(KeyA, error.Message, StringComparison.Ordinal);
    }
}
