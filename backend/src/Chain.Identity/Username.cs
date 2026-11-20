namespace Chain.Identity;

/// <summary>A login name: 3–64 characters from [a-z0-9._-], case-insensitive, stored lowercase.</summary>
public readonly record struct Username
{
    public const int MinLength = 3;
    public const int MaxLength = 64;

    private Username(string value) => Value = value;

    public string Value { get; }

    public static bool TryCreate(string? raw, out Username username)
    {
        username = default;
        var candidate = raw?.Trim().ToLowerInvariant();
        if (candidate is null || candidate.Length is < MinLength or > MaxLength || !candidate.All(IsAllowed))
        {
            return false;
        }

        username = new Username(candidate);
        return true;
    }

    public static Username Create(string raw) =>
        TryCreate(raw, out var username) ? username : throw new ArgumentException("Invalid username.", nameof(raw));

    public override string ToString() => Value;

    private static bool IsAllowed(char c) => c is (>= 'a' and <= 'z') or (>= '0' and <= '9') or '.' or '_' or '-';
}
