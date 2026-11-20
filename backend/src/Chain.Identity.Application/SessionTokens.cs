using System.Security.Cryptography;
using System.Text;

namespace Chain.Identity.Application;

/// <summary>Opaque 256-bit session tokens. Only <see cref="Hash"/> of a token is ever stored.</summary>
public static class SessionTokens
{
    public const int MaxTokenLength = 128;

    public static string Create() => Base64UrlEncode(RandomNumberGenerator.GetBytes(32));

    public static string Hash(string token) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    private static string Base64UrlEncode(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
