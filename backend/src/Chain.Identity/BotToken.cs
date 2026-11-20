namespace Chain.Identity;

/// <summary>An API token of a bot. Only its SHA-256 is stored; tokens never expire and are revoked explicitly (identity.md I3).</summary>
public sealed class BotToken
{
    public const int MaxActivePerBot = 5;
    public const int MaxLabelLength = 100;

    private BotToken()
    {
    }

    public Guid Id { get; private set; }
    public Guid BotId { get; private set; }
    public string Label { get; private set; } = string.Empty;
    public string Prefix { get; private set; } = string.Empty;
    public string TokenHash { get; private set; } = string.Empty;
    public DateTimeOffset CreatedAt { get; private set; }
    public Guid CreatedBy { get; private set; }
    public DateTimeOffset? LastUsedAt { get; private set; }
    public DateTimeOffset? RevokedAt { get; private set; }

    public bool IsRevoked => RevokedAt is not null;

    public static BotToken Create(Guid botId, string label, string prefix, string tokenHash, Guid createdBy, DateTimeOffset now) => new()
    {
        Id = Guid.CreateVersion7(now),
        BotId = botId,
        Label = label,
        Prefix = prefix,
        TokenHash = tokenHash,
        CreatedAt = now,
        CreatedBy = createdBy,
    };

    public bool NeedsTouch(DateTimeOffset now) => LastUsedAt is null || now - LastUsedAt.Value >= SessionPolicy.TouchInterval;

    public void Revoke(DateTimeOffset now) => RevokedAt ??= now;
}
