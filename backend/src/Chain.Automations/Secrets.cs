using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Chain.SharedKernel;

namespace Chain.Automations;

/// <summary>A key-encryption key (ADR-0012 Part 1 §2). It lives in configuration only, never in the database.</summary>
public sealed class Kek(string id, byte[] key)
{
    public string Id { get; } = id;

    internal byte[] Key { get; } = key;

    /// <summary>
    /// The key check value (ADR-0017 §4.3): the first 8 bytes of HMAC-SHA256 over <c>chain.kek-check.v1</c>, keyed with the KEK,
    /// as 16 lowercase hex digits. Both services show it, so an operator can confirm that they hold the same material under one
    /// id. It reveals nothing usable about a random key, but would confirm a guessed one: KEKs come from a random generator.
    /// </summary>
    public string CheckValue => Convert.ToHexStringLower(HMACSHA256.HashData(Key, "chain.kek-check.v1"u8)[..8]);
}

/// <summary>Whether a stored version's data key unwraps with the KEK its row names (ADR-0017 §5.2, <c>status</c>).</summary>
public enum KeyCheck
{
    Opens,
    KeyNotConfigured,
    DoesNotOpen,
}

/// <summary>
/// The KEKs from configuration, <c>id:base64key[,id:base64key…]</c>, and the one used for new writes (automation-contract.md §5).
/// The same format is read by Elixir. Errors never echo key material.
/// </summary>
public sealed partial class KeyRing
{
    private readonly Dictionary<string, Kek> _keys;

    private KeyRing(Dictionary<string, Kek> keys, Kek? active)
    {
        _keys = keys;
        Active = active;
    }

    /// <summary>The key for new writes; null when none is configured (creating or rotating a secret is then unavailable).</summary>
    public Kek? Active { get; }

    public IEnumerable<string> Ids => _keys.Keys;

    public Kek? Find(string id) => _keys.GetValueOrDefault(id);

    /// <summary>Parses the configuration. Malformed text throws, so a bad configuration stops the API at startup (automation.md §4.1).</summary>
    public static KeyRing Parse(string? keks, string? activeId)
    {
        var keys = new Dictionary<string, Kek>(StringComparer.Ordinal);
        foreach (var entry in (keks ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var separator = entry.IndexOf(':', StringComparison.Ordinal);
            var id = separator < 0 ? entry : entry[..separator];
            if (separator < 0 || !KeyId().IsMatch(id))
            {
                throw new FormatException("Each KEK is 'id:base64key' with an id of [a-z0-9_-]{1,32}.");
            }

            byte[] key;
            try
            {
                key = Convert.FromBase64String(entry[(separator + 1)..]);
            }
            catch (FormatException)
            {
                throw new FormatException($"KEK '{id}' is not valid base64.");
            }

            if (key.Length != SecretEnvelope.KeySize)
            {
                throw new FormatException($"KEK '{id}' must be exactly {SecretEnvelope.KeySize} bytes.");
            }

            if (!keys.TryAdd(id, new Kek(id, key)))
            {
                throw new FormatException($"KEK '{id}' is configured twice.");
            }
        }

        Kek? active = null;
        if (!string.IsNullOrWhiteSpace(activeId) && !keys.TryGetValue(activeId.Trim(), out active))
        {
            throw new FormatException($"The active KEK '{activeId.Trim()}' is not configured.");
        }

        return new KeyRing(keys, active);
    }

    [GeneratedRegex(@"^[a-z0-9_-]{1,32}\z", RegexOptions.CultureInvariant)] // \z: $ would also match before a trailing newline
    private static partial Regex KeyId();
}

/// <summary>The stored columns of one secret version (automation-contract.md §5).</summary>
public sealed record SealedSecret(byte[] Nonce, byte[] Ciphertext, byte[] WrappedDataKey, string KeyId);

/// <summary>
/// AES-256-GCM envelope encryption of secret values (ADR-0012 Part 1 §2; automation-contract.md §5): a new random data key per
/// version encrypts the value, and the KEK wraps the data key. Both associated data strings bind the name and the version, so a
/// row copied to another name or version does not decrypt.
/// </summary>
public static class SecretEnvelope
{
    public const int KeySize = 32;
    public const int NonceSize = 12;
    public const int TagSize = 16;

    /// <summary>Seals with a fresh random data key and nonces.</summary>
    public static SealedSecret Seal(Kek kek, string name, int version, string value) =>
        Seal(kek, name, version, value, RandomNumberGenerator.GetBytes(KeySize), RandomNumberGenerator.GetBytes(NonceSize), RandomNumberGenerator.GetBytes(NonceSize));

    /// <summary>Seals with the given data key and nonces; the shared vector uses fixed ones.</summary>
    public static SealedSecret Seal(
        Kek kek, string name, int version, string value, ReadOnlySpan<byte> dataKey, ReadOnlySpan<byte> nonce, ReadOnlySpan<byte> wrapNonce)
    {
        ArgumentNullException.ThrowIfNull(kek);
        var ciphertext = Encrypt(dataKey, nonce, Encoding.UTF8.GetBytes(value), ValueAad(name, version));
        var wrapped = new byte[NonceSize + KeySize + TagSize];
        wrapNonce.CopyTo(wrapped);
        Encrypt(kek.Key, wrapNonce, dataKey, DataKeyAad(kek.Id, name, version)).CopyTo(wrapped, NonceSize);
        return new SealedSecret(nonce.ToArray(), ciphertext, wrapped, kek.Id);
    }

    /// <summary>Decrypts a stored version; a wrong name, version or key raises <see cref="CryptographicException"/>.</summary>
    public static string Open(KeyRing ring, string name, int version, SealedSecret secret)
    {
        ArgumentNullException.ThrowIfNull(secret);
        var dataKey = Unwrap(ring, name, version, secret);
        try
        {
            return Encoding.UTF8.GetString(Decrypt(dataKey, secret.Nonce, secret.Ciphertext, ValueAad(name, version)));
        }
        finally
        {
            CryptographicOperations.ZeroMemory(dataKey);
        }
    }

    /// <summary>
    /// The version with its data key wrapped by <paramref name="target"/> instead, under a fresh wrap nonce (ADR-0017 §5.2). The
    /// value is never decrypted, so the nonce and the ciphertext stay as they are. A row that does not unwrap with the KEK it
    /// names raises <see cref="CryptographicException"/>, naming the key id only.
    /// </summary>
    public static SealedSecret Rewrap(KeyRing ring, Kek target, string name, int version, SealedSecret secret) =>
        Rewrap(ring, target, name, version, secret, RandomNumberGenerator.GetBytes(NonceSize));

    /// <summary>The same, with the given wrap nonce; the shared vector uses a fixed one.</summary>
    public static SealedSecret Rewrap(KeyRing ring, Kek target, string name, int version, SealedSecret secret, ReadOnlySpan<byte> wrapNonce)
    {
        ArgumentNullException.ThrowIfNull(target);
        ArgumentNullException.ThrowIfNull(secret);
        var dataKey = Unwrap(ring, name, version, secret);
        try
        {
            var wrapped = new byte[NonceSize + KeySize + TagSize];
            wrapNonce.CopyTo(wrapped);
            Encrypt(target.Key, wrapNonce, dataKey, DataKeyAad(target.Id, name, version)).CopyTo(wrapped, NonceSize);
            return new SealedSecret(secret.Nonce, secret.Ciphertext, wrapped, target.Id);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(dataKey);
        }
    }

    /// <summary>Whether the version's data key unwraps with the KEK its row names. The data key is zeroed at once; the value is never decrypted.</summary>
    public static KeyCheck Check(KeyRing ring, string name, int version, SealedSecret secret)
    {
        ArgumentNullException.ThrowIfNull(ring);
        ArgumentNullException.ThrowIfNull(secret);
        if (ring.Find(secret.KeyId) is null)
        {
            return KeyCheck.KeyNotConfigured;
        }

        try
        {
            CryptographicOperations.ZeroMemory(Unwrap(ring, name, version, secret));
            return KeyCheck.Opens;
        }
        catch (CryptographicException)
        {
            return KeyCheck.DoesNotOpen;
        }
    }

    /// <summary>The version's data key, unwrapped with the KEK its row names; the caller zeroes it.</summary>
    private static byte[] Unwrap(KeyRing ring, string name, int version, SealedSecret secret)
    {
        ArgumentNullException.ThrowIfNull(ring);
        var kek = ring.Find(secret.KeyId) ?? throw new CryptographicException($"KEK '{secret.KeyId}' is not configured.");
        var wrapped = secret.WrappedDataKey.AsSpan();
        if (wrapped.Length < NonceSize)
        {
            throw new CryptographicException("The wrapped data key is shorter than its nonce.");
        }

        return Decrypt(kek.Key, wrapped[..NonceSize], wrapped[NonceSize..], DataKeyAad(kek.Id, name, version));
    }

    private static byte[] ValueAad(string name, int version) =>
        Encoding.UTF8.GetBytes($"chain.secret.v1|{name}|{version.ToString(CultureInfo.InvariantCulture)}");

    private static byte[] DataKeyAad(string keyId, string name, int version) =>
        Encoding.UTF8.GetBytes($"chain.dek.v1|{keyId}|{name}|{version.ToString(CultureInfo.InvariantCulture)}");

    /// <summary>The ciphertext followed by its 16-byte tag.</summary>
    private static byte[] Encrypt(ReadOnlySpan<byte> key, ReadOnlySpan<byte> nonce, ReadOnlySpan<byte> plaintext, byte[] aad)
    {
        using var aes = new AesGcm(key, TagSize);
        var output = new byte[plaintext.Length + TagSize];
        aes.Encrypt(nonce, plaintext, output.AsSpan(0, plaintext.Length), output.AsSpan(plaintext.Length), aad);
        return output;
    }

    private static byte[] Decrypt(ReadOnlySpan<byte> key, ReadOnlySpan<byte> nonce, ReadOnlySpan<byte> ciphertextAndTag, byte[] aad)
    {
        if (ciphertextAndTag.Length < TagSize)
        {
            throw new CryptographicException("The ciphertext is shorter than its tag.");
        }

        using var aes = new AesGcm(key, TagSize);
        var length = ciphertextAndTag.Length - TagSize;
        var plaintext = new byte[length];
        aes.Decrypt(nonce, ciphertextAndTag[..length], ciphertextAndTag[length..], plaintext, aad);
        return plaintext;
    }
}

/// <summary>
/// An admin-managed credential (automation.md §4.1), referenced by name and injected only towards its allowed destinations. The
/// row holds its current version, sealed; the value is write-only and never leaves this type in clear text.
/// </summary>
public sealed class Secret
{
    public const int MaxValueBytes = 8192;
    public const int MaxDescriptionLength = 500;

    private static readonly UTF8Encoding StrictUtf8 = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

    private Secret()
    {
    }

    public string Name { get; private set; } = string.Empty;
    public string? Description { get; private set; }
    public string[] AllowedDestinations { get; private set; } = [];
    public int Version { get; private set; }
    public byte[] Nonce { get; private set; } = [];
    public byte[] Ciphertext { get; private set; } = [];
    public byte[] WrappedDataKey { get; private set; } = [];
    public string KeyId { get; private set; } = string.Empty;
    public DateTimeOffset CreatedAt { get; private set; }
    public Guid CreatedBy { get; private set; }
    public DateTimeOffset? RotatedAt { get; private set; }
    public DateTimeOffset UpdatedAt { get; private set; }

    public SealedSecret Sealed => new(Nonce, Ciphertext, WrappedDataKey, KeyId);

    /// <summary>The rules of a new secret, as error codes; empty when valid. Destination existence is the caller's check.</summary>
    public static IReadOnlyList<string> Validate(string? name, string? description, string? value, IReadOnlyList<string> allowedDestinations)
    {
        ArgumentNullException.ThrowIfNull(allowedDestinations);
        var errors = new List<string>();
        if (!Names.IsValid(name))
        {
            errors.Add("invalid_name");
        }

        errors.AddRange(ValidateValue(value));
        errors.AddRange(ValidateMetadata(description, allowedDestinations));
        return errors;
    }

    public static IReadOnlyList<string> ValidateValue(string? value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return ["value_required"];
        }

        int bytes;
        try
        {
            bytes = StrictUtf8.GetByteCount(value);
        }
        catch (EncoderFallbackException)
        {
            return ["invalid_value"];
        }

        return bytes > MaxValueBytes ? ["value_too_long"] : [];
    }

    public static IReadOnlyList<string> ValidateMetadata(string? description, IReadOnlyList<string> allowedDestinations)
    {
        ArgumentNullException.ThrowIfNull(allowedDestinations);
        var errors = new List<string>();
        if (description is { Length: > MaxDescriptionLength })
        {
            errors.Add("description_too_long");
        }
        else if (!ClientText.IsStorable(description))
        {
            errors.Add("invalid_description");
        }

        if (allowedDestinations.Any(destination => !Names.IsValid(destination)))
        {
            errors.Add("invalid_destination_name");
        }
        else if (allowedDestinations.Distinct(StringComparer.Ordinal).Count() != allowedDestinations.Count)
        {
            errors.Add("duplicate_destination");
        }

        return errors;
    }

    /// <summary>Creates version 1. Call <see cref="Validate"/> first.</summary>
    public static Secret Create(string name, string? description, IReadOnlyList<string> allowedDestinations, Kek kek, string value, Guid createdBy, DateTimeOffset now)
    {
        var secret = new Secret
        {
            Name = name,
            Description = description,
            AllowedDestinations = [.. allowedDestinations],
            CreatedAt = now,
            CreatedBy = createdBy,
            UpdatedAt = now,
        };
        secret.Store(SecretEnvelope.Seal(kek, name, 1, value), 1);
        return secret;
    }

    /// <summary>Seals a new value as the next version (ADR-0012 Part 1 §4).</summary>
    public void Rotate(Kek kek, string value, DateTimeOffset now)
    {
        Store(SecretEnvelope.Seal(kek, Name, Version + 1, value), Version + 1);
        RotatedAt = now;
        UpdatedAt = now;
    }

    /// <summary>
    /// Moves this version's data key under another KEK (ADR-0017 §5.2). The value, the version and the times stay as they are,
    /// since neither the value nor the metadata changed; only the row version (the <c>ETag</c>) does.
    /// </summary>
    public void Rewrap(SealedSecret rewrapped)
    {
        ArgumentNullException.ThrowIfNull(rewrapped);
        if (!rewrapped.Nonce.AsSpan().SequenceEqual(Nonce) || !rewrapped.Ciphertext.AsSpan().SequenceEqual(Ciphertext))
        {
            throw new InvalidOperationException("A re-wrap keeps the value as it is.");
        }

        WrappedDataKey = rewrapped.WrappedDataKey;
        KeyId = rewrapped.KeyId;
    }

    public void Update(string? description, IReadOnlyList<string> allowedDestinations, DateTimeOffset now)
    {
        Description = description;
        AllowedDestinations = [.. allowedDestinations];
        UpdatedAt = now;
    }

    /// <summary>Drops a destination from the allowed list (a forced destination delete); false when it was not there.</summary>
    public bool RemoveDestination(string destination, DateTimeOffset now)
    {
        if (!AllowedDestinations.Contains(destination, StringComparer.Ordinal))
        {
            return false;
        }

        AllowedDestinations = [.. AllowedDestinations.Where(name => name != destination)];
        UpdatedAt = now;
        return true;
    }

    private void Store(SealedSecret sealedSecret, int version)
    {
        Version = version;
        Nonce = sealedSecret.Nonce;
        Ciphertext = sealedSecret.Ciphertext;
        WrappedDataKey = sealedSecret.WrappedDataKey;
        KeyId = sealedSecret.KeyId;
    }
}

/// <summary>Names of destinations and secrets: <c>[a-z0-9][a-z0-9_.-]{0,63}</c>, never renamed (automation.md §3.1, §4.1).</summary>
public static partial class Names
{
    public static bool IsValid(string? name) => name is not null && Pattern().IsMatch(name);

    [GeneratedRegex(@"^[a-z0-9][a-z0-9_.-]{0,63}\z", RegexOptions.CultureInvariant)] // \z: $ would also match before a trailing newline
    private static partial Regex Pattern();
}
