using System.Text.Json;
using Chain.Api.Auth;
using Chain.Api.Http;
using Chain.Workflows.Application;

namespace Chain.Api.Workflows;

internal sealed record CreateWorkflowRequest(string? Name, string? Description);

internal sealed record UpdateWorkflowRequest(string? Name, string? Description);

internal sealed record SaveDraftRequest(JsonElement Document)
{
    /// <summary>The document's JSON; a body without <c>document</c> reads as <c>null</c>, which the parser refuses (WF000).</summary>
    public string Json => Document.ValueKind == JsonValueKind.Undefined ? "null" : Document.GetRawText();
}

/// <summary>Workflow definitions, drafts, publishing, versions and grants (workflow-definition.md §5). Admins and Modelers only.</summary>
internal static class WorkflowEndpoints
{
    public static IEndpointRouteBuilder MapWorkflowEndpoints(this IEndpointRouteBuilder routes)
    {
        var workflows = routes.MapGroup("/api/workflows").RequireAuthorization();

        workflows.MapGet("/", async (WorkflowModelingService modeling, HttpContext http) =>
            ToResult(await modeling.ListAsync(Actor(http), http.RequestAborted), list => TypedResults.Ok(list)));

        workflows.MapGet("/groups", async (WorkflowModelingService modeling, HttpContext http) =>
            ToResult(await modeling.ListLaneGroupsAsync(Actor(http), http.RequestAborted), groups => TypedResults.Ok(groups)));

        workflows.MapPost("/", async (CreateWorkflowRequest request, WorkflowModelingService modeling, HttpContext http) =>
            ToResult(await modeling.CreateAsync(Actor(http), request.Name, request.Description, http.RequestAborted),
                definition => WithETag(http, definition.Version, TypedResults.Created($"/api/workflows/{definition.Id}", definition))));

        workflows.MapGet("/{id:guid}", async (Guid id, WorkflowModelingService modeling, HttpContext http) =>
            ToResult(await modeling.GetAsync(Actor(http), id, http.RequestAborted), definition => WithETag(http, definition.Version, TypedResults.Ok(definition))));

        workflows.MapPatch("/{id:guid}", async (Guid id, UpdateWorkflowRequest request, WorkflowModelingService modeling, HttpContext http) =>
            await WithIfMatchAsync(http, async version =>
                ToResult(await modeling.UpdateAsync(Actor(http), id, version, request.Name, request.Description, http.RequestAborted),
                    definition => WithETag(http, definition.Version, TypedResults.Ok(definition)))));

        workflows.MapPut("/{id:guid}/draft", async (Guid id, SaveDraftRequest request, WorkflowModelingService modeling, HttpContext http) =>
            await WithIfMatchAsync(http, async version =>
                ToResult(await modeling.SaveDraftAsync(Actor(http), id, version, request.Json, http.RequestAborted),
                    definition => WithETag(http, definition.Version, TypedResults.Ok(definition)))));

        workflows.MapPost("/{id:guid}/validate", async (Guid id, WorkflowModelingService modeling, HttpContext http) =>
            ToResult(await modeling.ValidateAsync(Actor(http), id, http.RequestAborted), report => TypedResults.Ok(report)));

        workflows.MapGet("/{id:guid}/data-catalog", async (Guid id, WorkflowModelingService modeling, HttpContext http) =>
            ToResult(await modeling.GetDataCatalogAsync(Actor(http), id, http.RequestAborted), catalog => TypedResults.Ok(catalog)));

        workflows.MapPost("/{id:guid}/publish",async (Guid id, WorkflowModelingService modeling, HttpContext http) =>
            await WithIfMatchAsync(http, async version =>
                ToResult(await modeling.PublishAsync(Actor(http), id, version, http.RequestAborted),
                    outcome => outcome.Created
                        ? TypedResults.Created($"/api/workflows/{id}/versions/{outcome.VersionNumber}", outcome)
                        : TypedResults.Ok(outcome))));

        workflows.MapPost("/{id:guid}/activate", async (Guid id, WorkflowModelingService modeling, HttpContext http) =>
            ToResult(await modeling.SetActiveAsync(Actor(http), id, active: true, http.RequestAborted), _ => TypedResults.NoContent()));

        workflows.MapPost("/{id:guid}/deactivate", async (Guid id, WorkflowModelingService modeling, HttpContext http) =>
            ToResult(await modeling.SetActiveAsync(Actor(http), id, active: false, http.RequestAborted), _ => TypedResults.NoContent()));

        workflows.MapGet("/{id:guid}/versions", async (Guid id, WorkflowModelingService modeling, HttpContext http) =>
            ToResult(await modeling.ListVersionsAsync(Actor(http), id, http.RequestAborted), versions => TypedResults.Ok(versions)));

        workflows.MapGet("/{id:guid}/versions/{number:int}", async (Guid id, int number, WorkflowModelingService modeling, HttpContext http) =>
            ToResult(await modeling.GetVersionAsync(Actor(http), id, number, http.RequestAborted), version => TypedResults.Ok(version)));

        workflows.MapGet("/{id:guid}/versions/{number:int}/contract", async (Guid id, int number, WorkflowModelingService modeling, HttpContext http) =>
            ToResult(await modeling.GetVersionContractAsync(Actor(http), id, number, http.RequestAborted), contract => TypedResults.Ok(contract)));

        workflows.MapPost("/{id:guid}/versions/{number:int}/restore", async (Guid id, int number, WorkflowModelingService modeling, HttpContext http) =>
            await WithIfMatchAsync(http, async version =>
                ToResult(await modeling.RestoreAsync(Actor(http), id, number, version, http.RequestAborted),
                    definition => WithETag(http, definition.Version, TypedResults.Ok(definition)))));

        workflows.MapGet("/{id:guid}/grants", async (Guid id, WorkflowModelingService modeling, HttpContext http) =>
            ToResult(await modeling.GetGrantsAsync(Actor(http), id, http.RequestAborted), grants => TypedResults.Ok(grants)));

        workflows.MapPut("/{id:guid}/grants", async (Guid id, List<GrantInput>? grants, WorkflowModelingService modeling, HttpContext http) =>
            await WithIfMatchAsync(http, async version =>
                ToResult(await modeling.ReplaceGrantsAsync(Actor(http), id, version, grants, http.RequestAborted),
                    replaced => WithETag(http, replaced.Version, TypedResults.Ok(replaced.Grants)))));

        return routes;
    }

    private static Guid Actor(HttpContext http) => http.User.ToCaller().UserId;

    private static IResult WithETag(HttpContext http, uint version, IResult result)
    {
        http.Response.Headers.ETag = ETags.Format(version);
        return result;
    }

    private static async Task<IResult> WithIfMatchAsync(HttpContext http, Func<uint, Task<IResult>> action) =>
        ETags.ReadIfMatch(http, out var problem) is { } version ? await action(version) : problem!;

    private static IResult ToResult<T>(ModelingResult<T> result, Func<T, IResult> onSuccess) => result.Error switch
    {
        null => onSuccess(result.Value!),
        ModelingError.Forbidden => Problems.Create(StatusCodes.Status403Forbidden, "forbidden", "Only admins and modelers can manage workflows."),
        ModelingError.NotFound => Problems.Create(StatusCodes.Status404NotFound, "not_found", "The resource does not exist."),
        ModelingError.ValidationFailed => Problems.ValidationFailed([.. result.Details]),
        ModelingError.InvalidDocument => Problems.WithFindings(StatusCodes.Status400BadRequest, "invalid_document", "The document is not a valid workflow document.", result.Findings),
        ModelingError.NameTaken => Problems.Create(StatusCodes.Status409Conflict, "workflow_name_taken", "A workflow with this name already exists."),
        ModelingError.VersionMismatch => ETags.VersionMismatch(),
        ModelingError.PublishValidationFailed => Problems.WithFindings(StatusCodes.Status422UnprocessableEntity, "publish_validation_failed", "The draft cannot be published.", result.Findings),
        ModelingError.InvalidGrants => Problems.Create(StatusCodes.Status422UnprocessableEntity, "invalid_grants", "The grants are invalid.", result.Details),
        _ => throw new ArgumentOutOfRangeException(nameof(result)),
    };
}
