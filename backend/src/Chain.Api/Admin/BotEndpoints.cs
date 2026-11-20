using Chain.Api.Auth;
using Chain.Identity.Application;

namespace Chain.Api.Admin;

internal sealed record CreateBotRequest(string? Name, string? DisplayName);

internal sealed record UpdateBotRequest(string? DisplayName);

internal sealed record CreateTokenRequest(string? Label);

internal sealed record McpRateRequest(int? CallsPerMinute);

/// <summary>Bot and API-token administration (identity increment I3, specs/modules/identity.md).</summary>
internal static class BotEndpoints
{
    public static IEndpointRouteBuilder MapBotEndpoints(this IEndpointRouteBuilder routes)
    {
        var bots = routes.MapGroup("/api/admin/bots").RequireAuthorization(AdminEndpoints.AdminPolicy);
        bots.MapGet("/", async (AdministrationService admin, HttpContext http) =>
            TypedResults.Ok(await admin.ListBotsAsync(http.RequestAborted)));
        bots.MapPost("/", async (CreateBotRequest request, AdministrationService admin, HttpContext http) =>
            AdminEndpoints.ToResult(await admin.CreateBotAsync(Actor(http), request.Name, request.DisplayName, http.RequestAborted),
                bot => TypedResults.Created($"/api/admin/bots/{bot.Id}", bot)));
        bots.MapGet("/{id:guid}", async (Guid id, AdministrationService admin, HttpContext http) =>
            AdminEndpoints.Versioned(http, await admin.GetBotAsync(id, http.RequestAborted), bot => bot.Version));
        bots.MapPatch("/{id:guid}", async (Guid id, UpdateBotRequest request, AdministrationService admin, HttpContext http) =>
            await AdminEndpoints.WithVersionAsync(http, version => admin.UpdateBotAsync(Actor(http), id, version, request.DisplayName, http.RequestAborted),
                bot => bot.Version));
        bots.MapPost("/{id:guid}/deactivate", async (Guid id, AdministrationService admin, HttpContext http) =>
            AdminEndpoints.NoContent(await admin.SetBotActiveAsync(Actor(http), id, active: false, http.RequestAborted)));
        bots.MapPost("/{id:guid}/activate", async (Guid id, AdministrationService admin, HttpContext http) =>
            AdminEndpoints.NoContent(await admin.SetBotActiveAsync(Actor(http), id, active: true, http.RequestAborted)));
        bots.MapPost("/{id:guid}/mcp/enable", async (Guid id, AdministrationService admin, HttpContext http) =>
            AdminEndpoints.NoContent(await admin.SetBotMcpEnabledAsync(Actor(http), id, enabled: true, http.RequestAborted)));
        bots.MapPost("/{id:guid}/mcp/disable", async (Guid id, AdministrationService admin, HttpContext http) =>
            AdminEndpoints.NoContent(await admin.SetBotMcpEnabledAsync(Actor(http), id, enabled: false, http.RequestAborted)));
        bots.MapPut("/{id:guid}/mcp/rate", async (Guid id, McpRateRequest request, AdministrationService admin, HttpContext http) =>
            AdminEndpoints.ToResult(await admin.SetBotMcpRateAsync(Actor(http), id, request.CallsPerMinute, http.RequestAborted),
                bot => TypedResults.Ok(bot)));
        bots.MapPost("/{id:guid}/tokens", async (Guid id, CreateTokenRequest request, AdministrationService admin, HttpContext http) =>
            AdminEndpoints.ToResult(await admin.CreateTokenAsync(Actor(http), id, request.Label, http.RequestAborted),
                created => TypedResults.Created($"/api/admin/bots/{id}", created)));
        bots.MapPost("/{id:guid}/tokens/{tokenId:guid}/revoke", async (Guid id, Guid tokenId, AdministrationService admin, HttpContext http) =>
            AdminEndpoints.NoContent(await admin.RevokeTokenAsync(Actor(http), id, tokenId, http.RequestAborted)));
        return routes;
    }

    private static Guid Actor(HttpContext http) => http.User.ToCaller().UserId;
}
