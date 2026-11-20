using Chain.Identity.Application;

namespace Chain.Identity.Tests;

/// <summary>The bot API token format, <c>chn_&lt;prefix&gt;_&lt;secret&gt;</c> (specs/modules/identity.md I3).</summary>
public sealed class ApiTokensTests
{
    [Fact]
    public void A_created_token_yields_its_prefix()
    {
        var (value, prefix, _) = ApiTokens.Create();

        Assert.True(ApiTokens.TryGetPrefix(value, out var found));
        Assert.Equal(prefix, found);
    }

    // In .NET, $ also matches before a final newline, so the format ends with \z (#81).
    [Fact]
    public void A_token_with_a_trailing_newline_is_not_a_token()
    {
        var (value, _, _) = ApiTokens.Create();

        Assert.False(ApiTokens.TryGetPrefix(value + "\n", out var prefix));
        Assert.Equal(string.Empty, prefix);
    }
}
