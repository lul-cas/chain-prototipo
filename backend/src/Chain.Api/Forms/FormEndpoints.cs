using System.Text.Json;
using Chain.Api.Auth;
using Chain.Api.Http;
using Chain.Forms;
using Chain.Forms.Application;
using Microsoft.AspNetCore.Mvc;

namespace Chain.Api.Forms;

internal sealed record CreateFormRequest(string? Name, string? Description);

internal sealed record UpdateFormRequest(string? Name, string? Description);

internal sealed record SaveFormDraftRequest(JsonElement Document)
{
    /// <summary>The document's JSON; a body without <c>document</c> reads as <c>null</c>, which the parser refuses (FM000).</summary>
    public string Json => Document.ValueKind == JsonValueKind.Undefined ? "null" : Document.GetRawText();
}

/// <summary>Form definitions (forms.md §F1). Admins and Modelers only.</summary>
internal static class FormEndpoints
{
    public static IEndpointRouteBuilder MapFormEndpoints(this IEndpointRouteBuilder routes)
    {
        var forms = routes.MapGroup("/api/forms").RequireAuthorization();

        forms.MapGet("/", async (FormModelingService modeling, HttpContext http) =>
            ToResult(await modeling.ListAsync(Actor(http), http.RequestAborted), list => TypedResults.Ok(list)));

        forms.MapPost("/", async (CreateFormRequest request, FormModelingService modeling, HttpContext http) =>
            ToResult(await modeling.CreateAsync(Actor(http), request.Name, request.Description, http.RequestAborted),
                form => WithETag(http, form.Version, TypedResults.Created($"/api/forms/{form.Id}", form))));

        forms.MapGet("/{id:guid}", async (Guid id, FormModelingService modeling, HttpContext http) =>
            ToResult(await modeling.GetAsync(Actor(http), id, http.RequestAborted), form => WithETag(http, form.Version, TypedResults.Ok(form))));

        forms.MapPatch("/{id:guid}", async (Guid id, UpdateFormRequest request, FormModelingService modeling, HttpContext http) =>
            await WithIfMatchAsync(http, async version =>
                ToResult(await modeling.UpdateAsync(Actor(http), id, version, request.Name, request.Description, http.RequestAborted),
                    form => WithETag(http, form.Version, TypedResults.Ok(form)))));

        forms.MapPut("/{id:guid}/draft", async (Guid id, SaveFormDraftRequest request, FormModelingService modeling, HttpContext http) =>
            await WithIfMatchAsync(http, async version =>
                ToResult(await modeling.SaveDraftAsync(Actor(http), id, version, request.Json, http.RequestAborted),
                    form => WithETag(http, form.Version, TypedResults.Ok(form)))));

        forms.MapPost("/{id:guid}/validate", async (Guid id, FormModelingService modeling, HttpContext http) =>
            ToResult(await modeling.ValidateAsync(Actor(http), id, http.RequestAborted), report => TypedResults.Ok(report)));

        forms.MapPost("/{id:guid}/publish", async (Guid id, FormModelingService modeling, HttpContext http) =>
            await WithIfMatchAsync(http, async version =>
                ToResult(await modeling.PublishAsync(Actor(http), id, version, http.RequestAborted),
                    outcome => outcome.Created ? TypedResults.Created($"/api/forms/{id}/versions/{outcome.VersionNumber}", outcome) : TypedResults.Ok(outcome))));

        forms.MapGet("/{id:guid}/versions", async (Guid id, FormModelingService modeling, HttpContext http) =>
            ToResult(await modeling.ListVersionsAsync(Actor(http), id, http.RequestAborted), versions => TypedResults.Ok(versions)));

        forms.MapGet("/{id:guid}/versions/{number:int}", async (Guid id, int number, FormModelingService modeling, HttpContext http) =>
            ToResult(await modeling.GetVersionAsync(Actor(http), id, number, http.RequestAborted), version => TypedResults.Ok(version)));

        forms.MapPost("/{id:guid}/versions/{number:int}/restore", async (Guid id, int number, FormModelingService modeling, HttpContext http) =>
            await WithIfMatchAsync(http, async version =>
                ToResult(await modeling.RestoreAsync(Actor(http), id, number, version, http.RequestAborted),
                    form => WithETag(http, form.Version, TypedResults.Ok(form)))));

        forms.MapPost("/{id:guid}/versions/{number:int}/validate-submission", async (Guid id, int number, [FromBody] JsonElement submission, FormModelingService modeling, HttpContext http) =>
            ToResult(await modeling.ValidateSubmissionAsync(Actor(http), id, number, submission.GetRawText(), http.RequestAborted), report => TypedResults.Ok(report)));

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

    private static IResult ToResult<T>(FormResult<T> result, Func<T, IResult> onSuccess) => result.Error switch
    {
        null => onSuccess(result.Value!),
        FormError.Forbidden => Problems.Create(StatusCodes.Status403Forbidden, "forbidden", "Only admins and modelers can manage forms."),
        FormError.NotFound => Problems.Create(StatusCodes.Status404NotFound, "not_found", "The resource does not exist."),
        FormError.ValidationFailed => Problems.ValidationFailed([.. result.Details]),
        FormError.InvalidDocument => Issues(StatusCodes.Status400BadRequest, "invalid_document", "The document is not a valid form document.", result.Issues),
        FormError.NameTaken => Problems.Create(StatusCodes.Status409Conflict, "form_name_taken", "A form with this name already exists."),
        FormError.VersionMismatch => ETags.VersionMismatch(),
        FormError.FormValidationFailed => Issues(StatusCodes.Status422UnprocessableEntity, "form_validation_failed", "The draft cannot be published.", result.Issues),
        _ => throw new ArgumentOutOfRangeException(nameof(result)),
    };

    private static Microsoft.AspNetCore.Http.HttpResults.ProblemHttpResult Issues(int status, string code, string title, IReadOnlyList<FormIssue> issues)
    {
        var problem = new ProblemDetails { Status = status, Title = title };
        problem.Extensions["code"] = code;
        problem.Extensions["errors"] = issues.Select(i => new { code = i.Code, message = i.Message, path = i.Path }).ToList();
        return TypedResults.Problem(problem);
    }
}
