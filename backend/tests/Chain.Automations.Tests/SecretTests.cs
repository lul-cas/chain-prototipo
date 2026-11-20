namespace Chain.Automations.Tests;

/// <summary>Secret rules of automation.md §4.1 (ADR-0012 Part 1).</summary>
public sealed class SecretTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 16, 12, 0, 0, TimeSpan.Zero);
    private static readonly KeyRing Ring = KeyRing.Parse("dev:" + Convert.ToBase64String(new byte[32]), "dev");

    [Theory]
    [InlineData("erp_api_key", "token", null)]
    [InlineData("Erp", "token", "invalid_name")]
    [InlineData("erp", "", "value_required")]
    [InlineData("erp", null, "value_required")]
    public void Values_and_names_are_checked(string name, string? value, string? error)
    {
        var errors = Secret.Validate(name, null, value, []);

        Assert.Equal(error is null ? [] : [error], errors);
    }

    [Fact]
    public void A_value_without_a_UTF8_form_is_invalid()
    {
        // Built in code: xUnit's theory serialization would replace a lone surrogate in [InlineData].
        Assert.Equal(["invalid_value"], Secret.Validate("erp", null, "token" + (char)0xD800, []));
    }

    [Fact]
    public void Values_are_1_to_8192_UTF8_bytes()
    {
        Assert.Empty(Secret.Validate("erp", null, new string('a', 8192), []));
        Assert.Equal(["value_too_long"], Secret.Validate("erp", null, new string('a', 8193), []));
        Assert.Equal(["value_too_long"], Secret.Validate("erp", null, new string('é', 4097), [])); // 8194 bytes
    }

    [Fact]
    public void Allowed_destinations_are_distinct_names()
    {
        Assert.Equal(["duplicate_destination"], Secret.Validate("erp", null, "token", ["erp", "erp"]));
        Assert.Equal(["invalid_destination_name"], Secret.Validate("erp", null, "token", ["ERP"]));
        Assert.Equal(["description_too_long"], Secret.Validate("erp", new string('d', 501), "token", []));
    }

    [Fact]
    public void A_new_secret_is_version_1_sealed_for_its_name_and_version()
    {
        var secret = Secret.Create("erp_api_key", "ERP", ["erp"], Ring.Active!, "token", Guid.CreateVersion7(Now), Now);

        Assert.Equal((1, "dev"), (secret.Version, secret.KeyId));
        Assert.Equal("token", SecretEnvelope.Open(Ring, "erp_api_key", 1, secret.Sealed));
    }

    [Fact]
    public void Rotating_seals_the_new_value_under_the_next_version()
    {
        var secret = Secret.Create("erp_api_key", null, ["erp"], Ring.Active!, "token", Guid.CreateVersion7(Now), Now);

        secret.Rotate(Ring.Active!, "new-token", Now.AddDays(1));

        Assert.Equal(2, secret.Version);
        Assert.Equal(Now.AddDays(1), secret.RotatedAt);
        Assert.Equal("new-token", SecretEnvelope.Open(Ring, "erp_api_key", 2, secret.Sealed));
    }

    [Fact]
    public void Removing_a_destination_drops_it_from_the_allowed_list()
    {
        var secret = Secret.Create("erp_api_key", null, ["erp", "crm"], Ring.Active!, "token", Guid.CreateVersion7(Now), Now);

        Assert.True(secret.RemoveDestination("erp", Now.AddHours(1)));
        Assert.False(secret.RemoveDestination("erp", Now.AddHours(2)));

        Assert.Equal(["crm"], secret.AllowedDestinations);
    }
}
