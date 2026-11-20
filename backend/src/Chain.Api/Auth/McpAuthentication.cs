using System.Security.Claims;
using System.Text.Encodings.Web;
using Chain.Api.Http;
using Chain.Mcp;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;
using AuthenticationService = Chain.Identity.Application.AuthenticationService;

namespace Chain.Api.Auth;

/// <summary>
/// The default scheme: <c>/mcp</c> is authenticated only by <see cref="McpAuthenticationHandler"/>, <c>/internal</c> only by
/// <see cref="AutomationResultAuthenticationHandler"/>, everything else by <see cref="SessionAuthenticationHandler"/>. Each request is
/// authenticated once, by one of them.
/// </summary>
internal static class ChainAuthentication
{
    public const string SchemeName = "Chain";

    public static string SelectScheme(HttpContext context) =>
        context.Request.Path.StartsWithSegments(McpRegistration.Path) ? McpAuthenticationHandler.SchemeName
        : context.Request.Path.StartsWithSegments(InternalListener.PathPrefix) ? AutomationResultAuthenticationHandler.SchemeName
        : SessionAuthenticationHandler.SchemeName;
}

/// <summary>
/// Authenticates <c>/mcp</c> (ADR-0015 §5): bot API tokens only, and only for bots with MCP enabled. The session cookie is never
/// read, so a signed-in browser cannot reach MCP. Failures answer 401 with <c>WWW-Authenticate: Bearer</c>.
/// </summary>
internal sealed class McpAuthenticationHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder,
    AuthenticationService authentication)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string SchemeName = "ChainMcp";
    public const string Policy = "Mcp";

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        if (!BearerToken.TryRead(Request, out var bearer))
        {
            return AuthenticateResult.NoResult();
        }

        var user = await authentication.AuthenticateMcpAsync(bearer, Context.RequestAborted);
        if (user is null)
        {
            return AuthenticateResult.Fail("The API token is invalid or revoked, or its bot may not use MCP.");
        }

        var identity = new ClaimsIdentity([.. CallerClaims.From(user), new Claim(CallerClaims.ChannelClaim, CallerClaims.McpChannel)], SchemeName);
        return AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(identity), SchemeName));
    }

    protected override Task HandleChallengeAsync(AuthenticationProperties properties)
    {
        Response.Headers.WWWAuthenticate = "Bearer";
        return Problems.WriteAsync(Context, StatusCodes.Status401Unauthorized, "unauthenticated", "A token of a bot enabled for MCP is required.");
    }

    protected override Task HandleForbiddenAsync(AuthenticationProperties properties) =>
        Problems.WriteAsync(Context, StatusCodes.Status403Forbidden, "forbidden", "The action is not allowed.");
}
