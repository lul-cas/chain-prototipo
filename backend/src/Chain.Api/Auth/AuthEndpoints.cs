using Chain.Api.Http;
using Chain.Identity.Application;

namespace Chain.Api.Auth;

internal sealed record LoginRequest(string? Username, string? Password);

internal sealed record ChangePasswordRequest(string? CurrentPassword, string? NewPassword);

/// <summary>The caller (identity.md). <c>CanModel</c> follows the workflow endpoints' rule, so the navigation can offer modeling.</summary>
internal sealed record MeResponse(
    Guid Id, string Kind, string Username, string DisplayName, bool IsAdmin, bool MustChangePassword, IReadOnlyList<GroupRef> Groups, bool CanModel);

/// <summary>Authentication endpoints of identity increment I1 (specs/modules/identity.md).</summary>
internal static class AuthEndpoints
{
    public static IEndpointRouteBuilder MapAuthEndpoints(this IEndpointRouteBuilder routes)
    {
        var auth = routes.MapGroup("/api/auth");
        auth.MapPost("/login", LoginAsync).AllowAnonymous();
        auth.MapPost("/logout", LogoutAsync).RequireAuthorization();
        auth.MapGet("/me", MeAsync).RequireAuthorization();
        auth.MapPost("/change-password", ChangePasswordAsync).RequireAuthorization();
        return routes;
    }

    private static async Task<IResult> LoginAsync(
        LoginRequest request, AuthenticationService authentication, HttpContext context, IHostEnvironment environment)
    {
        if (string.IsNullOrEmpty(request.Username) || string.IsNullOrEmpty(request.Password))
        {
            return Problems.ValidationFailed("username_and_password_required");
        }

        if (request.Password.Length > AuthenticationService.MaxPasswordInputLength)
        {
            return Problems.ValidationFailed("password_too_long");
        }

        var result = await authentication.LoginAsync(request.Username, request.Password, context.RequestAborted);
        if (result is not LoginResult.Succeeded succeeded)
        {
            return Problems.Create(StatusCodes.Status401Unauthorized, "invalid_credentials", "Invalid username or password.");
        }

        context.Response.Cookies.Append(SessionAuthenticationHandler.CookieName, succeeded.SessionToken, CookieOptions(environment));
        return TypedResults.NoContent();
    }

    private static async Task<IResult> LogoutAsync(AuthenticationService authentication, HttpContext context, IHostEnvironment environment)
    {
        if (context.User.ToCaller().SessionId is null)
        {
            return BotsNotAllowed();
        }

        await authentication.LogoutAsync(context.User.ToCaller(), context.RequestAborted);
        context.Response.Cookies.Delete(SessionAuthenticationHandler.CookieName, CookieOptions(environment));
        return TypedResults.NoContent();
    }

    private static async Task<Microsoft.AspNetCore.Http.HttpResults.Ok<MeResponse>> MeAsync(
        HttpContext context, AuthenticationService authentication, Chain.SharedKernel.IModelingAuthorization modeling)
    {
        var caller = context.User.ToCaller();
        var groups = await authentication.GetGroupsAsync(caller.UserId, context.RequestAborted);
        var canModel = await modeling.CanModelAsync(caller.UserId, context.RequestAborted);
        var kind = caller.Kind == Chain.Identity.ActorKind.Bot ? "bot" : "user";
        return TypedResults.Ok(new MeResponse(
            caller.UserId, kind, caller.Username, caller.DisplayName, caller.IsAdmin, caller.MustChangePassword, groups, canModel));
    }

    private static async Task<IResult> ChangePasswordAsync(ChangePasswordRequest request, AuthenticationService authentication, HttpContext context)
    {
        if (context.User.ToCaller().SessionId is null)
        {
            return BotsNotAllowed();
        }

        if (string.IsNullOrEmpty(request.CurrentPassword) || string.IsNullOrEmpty(request.NewPassword))
        {
            return Problems.ValidationFailed("current_and_new_password_required");
        }

        if (request.CurrentPassword.Length > AuthenticationService.MaxPasswordInputLength)
        {
            return Problems.ValidationFailed("password_too_long");
        }

        var result = await authentication.ChangePasswordAsync(context.User.ToCaller(), request.CurrentPassword, request.NewPassword, context.RequestAborted);
        return result switch
        {
            ChangePasswordResult.Succeeded => TypedResults.NoContent(),
            ChangePasswordResult.PolicyViolated violated => Problems.ValidationFailed([.. violated.Errors]),
            _ => Problems.Create(StatusCodes.Status403Forbidden, "invalid_current_password", "The current password is incorrect."),
        };
    }

    /// <summary>Bots authenticate with API tokens: they have no session to end and no password to change.</summary>
    private static IResult BotsNotAllowed() =>
        Problems.Create(StatusCodes.Status403Forbidden, "forbidden", "The action is not available to bots.");

    private static CookieOptions CookieOptions(IHostEnvironment environment) => new()
    {
        HttpOnly = true,
        Secure = !environment.IsDevelopment(),
        SameSite = SameSiteMode.Strict,
        Path = "/",
        IsEssential = true,
    };
}
