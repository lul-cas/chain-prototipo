namespace Chain.Identity;

/// <summary>A server-side login session. Only the SHA-256 of the cookie token is stored.</summary>
public sealed class Session
{
    private Session()
    {
    }

    public Guid Id { get; private set; }
    public Guid UserId { get; private set; }
    public string TokenHash { get; private set; } = string.Empty;
    public DateTimeOffset CreatedAt { get; private set; }
    public DateTimeOffset LastSeenAt { get; private set; }
    public DateTimeOffset ExpiresAt { get; private set; }
    public DateTimeOffset? RevokedAt { get; private set; }

    public static Session Start(Guid userId, string tokenHash, DateTimeOffset now) => new()
    {
        Id = Guid.CreateVersion7(now),
        UserId = userId,
        TokenHash = tokenHash,
        CreatedAt = now,
        LastSeenAt = now,
        ExpiresAt = now.Add(SessionPolicy.AbsoluteLifetime),
    };

    public bool IsActiveAt(DateTimeOffset now) =>
        RevokedAt is null && now < ExpiresAt && now < LastSeenAt.Add(SessionPolicy.IdleTimeout);

    public bool NeedsTouch(DateTimeOffset now) => now - LastSeenAt >= SessionPolicy.TouchInterval;

    public void Touch(DateTimeOffset now) => LastSeenAt = now;

    public void Revoke(DateTimeOffset now) => RevokedAt ??= now;
}
