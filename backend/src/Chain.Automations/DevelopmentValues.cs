using System.Security.Cryptography;

namespace Chain.Automations;

/// <summary>
/// The development-only KEK and result token that docker-compose.yml supplies by default. They are published, so the API refuses
/// them outside the Development environment (automation.md §4.1, card #164). Only their SHA-256 is kept here, and findings name
/// the setting, and a key's id, never a value.
/// </summary>
public static class DevelopmentValues
{
    /// <summary>SHA-256 of the development KEK's 32 bytes.</summary>
    private static readonly byte[] KeySha256 = Convert.FromHexString("90362fbaddb46c7f23175fd3e6da37d61785dd0e91d763357a3b5cc87bb9901e");

    /// <summary>SHA-256 of the development result token, the hash the API is given by default (automation-contract.md §4.1).</summary>
    private static readonly byte[] TokenSha256 = Convert.FromHexString("dcf5a1eb6a5bbb92ba48b910dd25245847b721798dc2e1c71dfa238e2e3f25d1");

    /// <summary>What holds a development value: each key of <paramref name="ring"/> with the development key's bytes, whatever its id, and the result token's hash.</summary>
    public static IReadOnlyList<string> Find(KeyRing ring, string? resultTokenSha256)
    {
        ArgumentNullException.ThrowIfNull(ring);
        var found = ring.Ids
            .Where(id => CryptographicOperations.FixedTimeEquals(SHA256.HashData(ring.Find(id)!.Key), KeySha256))
            .Select(id => $"Chain:Automation:Keks holds the development key under the id '{id}'")
            .ToList();
        if (resultTokenSha256?.Trim() is { Length: 64 } hex && hex.All(char.IsAsciiHexDigit)
            && CryptographicOperations.FixedTimeEquals(Convert.FromHexString(hex), TokenSha256))
        {
            found.Add("Chain:Automation:ResultTokenSha256 is the hash of the development token");
        }

        return found;
    }
}
