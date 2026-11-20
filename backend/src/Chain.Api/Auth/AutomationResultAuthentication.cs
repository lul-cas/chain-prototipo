using System.Globalization;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using Chain.Api.Http;
using Chain.Workflows.Application.Engine;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;

namespace Chain.Api.Auth;

/// <summary>
/// Authenticates <c>/internal/…</c> (automation-contract.md §4.1): only the result token, compared by its SHA-256 in constant time
/// with <c>Chain:Automation:ResultTokenSha256</c>. Session cookies and bot tokens are never read here. Without the setting, nothing
/// authenticates. The principal is <c>system:automation</c>, which no other endpoint accepts.
/// </summary>
internal sealed class AutomationResultAuthenticationHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder,
    IConfiguration configuration)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string SchemeName = "ChainAutomation";
    public const string Policy = "AutomationResults";
    public const string Channel = "automation";

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        if (!BearerToken.TryRead(Request, out var bearer))
        {
            return Task.FromResult(AuthenticateResult.NoResult());
        }

        if (ExpectedHash(configuration) is not { } expected
            || !CryptographicOperations.FixedTimeEquals(SHA256.HashData(Encoding.UTF8.GetBytes(bearer)), expected))
        {
            return Task.FromResult(AuthenticateResult.Fail("The result token is wrong, or none is configured."));
        }

        var identity = new ClaimsIdentity(
            [new Claim(ClaimTypes.Name, InstanceService.AutomationPrincipal), new Claim(CallerClaims.ChannelClaim, Channel)], SchemeName);
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(identity), SchemeName)));
    }

    protected override Task HandleChallengeAsync(AuthenticationProperties properties)
    {
        Response.Headers.WWWAuthenticate = "Bearer";
        return Problems.WriteAsync(Context, StatusCodes.Status401Unauthorized, "unauthorized", "The automation result token is required.");
    }

    protected override Task HandleForbiddenAsync(AuthenticationProperties properties) =>
        Problems.WriteAsync(Context, StatusCodes.Status403Forbidden, "forbidden", "The action is not allowed.");

    /// <summary>The configured SHA-256 as bytes; null when it is missing or not 64 hex characters.</summary>
    private static byte[]? ExpectedHash(IConfiguration configuration)
    {
        var hex = configuration["Chain:Automation:ResultTokenSha256"];
        if (hex is not { Length: 64 } || !hex.All(char.IsAsciiHexDigit))
        {
            return null;
        }

        return Convert.FromHexString(hex.ToLower(CultureInfo.InvariantCulture));
    }
}

/// <summary>
/// The internal listener (automation-contract.md §4.1): <c>/internal/…</c> is served only to connections that arrived on
/// <c>Chain:Automation:InternalPort</c>, and that port serves nothing else. The local port decides, never the <c>Host</c> header.
/// </summary>
internal static class InternalListener
{
    public const string PathPrefix = "/internal";
    public const int DefaultPort = 8081;

    public static IApplicationBuilder UseInternalListener(this IApplicationBuilder app, IConfiguration configuration)
    {
        var port = configuration.GetValue("Chain:Automation:InternalPort", DefaultPort);
        return app.Use(async (context, next) =>
        {
            if (context.Request.Path.StartsWithSegments(PathPrefix) != (context.Connection.LocalPort == port))
            {
                await Problems.WriteAsync(context, StatusCodes.Status404NotFound, "not_found", "Not found.");
                return;
            }

            await next(context);
        });
    }
}
