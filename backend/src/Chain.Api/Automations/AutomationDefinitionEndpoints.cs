using System.Text.Json;
using Chain.Api.Auth;
using Chain.Api.Http;
using Chain.Automations.Application;

namespace Chain.Api.Automations;

internal sealed record CreateAutomationRequest(string? Name, string? Description);

internal sealed record UpdateAutomationRequest(string? Name, string? Description);

internal sealed record SaveAutomationDraftRequest(JsonElement Document)
{
    /// <summary>The document's JSON; a body without <c>document</c> reads as <c>null</c>, which the parser refuses (AU000).</summary>
    public string Json => Document.ValueKind == JsonValueKind.Undefined ? "null" : Document.GetRawText();
}

/// <summary>Automation definitions (automation.md §5.1), with the shapes and status codes of <c>/api/forms</c>. Admins and Modelers only.</summary>
internal static class AutomationDefinitionEndpoints
{
    public static IEndpointRouteBuilder MapAutomationDefinitionEndpoints(this IEndpointRouteBuilder routes)
    {
        var automations = routes.MapGroup("/api/automations").RequireAuthorization();

        automations.MapGet("/", async (AutomationModelingService modeling, HttpContext http) =>
            AutomationEndpoints.ToResult(await modeling.ListAsync(Actor(http), http.RequestAborted), list => TypedResults.Ok(list)));

        automations.MapPost("/", async (CreateAutomationRequest request, AutomationModelingService modeling, HttpContext http) =>
            AutomationEndpoints.ToResult(await modeling.CreateAsync(Actor(http), request.Name, request.Description, http.RequestAborted),
                automation => WithETag(http, automation.Version, TypedResults.Created($"/api/automations/{automation.Id}", automation))));

        automations.MapGet("/{id:guid}", async (Guid id, AutomationModelingService modeling, HttpContext http) =>
            AutomationEndpoints.ToResult(await modeling.GetAsync(Actor(http), id, http.RequestAborted),
                automation => WithETag(http, automation.Version, TypedResults.Ok(automation))));

        automations.MapPatch("/{id:guid}", async (Guid id, UpdateAutomationRequest request, AutomationModelingService modeling, HttpContext http) =>
            await WithIfMatchAsync(http, async version =>
                AutomationEndpoints.ToResult(await modeling.UpdateAsync(Actor(http), id, version, request.Name, request.Description, http.RequestAborted),
                    automation => WithETag(http, automation.Version, TypedResults.Ok(automation)))));

        automations.MapPut("/{id:guid}/draft", async (Guid id, SaveAutomationDraftRequest request, AutomationModelingService modeling, HttpContext http) =>
            await WithIfMatchAsync(http, async version =>
                AutomationEndpoints.ToResult(await modeling.SaveDraftAsync(Actor(http), id, version, request.Json, http.RequestAborted),
                    automation => WithETag(http, automation.Version, TypedResults.Ok(automation)))));

        automations.MapPost("/{id:guid}/validate", async (Guid id, AutomationModelingService modeling, HttpContext http) =>
            AutomationEndpoints.ToResult(await modeling.ValidateAsync(Actor(http), id, http.RequestAborted), report => TypedResults.Ok(report)));

        automations.MapPost("/{id:guid}/publish", async (Guid id, AutomationModelingService modeling, HttpContext http) =>
            await WithIfMatchAsync(http, async version =>
                AutomationEndpoints.ToResult(await modeling.PublishAsync(Actor(http), id, version, http.RequestAborted),
                    outcome => outcome.Created
                        ? TypedResults.Created($"/api/automations/{id}/versions/{outcome.VersionNumber}", outcome)
                        : TypedResults.Ok(outcome))));

        automations.MapGet("/{id:guid}/versions", async (Guid id, AutomationModelingService modeling, HttpContext http) =>
            AutomationEndpoints.ToResult(await modeling.ListVersionsAsync(Actor(http), id, http.RequestAborted), versions => TypedResults.Ok(versions)));

        automations.MapGet("/{id:guid}/versions/{number:int}", async (Guid id, int number, AutomationModelingService modeling, HttpContext http) =>
            AutomationEndpoints.ToResult(await modeling.GetVersionAsync(Actor(http), id, number, http.RequestAborted), version => TypedResults.Ok(version)));

        automations.MapPost("/{id:guid}/versions/{number:int}/restore", async (Guid id, int number, AutomationModelingService modeling, HttpContext http) =>
            await WithIfMatchAsync(http, async version =>
                AutomationEndpoints.ToResult(await modeling.RestoreAsync(Actor(http), id, number, version, http.RequestAborted),
                    automation => WithETag(http, automation.Version, TypedResults.Ok(automation)))));

        return routes;
    }

    private static Guid Actor(HttpContext http) => http.User.ToCaller().UserId;

    private static IResult WithETag(HttpContext http, uint version, IResult result)
    {
        http.Response.Headers.ETag = ETags.Format(version);
        return result;
    }

    /// <summary>Requires <c>If-Match</c>: missing → 428, unparsable → 412.</summary>
    private static async Task<IResult> WithIfMatchAsync(HttpContext http, Func<uint, Task<IResult>> action) =>
        ETags.ReadIfMatch(http, out var problem) is { } version ? await action(version) : problem!;
}
