namespace Chain.Identity.Tests;

/// <summary>Domain rules of identity increment I1 (specs/modules/identity.md).</summary>
public sealed class UsernameTests
{
    [Theory]
    [InlineData("ana", "ana")]
    [InlineData("Ana.Souza", "ana.souza")]
    [InlineData("  joao_1-x  ", "joao_1-x")]
    public void Valid_usernames_are_normalized_to_lowercase(string raw, string expected)
    {
        Assert.True(Username.TryCreate(raw, out var username));
        Assert.Equal(expected, username.Value);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("ab")]
    [InlineData("ana souza")]
    [InlineData("ana@empresa")]
    [InlineData("joão")]
    public void Invalid_usernames_are_rejected(string? raw)
    {
        Assert.False(Username.TryCreate(raw, out _));
    }

    [Fact]
    public void Username_length_limit_is_64()
    {
        Assert.True(Username.TryCreate(new string('a', 64), out _));
        Assert.False(Username.TryCreate(new string('a', 65), out _));
    }
}

public sealed class PasswordPolicyTests
{
    private static readonly Username Ana = Username.Create("ana.souza");

    [Fact]
    public void Accepts_a_long_password_without_composition_rules()
    {
        Assert.Empty(PasswordPolicy.Validate("correct horse battery", Ana));
    }

    [Fact]
    public void Rejects_short_password()
    {
        Assert.Contains("password_too_short", PasswordPolicy.Validate(new string('x', 11), Ana));
        Assert.Empty(PasswordPolicy.Validate(new string('x', 12), Ana));
    }

    [Fact]
    public void Rejects_long_password()
    {
        Assert.Contains("password_too_long", PasswordPolicy.Validate(new string('x', 129), Ana));
        Assert.Empty(PasswordPolicy.Validate(new string('x', 128), Ana));
    }

    [Fact]
    public void Rejects_password_equal_to_username_ignoring_case()
    {
        var longName = Username.Create("ana.souza.silva");
        Assert.Contains("password_equals_username", PasswordPolicy.Validate("ANA.SOUZA.SILVA", longName));
    }
}

public sealed class LockoutPolicyTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 15, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Lock_is_active_until_its_end()
    {
        Assert.False(LockoutPolicy.IsLocked(null, Now));
        Assert.True(LockoutPolicy.IsLocked(Now.AddSeconds(1), Now));
        Assert.False(LockoutPolicy.IsLocked(Now, Now));
    }

    [Fact]
    public void Policy_is_five_failures_for_fifteen_minutes()
    {
        Assert.Equal(5, LockoutPolicy.MaxFailedAttempts);
        Assert.Equal(TimeSpan.FromMinutes(15), LockoutPolicy.LockDuration);
    }
}

public sealed class SessionTests
{
    private static readonly DateTimeOffset Start = new(2026, 10, 15, 8, 0, 0, TimeSpan.Zero);

    [Fact]
    public void New_session_is_active()
    {
        var session = Session.Start(Guid.NewGuid(), "hash", Start);

        Assert.True(session.IsActiveAt(Start));
        Assert.Equal(Start.Add(SessionPolicy.AbsoluteLifetime), session.ExpiresAt);
    }

    [Fact]
    public void Session_expires_after_30_minutes_idle()
    {
        var session = Session.Start(Guid.NewGuid(), "hash", Start);

        Assert.True(session.IsActiveAt(Start.AddMinutes(30).AddSeconds(-1)));
        Assert.False(session.IsActiveAt(Start.AddMinutes(30)));
    }

    [Fact]
    public void Activity_extends_idle_window_but_not_absolute_lifetime()
    {
        var session = Session.Start(Guid.NewGuid(), "hash", Start);

        // Active every 20 minutes for almost 12 hours: the idle window keeps moving.
        for (var t = Start.AddMinutes(20); t < Start.AddHours(12); t = t.AddMinutes(20))
        {
            Assert.True(session.IsActiveAt(t));
            session.Touch(t);
        }

        // Last touch at 11:40 would allow idling until 12:10, but the absolute lifetime ends at 12:00.
        Assert.True(session.IsActiveAt(Start.AddHours(12).AddSeconds(-1)));
        Assert.False(session.IsActiveAt(Start.AddHours(12)));
    }

    [Fact]
    public void Revoked_session_is_inactive()
    {
        var session = Session.Start(Guid.NewGuid(), "hash", Start);
        session.Revoke(Start.AddMinutes(1));

        Assert.False(session.IsActiveAt(Start.AddMinutes(2)));
    }

    [Fact]
    public void Touch_is_needed_only_after_one_minute()
    {
        var session = Session.Start(Guid.NewGuid(), "hash", Start);

        Assert.False(session.NeedsTouch(Start.AddSeconds(59)));
        Assert.True(session.NeedsTouch(Start.AddMinutes(1)));
    }
}

public sealed class UserTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 15, 8, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Bootstrap_admin_must_change_password()
    {
        var admin = User.CreateBootstrapAdmin(Username.Create("admin"), "hash", Now);

        Assert.True(admin.IsAdmin);
        Assert.True(admin.IsActive);
        Assert.True(admin.MustChangePassword);
        Assert.Equal("admin", admin.Username);
    }

    [Fact]
    public void Changing_password_clears_the_must_change_flag()
    {
        var admin = User.CreateBootstrapAdmin(Username.Create("admin"), "hash", Now);

        admin.ChangePassword("new-hash", Now.AddMinutes(1));

        Assert.False(admin.MustChangePassword);
        Assert.Equal("new-hash", admin.PasswordHash);
        Assert.Equal(Now.AddMinutes(1), admin.UpdatedAt);
    }
}
