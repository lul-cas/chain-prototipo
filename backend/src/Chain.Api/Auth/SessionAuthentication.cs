using System.Globalization;
using System.Security.Claims;
using System.Text.Encodings.Web;
using Chain.Api.Http;
using Chain.Identity;
using Chain.Identity.Application;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;
using AuthenticationService = Chain.Identity.Application.AuthenticationService;

namespace Chain.Api.Auth;

/// <summary>
/// Authenticates bot API tokens (<c>Authorization: Bearer</c>, identity.md I3) or, without one, the <c>chain_session</c>
/// cookie against server-side sessions (ADR-0006 §4). A bearer header always takes precedence over the cookie.
/// </summary>
internal sealed class SessionAuthenticationHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder,
    AuthenticationService authentication)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string SchemeName = "ChainSession";
    public const string CookieName = "chain_session";

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        AuthenticatedUser? user;
        if (BearerToken.TryRead(Request, out var bearer))
        {
            user = await authentication.AuthenticateBearerAsync(bearer, Context.RequestAborted);
            if (user is null)
            {
                return AuthenticateResult.Fail("The API token is invalid or revoked.");
            }
        }
        else
        {
            if (!Request.Cookies.TryGetValue(CookieName, out var token) || string.IsNullOrEmpty(token))
            {
                return AuthenticateResult.NoResult();
            }

            user = await authentication.AuthenticateAsync(token, Context.RequestAborted);
            if (user is null)
            {
                return AuthenticateResult.Fail("The session is invalid or expired.");
            }
        }

        // A bot's token is the HTTP API; a session is the web app (workflow-engine.md §8, card #83).
        var channel = BearerToken.IsPresent(Request) ? CallerClaims.ApiChannel : CallerClaims.UiChannel;
        var identity = new ClaimsIdentity([.. CallerClaims.From(user), new Claim(CallerClaims.ChannelClaim, channel)], SchemeName);
        return AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(identity), SchemeName));
    }

    protected override Task HandleChallengeAsync(AuthenticationProperties properties) =>
        Problems.WriteAsync(Context, StatusCodes.Status401Unauthorized, "unauthenticated", "Authentication is required.");

    protected override Task HandleForbiddenAsync(AuthenticationProperties properties) =>
        Problems.WriteAsync(Context, StatusCodes.Status403Forbidden, "forbidden", "The action is not allowed.");
}

/// <summary>Reads an <c>Authorization: Bearer</c> header.</summary>
internal static class BearerToken
{
    public static bool IsPresent(HttpRequest request) =>
        request.Headers.Authorization.ToString().StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase);

    public static bool TryRead(HttpRequest request, out string token)
    {
        var header = request.Headers.Authorization.ToString();
        token = IsPresent(request) ? header["Bearer ".Length..].Trim() : string.Empty;
        return IsPresent(request);
    }
}

/// <summary>Maps the authenticated caller to and from claims.</summary>
internal static class CallerClaims
{
    private const string SessionId = "chain:session_id";
    private const string DisplayName = "chain:display_name";
    public const string IsAdminClaim = "chain:is_admin";
    private const string MustChangePassword = "chain:must_change_password";
    private const string Kind = "chain:kind";

    /// <summary>
    /// The way the caller came in, set by each scheme (workflow-engine.md §8): <c>ui</c> for a session, <c>api</c> for a bot's token on
    /// the HTTP API, <c>mcp</c> on <c>/mcp</c>, where it is required, and <c>automation</c> for the result call.
    /// </summary>
    public const string ChannelClaim = "chain:channel";
    public const string UiChannel = "ui";
    public const string ApiChannel = "api";
    public const string McpChannel = "mcp";

    public static IEnumerable<Claim> From(AuthenticatedUser user) =>
    [
        new(ClaimTypes.NameIdentifier, user.UserId.ToString()),
        new(ClaimTypes.Name, user.Username),
        new(SessionId, user.SessionId?.ToString() ?? string.Empty),
        new(Kind, user.Kind.ToString()),
        new(DisplayName, user.DisplayName),
        new(IsAdminClaim, user.IsAdmin.ToString(CultureInfo.InvariantCulture)),
        new(MustChangePassword, user.MustChangePassword.ToString(CultureInfo.InvariantCulture)),
    ];

    public static AuthenticatedUser ToCaller(this ClaimsPrincipal principal) => new(
        Guid.Parse(principal.FindFirstValue(ClaimTypes.NameIdentifier)!),
        Guid.TryParse(principal.FindFirstValue(SessionId), out var sessionId) ? sessionId : null,
        principal.FindFirstValue(ClaimTypes.Name)!,
        principal.FindFirstValue(DisplayName)!,
        bool.Parse(principal.FindFirstValue(IsAdminClaim)!),
        bool.Parse(principal.FindFirstValue(MustChangePassword)!),
        Enum.Parse<ActorKind>(principal.FindFirstValue(Kind)!));

    public static bool MustChangePasswordClaim(this ClaimsPrincipal principal) =>
        principal.Identity?.IsAuthenticated == true && principal.FindFirstValue(MustChangePassword) == bool.TrueString;
}
