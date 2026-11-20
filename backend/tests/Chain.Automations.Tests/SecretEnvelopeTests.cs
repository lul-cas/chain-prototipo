using System.Security.Cryptography;
using System.Text.Json;

namespace Chain.Automations.Tests;

/// <summary>
/// The secret envelope of automation-contract.md §5. The shared vector was generated with Erlang/OTP's :crypto, independently of
/// both implementations: .NET must reproduce it byte for byte and decrypt it (Elixir decrypts it in E4b).
/// </summary>
public sealed class SecretEnvelopeTests
{
    private static readonly JsonElement Vector =
        JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "contract", "secret-envelope.json"))).RootElement;

    private static string Text(string property) => Vector.GetProperty(property).GetString()!;

    private static string Expected(string property) => Vector.GetProperty("expected").GetProperty(property).GetString()!;

    private static KeyRing Ring => KeyRing.Parse(Text("keks"), Text("activeKek"));

    private static SealedSecret ExpectedColumns => new(
        Convert.FromBase64String(Expected("nonce")),
        Convert.FromBase64String(Expected("ciphertext")),
        Convert.FromBase64String(Expected("wrapped_data_key")),
        Expected("key_id"));

    [Fact]
    public void Seals_the_shared_vector_byte_for_byte()
    {
        var columns = SecretEnvelope.Seal(
            Ring.Active!, Text("name"), Vector.GetProperty("version").GetInt32(), Text("value"),
            Convert.FromBase64String(Text("dataKey")), Convert.FromBase64String(Expected("nonce")), Convert.FromBase64String(Text("wrapNonce")));

        Assert.Equal(Expected("key_id"), columns.KeyId);
        Assert.Equal(Expected("nonce"), Convert.ToBase64String(columns.Nonce));
        Assert.Equal(Expected("ciphertext"), Convert.ToBase64String(columns.Ciphertext));
        Assert.Equal(Expected("wrapped_data_key"), Convert.ToBase64String(columns.WrappedDataKey));
    }

    [Fact]
    public void Opens_the_shared_vector()
    {
        Assert.Equal(Text("value"), SecretEnvelope.Open(Ring, Text("name"), Vector.GetProperty("version").GetInt32(), ExpectedColumns));
    }

    [Theory]
    [InlineData("other_name", 2)]
    [InlineData("erp_api_key", 3)]
    public void A_row_copied_to_another_name_or_version_does_not_open(string name, int version)
    {
        Assert.ThrowsAny<CryptographicException>(() => SecretEnvelope.Open(Ring, name, version, ExpectedColumns));
    }

    [Fact]
    public void A_row_wrapped_by_an_unknown_key_does_not_open()
    {
        var ring = KeyRing.Parse("other:" + Convert.ToBase64String(new byte[32]), "other");

        Assert.ThrowsAny<CryptographicException>(() => SecretEnvelope.Open(ring, Text("name"), 2, ExpectedColumns));
    }

    [Fact]
    public void Each_seal_uses_a_new_data_key_and_nonces()
    {
        var first = SecretEnvelope.Seal(Ring.Active!, "erp_api_key", 1, "token");
        var second = SecretEnvelope.Seal(Ring.Active!, "erp_api_key", 1, "token");

        Assert.NotEqual(first.Nonce, second.Nonce);
        Assert.NotEqual(first.Ciphertext, second.Ciphertext);
        Assert.NotEqual(first.WrappedDataKey, second.WrappedDataKey);
        Assert.Equal("token", SecretEnvelope.Open(Ring, "erp_api_key", 1, first));
        Assert.Equal("token", SecretEnvelope.Open(Ring, "erp_api_key", 1, second));
    }
}
