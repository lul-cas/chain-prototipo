using System.Text.Json;
using Chain.SharedKernel;

namespace Chain.Workflows.Tests.Definitions;

/// <summary>The guard for client text that PostgreSQL cannot store (identity.md I1; cards #93, #129).</summary>
public sealed class ClientTextTests
{
    [Fact]
    public void Text_without_NUL_or_unpaired_surrogates_is_storable()
    {
        Assert.True(ClientText.IsStorable(null));
        Assert.True(ClientText.IsStorable(string.Empty));
        Assert.True(ClientText.IsStorable("Análise de crédito 😀"));
    }

    [Fact]
    public void Text_with_NUL_or_an_unpaired_surrogate_is_not_storable()
    {
        Assert.False(ClientText.IsStorable("a\u0000b"));
        Assert.False(ClientText.IsStorable("a\ud83d")); // a high surrogate at the end
        Assert.False(ClientText.IsStorable("\ude00a")); // a low surrogate alone
        Assert.False(ClientText.IsStorable("\ud83d😀")); // two high surrogates: the first one has no pair
    }

    [Theory]
    [InlineData("""{"a":"x","b":["y",1,null]}""")]
    [InlineData("""{"a":"é","b":"😀","c":"😀"}""")] // escaped pairs, in either case
    [InlineData("""{"a":"\\u0000"}""")] // an escaped backslash, then the text u0000
    [InlineData("""{"a":"\\ud800"}""")]
    [InlineData("""{"a":"\"\\\/\b\f\n\r\t"}""")]
    public void JSON_text_without_NUL_or_unpaired_surrogates_is_storable(string json) => Assert.True(ClientText.IsStorableJson(json));

    [Theory]
    [InlineData("""{"a":"\u0000"}""")]
    [InlineData("""{"\u0000":1}""")]
    [InlineData("""{"a":"\\\u0000"}""")] // an escaped backslash, then a NUL escape
    [InlineData("""{"a":"\ud800"}""")]
    [InlineData("""{"a":"\udc00"}""")]
    [InlineData("""{"a\ud83d":1}""")]
    [InlineData("""{"a":"\ud83d\ud83d"}""")]
    [InlineData("""{"a":"\ude00\ud83d"}""")]
    [InlineData("""{"a":"\ud83d\\ude00"}""")] // after an escaped backslash, ude00 is text: the high surrogate has no pair
    public void JSON_text_with_NUL_or_an_unpaired_surrogate_is_not_storable(string json) => Assert.False(ClientText.IsStorableJson(json));

    [Fact]
    public void JSON_text_is_also_checked_character_by_character()
    {
        Assert.True(ClientText.IsStorableJson("{\"a\":\"😀\"}"));
        Assert.False(ClientText.IsStorableJson("{\"a\":\"\ud800\"}"));
    }

    [Fact]
    public void Unicode_JSON_may_hold_NUL_but_no_unpaired_surrogate_and_no_bytes_that_are_not_UTF8()
    {
        Assert.True(ClientText.IsUnicode(Parse("""{"a":"\u0000","b":"😀"}"""u8.ToArray())));
        Assert.False(ClientText.IsUnicode(Parse("""{"a":"\ud800"}"""u8.ToArray())));
        Assert.False(ClientText.IsUnicode(Parse("""{"\udc00":1}"""u8.ToArray())));
        Assert.False(ClientText.IsUnicode(Parse([.. "{\"a\":\""u8, 0xED, 0xA0, 0x80, .. "\"}"u8]))); // U+D800 written as raw bytes
        Assert.True(ClientText.IsUnicode(default)); // no value, so no text
    }

    private static JsonElement Parse(byte[] json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }
}
