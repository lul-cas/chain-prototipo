using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Chain.Identity.Application;

/// <summary>
/// Bot API tokens: <c>chn_&lt;prefix&gt;_&lt;secret&gt;</c> (identity.md I3). The 8-character base32 prefix is for lookup;
/// the secret is 32 random bytes in base64url. Only the SHA-256 of the whole token is stored.
/// </summary>
public static partial class ApiTokens
{
    public const int PrefixLength = 8;
    private const string Base32 = "abcdefghijklmnopqrstuvwxyz234567";

    public static (string Value, string Prefix, string Hash) Create()
    {
        var prefix = new string(RandomNumberGenerator.GetItems<char>(Base32, PrefixLength));
        var secret = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var value = $"chn_{prefix}_{secret}";
        return (value, prefix, Hash(value));
    }

    public static bool TryGetPrefix(string? value, out string prefix)
    {
        var match = value is null ? Match.Empty : TokenFormat().Match(value);
        prefix = match.Success ? match.Groups["prefix"].Value : string.Empty;
        return match.Success;
    }

    public static string Hash(string value) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    /// <summary>Compares a presented token with a stored hash in constant time.</summary>
    public static bool Matches(string value, string storedHash) =>
        CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(Hash(value)), Encoding.ASCII.GetBytes(storedHash));

    [GeneratedRegex(@"^chn_(?<prefix>[a-z2-7]{8})_[A-Za-z0-9_-]{43}\z", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 100)] // \z: $ would also match before a trailing newline
    private static partial Regex TokenFormat();
}
