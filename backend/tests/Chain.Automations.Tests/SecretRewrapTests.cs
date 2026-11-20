using System.Security.Cryptography;
using System.Text.Json;

namespace Chain.Automations.Tests;

/// <summary>
/// Re-wrapping a secret's data key under another KEK (ADR-0017 §5.2, §5.7, card #77). The second vector re-wraps the first one's
/// row under <c>dev2</c>; it was generated with Erlang/OTP's :crypto, independently of both implementations, so .NET must
/// reproduce it byte for byte.
/// </summary>
public sealed class SecretRewrapTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 16, 12, 0, 0, TimeSpan.Zero);

    private static readonly JsonElement First =
        JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "contract", "secret-envelope.json"))).RootElement;

    private static readonly JsonElement Second =
        JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "contract", "secret-envelope-rewrapped.json"))).RootElement;

    private static string Name => First.GetProperty("name").GetString()!;

    private static int Version => First.GetProperty("version").GetInt32();

    private static KeyRing Both => KeyRing.Parse(Second.GetProperty("keks").GetString(), "dev2");

    private static KeyRing Only(string id) =>
        KeyRing.Parse(Second.GetProperty("keks").GetString()!.Split(',').Single(entry => entry.StartsWith(id + ":", StringComparison.Ordinal)), id);

    private static SealedSecret Columns(JsonElement vector)
    {
        var expected = vector.GetProperty("expected");
        return new(
            Convert.FromBase64String(expected.GetProperty("nonce").GetString()!),
            Convert.FromBase64String(expected.GetProperty("ciphertext").GetString()!),
            Convert.FromBase64String(expected.GetProperty("wrapped_data_key").GetString()!),
            expected.GetProperty("key_id").GetString()!);
    }

    [Fact]
    public void Rewraps_the_shared_vector_byte_for_byte()
    {
        var rewrapped = SecretEnvelope.Rewrap(Both, Both.Active!, Name, Version, Columns(First), Convert.FromBase64String(Second.GetProperty("wrapNonce").GetString()!));
        var expected = Columns(Second);

        Assert.Equal(expected.KeyId, rewrapped.KeyId);
        Assert.Equal(Convert.ToBase64String(expected.Nonce), Convert.ToBase64String(rewrapped.Nonce));
        Assert.Equal(Convert.ToBase64String(expected.Ciphertext), Convert.ToBase64String(rewrapped.Ciphertext));
        Assert.Equal(Convert.ToBase64String(expected.WrappedDataKey), Convert.ToBase64String(rewrapped.WrappedDataKey));
    }

    [Fact]
    public void A_rewrapped_row_opens_with_the_new_key_alone_and_not_with_the_old_one()
    {
        var value = First.GetProperty("value").GetString();

        Assert.Equal(value, SecretEnvelope.Open(Only("dev2"), Name, Version, Columns(Second)));
        Assert.Equal(value, SecretEnvelope.Open(Both, Name, Version, Columns(Second)));
        Assert.ThrowsAny<CryptographicException>(() => SecretEnvelope.Open(Only("dev1"), Name, Version, Columns(Second)));
    }

    [Fact]
    public void The_new_wrapping_binds_the_new_key_id()
    {
        var back = Columns(Second) with { KeyId = "dev1" }; // only the id set back, as a tampered row would be

        Assert.ThrowsAny<CryptographicException>(() => SecretEnvelope.Open(Both, Name, Version, back));
    }

    [Fact]
    public void Each_rewrap_uses_a_new_wrap_nonce_and_keeps_the_value_as_it_is()
    {
        var first = SecretEnvelope.Rewrap(Both, Both.Active!, Name, Version, Columns(First));
        var second = SecretEnvelope.Rewrap(Both, Both.Active!, Name, Version, Columns(First));

        Assert.NotEqual(first.WrappedDataKey[..SecretEnvelope.NonceSize], second.WrappedDataKey[..SecretEnvelope.NonceSize]);
        Assert.Equal(Columns(First).Nonce, first.Nonce);
        Assert.Equal(Columns(First).Ciphertext, first.Ciphertext);
        Assert.Equal(First.GetProperty("value").GetString(), SecretEnvelope.Open(Only("dev2"), Name, Version, second));
    }

    [Fact]
    public void A_row_that_does_not_unwrap_is_not_rewrapped_and_says_why()
    {
        var unknown = Assert.ThrowsAny<CryptographicException>(() => SecretEnvelope.Rewrap(Only("dev2"), Only("dev2").Active!, Name, Version, Columns(First)));
        Assert.Equal("KEK 'dev1' is not configured.", unknown.Message);

        var wrongMaterial = KeyRing.Parse("dev1:" + Convert.ToBase64String(new byte[32]) + ",dev2:" + Second.GetProperty("keks").GetString()!.Split("dev2:")[1], "dev2");
        Assert.ThrowsAny<CryptographicException>(() => SecretEnvelope.Rewrap(wrongMaterial, wrongMaterial.Active!, Name, Version, Columns(First)));

        Assert.Equal(KeyCheck.Opens, SecretEnvelope.Check(Both, Name, Version, Columns(First)));
        Assert.Equal(KeyCheck.KeyNotConfigured, SecretEnvelope.Check(Only("dev2"), Name, Version, Columns(First)));
        Assert.Equal(KeyCheck.DoesNotOpen, SecretEnvelope.Check(wrongMaterial, Name, Version, Columns(First)));
    }

    [Fact]
    public void Each_key_has_the_check_value_both_services_show()
    {
        var kcv = Second.GetProperty("kcv");

        Assert.Equal(kcv.GetProperty("dev1").GetString(), Both.Find("dev1")!.CheckValue);
        Assert.Equal(kcv.GetProperty("dev2").GetString(), Both.Find("dev2")!.CheckValue);
        Assert.Matches("^[0-9a-f]{16}$", Both.Find("dev2")!.CheckValue);
    }

    [Fact]
    public void Moving_a_secret_keeps_its_value_version_and_times()
    {
        var created = Now.AddDays(-2);
        var secret = Secret.Create(Name, null, ["erp"], Only("dev1").Active!, "token", Guid.CreateVersion7(created), created);
        secret.Rotate(Only("dev1").Active!, "token-2", Now.AddDays(-1));
        var (version, rotatedAt, updatedAt, nonce, ciphertext) = (secret.Version, secret.RotatedAt, secret.UpdatedAt, secret.Nonce, secret.Ciphertext);

        secret.Rewrap(SecretEnvelope.Rewrap(Both, Both.Active!, secret.Name, secret.Version, secret.Sealed));

        Assert.Equal(("dev2", version, rotatedAt, updatedAt), (secret.KeyId, secret.Version, secret.RotatedAt, secret.UpdatedAt));
        Assert.Equal(nonce, secret.Nonce);
        Assert.Equal(ciphertext, secret.Ciphertext);
        Assert.Equal("token-2", SecretEnvelope.Open(Only("dev2"), secret.Name, secret.Version, secret.Sealed));
        Assert.Throws<InvalidOperationException>(() => secret.Rewrap(SecretEnvelope.Seal(Both.Active!, secret.Name, secret.Version, "other")));
    }
}
