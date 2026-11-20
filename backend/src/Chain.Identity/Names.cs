using Chain.SharedKernel;

namespace Chain.Identity;

/// <summary>A user's display name: 1–200 characters, trimmed, of text PostgreSQL can store (identity.md I1, I2).</summary>
public readonly record struct DisplayName
{
    public const int MaxLength = 200;

    private DisplayName(string value) => Value = value;

    public string Value { get; }

    public static bool TryCreate(string? raw, out DisplayName name)
    {
        name = default;
        var candidate = raw?.Trim();
        if (string.IsNullOrEmpty(candidate) || candidate.Length > MaxLength || !ClientText.IsStorable(candidate))
        {
            return false;
        }

        name = new DisplayName(candidate);
        return true;
    }

    public static DisplayName Create(string raw) =>
        TryCreate(raw, out var name) ? name : throw new ArgumentException("Invalid display name.", nameof(raw));

    public override string ToString() => Value;
}

/// <summary>A group name: 1–100 characters, trimmed, of text PostgreSQL can store; uniqueness is case-insensitive.</summary>
public readonly record struct GroupName
{
    public const int MaxLength = 100;

    private GroupName(string value) => Value = value;

    public string Value { get; }

    /// <summary>The form used for case-insensitive uniqueness.</summary>
    public string Normalized => Value.ToLowerInvariant();

    public static bool TryCreate(string? raw, out GroupName name)
    {
        name = default;
        var candidate = raw?.Trim();
        if (string.IsNullOrEmpty(candidate) || candidate.Length > MaxLength || !ClientText.IsStorable(candidate))
        {
            return false;
        }

        name = new GroupName(candidate);
        return true;
    }

    public static GroupName Create(string raw) =>
        TryCreate(raw, out var name) ? name : throw new ArgumentException("Invalid group name.", nameof(raw));

    public override string ToString() => Value;
}
