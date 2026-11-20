namespace Chain.Identity;

public enum ActorKind
{
    /// <summary>A person who signs in with username and password.</summary>
    User,

    /// <summary>A non-human actor that authenticates with API tokens; never an admin (ADR-0006).</summary>
    Bot,
}

/// <summary>
/// An actor (ADR-0006): a local user account or a bot (identity.md I3: bots share this table).
/// Failed-login counting is done atomically in persistence (ADR-0008 §6).
/// </summary>
public sealed class User
{
    private User()
    {
    }

    public Guid Id { get; private set; }
    public ActorKind Kind { get; private set; }
    public string Username { get; private set; } = string.Empty;
    public string DisplayName { get; private set; } = string.Empty;
    /// <summary>Null for bots, which cannot sign in with a password.</summary>
    public string? PasswordHash { get; private set; }
    public bool IsAdmin { get; private set; }
    public bool IsActive { get; private set; }
    /// <summary>Whether this bot's tokens are accepted on the MCP endpoint (ADR-0015 §5, Q-M4). Always false for people.</summary>
    public bool McpEnabled { get; private set; }
    /// <summary>The bot's own MCP rate, calls per minute; null for the server's default (mcp.md §5, Q-M9).</summary>
    public int? McpCallsPerMinute { get; private set; }
    public bool MustChangePassword { get; private set; }
    public int FailedLoginCount { get; private set; }
    public DateTimeOffset? LockedUntil { get; private set; }
    public Guid? OwnerId { get; private set; }
    public DateTimeOffset CreatedAt { get; private set; }

    public bool IsBot => Kind == ActorKind.Bot;
    public DateTimeOffset UpdatedAt { get; private set; }

    public static User CreateBootstrapAdmin(Username username, string passwordHash, DateTimeOffset now) => new()
    {
        Id = Guid.CreateVersion7(now),
        Username = username.Value,
        DisplayName = username.Value,
        PasswordHash = passwordHash,
        IsAdmin = true,
        IsActive = true,
        MustChangePassword = true,
        CreatedAt = now,
        UpdatedAt = now,
    };

    public static User CreateByAdmin(Username username, DisplayName displayName, string temporaryPasswordHash, bool isAdmin, DateTimeOffset now) => new()
    {
        Id = Guid.CreateVersion7(now),
        Username = username.Value,
        DisplayName = displayName.Value,
        PasswordHash = temporaryPasswordHash,
        IsAdmin = isAdmin,
        IsActive = true,
        MustChangePassword = true,
        CreatedAt = now,
        UpdatedAt = now,
    };

    public static User CreateBot(Username name, DisplayName displayName, Guid ownerId, DateTimeOffset now) => new()
    {
        Id = Guid.CreateVersion7(now),
        Kind = ActorKind.Bot,
        Username = name.Value,
        DisplayName = displayName.Value,
        PasswordHash = null,
        IsAdmin = false,
        IsActive = true,
        MustChangePassword = false,
        OwnerId = ownerId,
        CreatedAt = now,
        UpdatedAt = now,
    };

    public void Rename(DisplayName displayName, DateTimeOffset now)
    {
        DisplayName = displayName.Value;
        UpdatedAt = now;
    }

    public void SetAdmin(bool isAdmin, DateTimeOffset now)
    {
        if (isAdmin && IsBot)
        {
            throw new InvalidOperationException("Bots can never be admins.");
        }

        IsAdmin = isAdmin;
        UpdatedAt = now;
    }

    public void Deactivate(DateTimeOffset now)
    {
        IsActive = false;
        UpdatedAt = now;
    }

    public void Activate(DateTimeOffset now)
    {
        IsActive = true;
        UpdatedAt = now;
    }

    public void SetMcpRate(int? callsPerMinute, DateTimeOffset now)
    {
        if (!IsBot)
        {
            throw new InvalidOperationException("Only bots can use MCP.");
        }

        McpCallsPerMinute = callsPerMinute;
        UpdatedAt = now;
    }

    public void SetMcpEnabled(bool enabled, DateTimeOffset now)
    {
        if (!IsBot)
        {
            throw new InvalidOperationException("Only bots can use MCP.");
        }

        McpEnabled = enabled;
        UpdatedAt = now;
    }

    /// <summary>Admin password reset: a new temporary password that must be changed; the lockout is cleared.</summary>
    public void ResetPassword(string temporaryPasswordHash, DateTimeOffset now)
    {
        EnsureHuman();
        PasswordHash = temporaryPasswordHash;
        MustChangePassword = true;
        FailedLoginCount = 0;
        LockedUntil = null;
        UpdatedAt = now;
    }

    public void Unlock(DateTimeOffset now)
    {
        FailedLoginCount = 0;
        LockedUntil = null;
        UpdatedAt = now;
    }

    public void ChangePassword(string newPasswordHash, DateTimeOffset now)
    {
        EnsureHuman();
        PasswordHash = newPasswordHash;
        MustChangePassword = false;
        UpdatedAt = now;
    }

    public bool IsLockedAt(DateTimeOffset now) => LockoutPolicy.IsLocked(LockedUntil, now);

    private void EnsureHuman()
    {
        if (IsBot)
        {
            throw new InvalidOperationException("Bots have no password.");
        }
    }
}
