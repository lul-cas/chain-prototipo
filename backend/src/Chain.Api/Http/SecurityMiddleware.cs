using Chain.SharedKernel;
using Chain.Api.Auth;
using Chain.Identity.Application;
using Chain.Mcp;
using Microsoft.AspNetCore.Http.Features;

namespace Chain.Api.Http;

internal static class SecurityMiddleware
{
    private static readonly HashSet<string> SafeMethods = new(StringComparer.OrdinalIgnoreCase) { "GET", "HEAD", "OPTIONS", "TRACE" };

    private static readonly HashSet<string> PasswordChangeAllowed = new(StringComparer.OrdinalIgnoreCase)
    {
        // Login stays reachable: it is anonymous, and a signed-in browser may sign in again (e.g. as another user).
        "/api/auth/login", "/api/auth/me", "/api/auth/logout", "/api/auth/change-password",
    };

    /// <summary>
    /// CSRF defence (specs/modules/identity.md): state-changing API requests must come from a configured frontend origin.
    /// Combined with SameSite=Strict session cookies. On MCP (ADR-0015 §4) bots send no <c>Origin</c>, but a request that carries
    /// one must come from a configured origin, bearer token or not, as the MCP specification requires.
    /// </summary>
    public static IApplicationBuilder UseOriginCheck(this IApplicationBuilder app, IConfiguration configuration)
    {
        var allowed = configuration.GetSection("Chain:AllowedOrigins").Get<string[]>() ?? [];
        var allowedOrigins = new HashSet<string>(allowed.Select(o => o.TrimEnd('/')), StringComparer.OrdinalIgnoreCase);

        return app.Use(async (context, next) =>
        {
            if (context.Request.Path.StartsWithSegments(McpRegistration.Path)
                && context.Request.Headers.Origin is { Count: > 0 } mcpOrigin
                && !allowedOrigins.Contains(mcpOrigin.ToString().TrimEnd('/')))
            {
                await Problems.WriteAsync(context, StatusCodes.Status403Forbidden, "origin_not_allowed", "The request origin is not allowed.");
                return;
            }

            // Bearer tokens are never sent automatically by browsers, so bearer requests are not exposed to CSRF (identity.md I3).
            if (context.Request.Path.StartsWithSegments("/api") && !SafeMethods.Contains(context.Request.Method) && !BearerToken.IsPresent(context.Request))
            {
                var origin = context.Request.Headers.Origin.ToString();
                if (string.IsNullOrEmpty(origin) || !allowedOrigins.Contains(origin.TrimEnd('/')))
                {
                    await Problems.WriteAsync(context, StatusCodes.Status403Forbidden, "origin_not_allowed", "The request origin is not allowed.");
                    return;
                }
            }

            await next(context);
        });
    }

    /// <summary>
    /// MCP request bodies are limited to 256 KB (ADR-0015 §4), far below the upload limit that applies elsewhere. A declared length
    /// is refused before anything reads the body; a chunked body is cut off by the server at the same size.
    /// </summary>
    public static IApplicationBuilder UseMcpBodyLimit(this IApplicationBuilder app) => app.Use(async (context, next) =>
    {
        if (!context.Request.Path.StartsWithSegments(McpRegistration.Path))
        {
            await next(context);
            return;
        }

        if (context.Request.ContentLength > McpRegistration.MaxRequestBytes)
        {
            await PayloadTooLargeAsync(context);
            return;
        }

        if (context.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit)
        {
            limit.MaxRequestBodySize = McpRegistration.MaxRequestBytes;
        }

        try
        {
            await next(context);
        }
        catch (BadHttpRequestException exception) when (exception.StatusCode == StatusCodes.Status413PayloadTooLarge && !context.Response.HasStarted)
        {
            await PayloadTooLargeAsync(context);
        }
    });

    private static Task PayloadTooLargeAsync(HttpContext context) =>
        Problems.WriteAsync(context, StatusCodes.Status413PayloadTooLarge, "payload_too_large", "The request body is larger than 256 KB.");

    /// <summary>Users who must change their password may only reach the auth endpoints needed to do so.</summary>
    public static IApplicationBuilder UsePasswordChangeGate(this IApplicationBuilder app) => app.Use(async (context, next) =>
    {
        if (context.User.MustChangePasswordClaim()
            && context.Request.Path.StartsWithSegments("/api")
            && !PasswordChangeAllowed.Contains(context.Request.Path.Value!.TrimEnd('/')))
        {
            await Problems.WriteAsync(context, StatusCodes.Status403Forbidden, "password_change_required", "The password must be changed first.");
            return;
        }

        await next(context);
    });

    /// <summary>
    /// Maps optimistic-concurrency failures to 409 (ADR-0008 §2). A unique violation that no use case handled itself means a
    /// concurrent request wrote the same thing first (for example two completions of one task), so it is a conflict too.
    /// </summary>
    public static IApplicationBuilder UseFileTooLarge(this IApplicationBuilder app) => app.Use(async (context, next) =>
    {
        try
        {
            await next(context);
        }
        catch (BadHttpRequestException exception) when (exception.StatusCode == StatusCodes.Status413PayloadTooLarge && !context.Response.HasStarted)
        {
            await Problems.WriteAsync(context, StatusCodes.Status413PayloadTooLarge, "file_too_large", "The file is larger than the limit.");
        }
    });

    public static IApplicationBuilder UseConcurrencyConflictHandling(this IApplicationBuilder app) => app.Use(async (context, next) =>
    {
        try
        {
            await next(context);
        }
        catch (Exception ex) when (ex is ConcurrencyConflictException or UniqueConstraintViolationException && !context.Response.HasStarted)
        {
            await Problems.WriteAsync(context, StatusCodes.Status409Conflict, "concurrency_conflict", "The record was changed by another request.");
        }
    });
}
