namespace Chain.Identity.Tests;

/// <summary>Domain rules of identity increment I2 (specs/modules/identity.md).</summary>
public sealed class DisplayNameTests
{
    [Theory]
    [InlineData("Ana Souza", "Ana Souza")]
    [InlineData("  João da Silva  ", "João da Silva")]
    public void Valid_display_names_are_trimmed(string raw, string expected)
    {
        Assert.True(DisplayName.TryCreate(raw, out var name));
        Assert.Equal(expected, name.Value);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void Blank_display_names_are_rejected(string? raw)
    {
        Assert.False(DisplayName.TryCreate(raw, out _));
    }

    [Fact]
    public void Display_name_length_limit_is_200()
    {
        Assert.True(DisplayName.TryCreate(new string('a', 200), out _));
        Assert.False(DisplayName.TryCreate(new string('a', 201), out _));
    }

    // Regression #129: PostgreSQL text cannot store the NUL character, so saving a display name with one failed in the database.

    [Fact]
    public void Display_names_postgresql_cannot_store_are_rejected()
    {
        Assert.False(DisplayName.TryCreate("Ana\u0000Souza", out _));
        Assert.False(DisplayName.TryCreate("Ana\ud800", out _)); // an unpaired surrogate is not Unicode text
        Assert.True(DisplayName.TryCreate("Ana 😀", out _));
    }
}

public sealed class GroupNameTests
{
    [Fact]
    public void Group_name_is_trimmed_and_keeps_its_case()
    {
        Assert.True(GroupName.TryCreate("  Análise de Crédito ", out var name));
        Assert.Equal("Análise de Crédito", name.Value);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("  ")]
    public void Blank_group_names_are_rejected(string? raw)
    {
        Assert.False(GroupName.TryCreate(raw, out _));
    }

    [Fact]
    public void Group_name_length_limit_is_100()
    {
        Assert.True(GroupName.TryCreate(new string('g', 100), out _));
        Assert.False(GroupName.TryCreate(new string('g', 101), out _));
    }

    // Regression #129: PostgreSQL text cannot store the NUL character, so saving a group name with one failed in the database.

    [Fact]
    public void Group_names_postgresql_cannot_store_are_rejected()
    {
        Assert.False(GroupName.TryCreate("Análise\u0000", out _));
        Assert.False(GroupName.TryCreate("\udc00Análise", out _));
    }
}

public sealed class UserAdministrationTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 15, 9, 0, 0, TimeSpan.Zero);

    private static User NewUser(bool isAdmin = false) =>
        User.CreateByAdmin(Username.Create("ana.souza"), DisplayName.Create("Ana Souza"), "temp-hash", isAdmin, Now);

    [Fact]
    public void User_created_by_admin_must_change_the_temporary_password()
    {
        var user = NewUser();

        Assert.Equal("ana.souza", user.Username);
        Assert.Equal("Ana Souza", user.DisplayName);
        Assert.True(user.IsActive);
        Assert.False(user.IsAdmin);
        Assert.True(user.MustChangePassword);
    }

    [Fact]
    public void Deactivate_and_activate_toggle_the_flag()
    {
        var user = NewUser();

        user.Deactivate(Now.AddMinutes(1));
        Assert.False(user.IsActive);

        user.Activate(Now.AddMinutes(2));
        Assert.True(user.IsActive);
        Assert.Equal(Now.AddMinutes(2), user.UpdatedAt);
    }

    [Fact]
    public void Reset_password_forces_change_and_clears_the_lockout()
    {
        var user = NewUser();
        user.ChangePassword("own-hash", Now);

        user.ResetPassword("new-temp-hash", Now.AddMinutes(1));

        Assert.True(user.MustChangePassword);
        Assert.Equal("new-temp-hash", user.PasswordHash);
        Assert.Equal(0, user.FailedLoginCount);
        Assert.Null(user.LockedUntil);
    }

    [Fact]
    public void Update_changes_display_name_and_admin_flag()
    {
        var user = NewUser();

        user.Rename(DisplayName.Create("Ana S."), Now.AddMinutes(1));
        user.SetAdmin(true, Now.AddMinutes(1));

        Assert.Equal("Ana S.", user.DisplayName);
        Assert.True(user.IsAdmin);
    }
}

public sealed class GroupTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 15, 9, 0, 0, TimeSpan.Zero);

    [Fact]
    public void New_group_is_active()
    {
        var group = Group.Create(GroupName.Create("Análise de Crédito"), "Analistas", Now);

        Assert.Equal("Análise de Crédito", group.Name);
        Assert.Equal("Analistas", group.Description);
        Assert.False(group.IsArchived);
    }

    [Fact]
    public void Description_is_optional_and_limited_to_500_characters()
    {
        Assert.Null(Group.Create(GroupName.Create("G"), "  ", Now).Description);
        Assert.Throws<ArgumentException>(() => Group.Create(GroupName.Create("G"), new string('d', 501), Now));
    }

    [Fact]
    public void Archive_and_unarchive_toggle_the_flag()
    {
        var group = Group.Create(GroupName.Create("Comitê"), null, Now);

        group.Archive(Now.AddMinutes(1));
        Assert.True(group.IsArchived);

        group.Unarchive(Now.AddMinutes(2));
        Assert.False(group.IsArchived);
    }
}

public sealed class BotTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 15, 9, 0, 0, TimeSpan.Zero);

    private static User NewBot() => User.CreateBot(Username.Create("integracao-erp"), DisplayName.Create("Integração ERP"), Guid.NewGuid(), Now);

    [Fact]
    public void Bot_has_no_password_and_is_not_admin()
    {
        var bot = NewBot();

        Assert.True(bot.IsBot);
        Assert.Null(bot.PasswordHash);
        Assert.False(bot.IsAdmin);
        Assert.False(bot.MustChangePassword);
    }

    [Fact]
    public void Bot_can_never_become_admin()
    {
        Assert.Throws<InvalidOperationException>(() => NewBot().SetAdmin(true, Now));
    }

    [Fact]
    public void Bot_starts_without_mcp_and_can_be_switched_both_ways()
    {
        var bot = NewBot();
        Assert.False(bot.McpEnabled);

        bot.SetMcpEnabled(true, Now.AddMinutes(1));
        Assert.True(bot.McpEnabled);
        Assert.Equal(Now.AddMinutes(1), bot.UpdatedAt);

        bot.SetMcpEnabled(false, Now.AddMinutes(2));
        Assert.False(bot.McpEnabled);
    }

    [Fact]
    public void Only_bots_can_use_mcp()
    {
        var user = User.CreateByAdmin(Username.Create("ana"), DisplayName.Create("Ana"), "hash", isAdmin: false, Now);

        Assert.Throws<InvalidOperationException>(() => user.SetMcpEnabled(true, Now));
        Assert.False(user.McpEnabled);
    }

    [Fact]
    public void Bot_has_no_password_to_change_or_reset()
    {
        Assert.Throws<InvalidOperationException>(() => NewBot().ChangePassword("hash", Now));
        Assert.Throws<InvalidOperationException>(() => NewBot().ResetPassword("hash", Now));
    }

    [Fact]
    public void Token_last_use_is_recorded_at_most_once_per_minute()
    {
        var token = BotToken.Create(Guid.NewGuid(), "produção", "abcdefgh", "hash", Guid.NewGuid(), Now);

        Assert.True(token.NeedsTouch(Now));
        Assert.False(token.IsRevoked);
        token.Revoke(Now.AddMinutes(1));
        token.Revoke(Now.AddMinutes(2));
        Assert.Equal(Now.AddMinutes(1), token.RevokedAt);
    }
}
