namespace Chain.Identity;

/// <summary>Password policy (specs/modules/identity.md): 12–128 characters, not equal to the username; no composition rules.</summary>
public static class PasswordPolicy
{
    public const int MinLength = 12;
    public const int MaxLength = 128;

    public static IReadOnlyList<string> Validate(string password, Username username)
    {
        ArgumentNullException.ThrowIfNull(password);

        var errors = new List<string>();
        if (password.Length < MinLength)
        {
            errors.Add("password_too_short");
        }

        if (password.Length > MaxLength)
        {
            errors.Add("password_too_long");
        }

        if (string.Equals(password, username.Value, StringComparison.OrdinalIgnoreCase))
        {
            errors.Add("password_equals_username");
        }

        return errors;
    }
}

/// <summary>Account lockout (ADR-0006): the 5th consecutive failure locks the account for 15 minutes.</summary>
public static class LockoutPolicy
{
    public const int MaxFailedAttempts = 5;
    public static readonly TimeSpan LockDuration = TimeSpan.FromMinutes(15);

    public static bool IsLocked(DateTimeOffset? lockedUntil, DateTimeOffset now) => lockedUntil > now;
}

/// <summary>Session lifetime: 30 minutes idle, 12 hours absolute; activity is recorded at most once per minute.</summary>
public static class SessionPolicy
{
    public static readonly TimeSpan IdleTimeout = TimeSpan.FromMinutes(30);
    public static readonly TimeSpan AbsoluteLifetime = TimeSpan.FromHours(12);
    public static readonly TimeSpan TouchInterval = TimeSpan.FromMinutes(1);
}
