using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Chain.Api.Auth;
using Chain.Api.Http;
using Chain.SharedKernel;
using Chain.Workflows.Application.Engine;
using Chain.Workflows.Runtime;

namespace Chain.Api.Engine;

internal sealed record StartInstanceRequest(Guid DefinitionId, System.Text.Json.JsonElement? Data);

internal sealed record CompleteTaskRequest(string? Comment, System.Text.Json.JsonElement? Data);

internal sealed record DecideTaskRequest(bool? Outcome, string? Justification);

internal sealed record CloseInstanceRequest(string? Justification);

internal sealed record CommentRequest(string? Text, Guid[]? FileIds);

internal sealed record CorrectDataRequest(JsonElement? Changes, string? Justification);

/// <summary>Engine increment E1 endpoints (workflow-engine.md §9).</summary>
internal static class InstanceEndpoints
{
    private const int MaxIdempotencyKeyLength = 200;

    public static IEndpointRouteBuilder MapInstanceEndpoints(this IEndpointRouteBuilder routes)
    {
        var api = routes.MapGroup("/api").RequireAuthorization();

        api.MapGet("/startable-workflows", async (InstanceService engine, HttpContext http) =>
            TypedResults.Ok(await engine.ListStartableAsync(Actor(http), http.RequestAborted)));

        api.MapGet("/startable-workflows/{id:guid}/start-form", async (Guid id, InstanceService engine, HttpContext http) =>
            ToResult(await engine.GetStartFormAsync(Actor(http), id, http.RequestAborted), form => TypedResults.Ok(form)));

        api.MapPost("/instances", async (StartInstanceRequest request, InstanceService engine, HttpContext http) =>
            NotUnicode(request.Data, SubmissionProblem) ?? await IdempotentAsync(http, request, async key =>
                ToResult(await engine.StartAsync(Actor(http), request.DefinitionId, request.Data, key, http.RequestAborted),
                    view => Versioned(http, view, TypedResults.Created($"/api/instances/{view.Id}", view)))));

        api.MapGet("/instances", async (string? scope, string? status, InstanceService engine, HttpContext http) =>
        {
            var mineOnly = scope switch
            {
                null or "visible" => false,
                "mine" => true,
                _ => (bool?)null,
            };
            InstanceStatus? wanted = null;
            if (mineOnly is null || (status is not null && !TryParseStatus(status, out wanted)))
            {
                return Problems.ValidationFailed("invalid_scope_or_status");
            }

            return TypedResults.Ok(await engine.ListAsync(Actor(http), mineOnly.Value, wanted, http.RequestAborted));
        });

        api.MapGet("/instances/{id:guid}", async (Guid id, InstanceService engine, HttpContext http) =>
            ToResult(await engine.GetAsync(Actor(http), id, http.RequestAborted), view => Versioned(http, view, TypedResults.Ok(view))));

        api.MapGet("/instances/{id:guid}/diagram", async (Guid id, InstanceService engine, HttpContext http) =>
            ToResult(await engine.GetDiagramAsync(Actor(http), id, http.RequestAborted), diagram => TypedResults.Ok(diagram)));

        api.MapPost("/instances/{id:guid}/comments", async (Guid id, CommentRequest request, InstanceService engine, HttpContext http) =>
            await IdempotentAsync(http, request, async key =>
                ToResult(await engine.CommentAsync(Actor(http), id, request.Text, request.FileIds, key, http.RequestAborted), view => Versioned(http, view, TypedResults.Ok(view)))));

        api.MapPost("/instances/{id:guid}/close", async (Guid id, CloseInstanceRequest request, InstanceService engine, HttpContext http) =>
            await IdempotentAsync(http, request, async key =>
                ToResult(await engine.CloseAsync(Actor(http), id, request.Justification, key, http.RequestAborted), view => Versioned(http, view, TypedResults.Ok(view)))));

        // Admin data correction (workflow-engine.md §16): If-Match is checked first, as on every versioned resource (ADR-0008 §3).
        api.MapPatch("/instances/{id:guid}/data", async (Guid id, CorrectDataRequest request, InstanceService engine, HttpContext http) =>
            ETags.ReadIfMatch(http, out var precondition) is not { } version
                ? precondition!
                : NotUnicode(request.Changes, CorrectionProblem) ?? await IdempotentAsync(http, request, async key =>
                    ToResult(await engine.CorrectAsync(Actor(http), id, version, request.Changes, request.Justification, key, http.RequestAborted),
                        view => Versioned(http, view, TypedResults.Ok(view)))));

        api.MapPost("/instances/{id:guid}/retry", async (Guid id, InstanceService engine, HttpContext http) =>
            await IdempotentAsync(http, new { }, async key =>
                ToResult(await engine.RetryAsync(Actor(http), id, key, http.RequestAborted), view => Versioned(http, view, TypedResults.Ok(view)))));

        api.MapGet("/tasks/{id:guid}", async (Guid id, InstanceService engine, HttpContext http) =>
            ToResult(await engine.GetTaskAsync(Actor(http), id, http.RequestAborted), detail => TypedResults.Ok(detail)));

        api.MapGet("/tasks", async (InstanceService engine, HttpContext http) =>
            TypedResults.Ok(await engine.GetInboxAsync(Actor(http), http.RequestAborted)));

        api.MapPost("/tasks/{id:guid}/start", async (Guid id, InstanceService engine, HttpContext http) =>
            await IdempotentAsync(http, new { }, async key =>
                ToResult(await engine.StartWorkingAsync(Actor(http), id, key, http.RequestAborted), task => TypedResults.Ok(task))));

        api.MapPost("/tasks/{id:guid}/take-over", async (Guid id, InstanceService engine, HttpContext http) =>
            await IdempotentAsync(http, new { }, async key =>
                ToResult(await engine.TakeOverAsync(Actor(http), id, key, http.RequestAborted), task => TypedResults.Ok(task))));

        api.MapPost("/tasks/{id:guid}/complete", async (Guid id, CompleteTaskRequest request, InstanceService engine, HttpContext http) =>
            NotUnicode(request.Data, SubmissionProblem) ?? await IdempotentAsync(http, request, async key =>
                ToResult(await engine.CompleteAsync(Actor(http), id, request.Comment, request.Data, key, http.RequestAborted), view => Versioned(http, view, TypedResults.Ok(view)))));

        api.MapPost("/tasks/{id:guid}/decide", async (Guid id, DecideTaskRequest request, InstanceService engine, HttpContext http) =>
            request.Outcome is not { } outcome
                ? Problems.ValidationFailed("outcome_required")
                : await IdempotentAsync(http, request, async key =>
                    ToResult(await engine.DecideAsync(Actor(http), id, outcome, request.Justification, key, http.RequestAborted), view => Versioned(http, view, TypedResults.Ok(view)))));

        return routes;
    }

    private static Guid Actor(HttpContext http) => http.User.ToCaller().UserId;

    /// <summary>Sends the instance version as the <c>ETag</c>, for <c>If-Match</c> on data correction (workflow-engine.md §16).</summary>
    private static IResult Versioned(HttpContext http, InstanceView view, IResult result)
    {
        http.Response.Headers.ETag = ETags.Format(view.Version);
        return result;
    }

    /// <summary>Requires <c>Idempotency-Key</c> and hashes method, path and body (ADR-0008 §4).</summary>
    private static async Task<IResult> IdempotentAsync<TBody>(HttpContext http, TBody body, Func<Idempotency, Task<IResult>> action)
    {
        var key = http.Request.Headers["Idempotency-Key"].ToString().Trim();
        if (key.Length == 0)
        {
            return Problems.Create(StatusCodes.Status400BadRequest, "idempotency_key_required", "The Idempotency-Key header is required.");
        }

        if (key.Length > MaxIdempotencyKeyLength)
        {
            return Problems.ValidationFailed("idempotency_key_too_long");
        }

        var fingerprint = $"{http.Request.Method} {http.Request.Path}\n{JsonSerializer.Serialize(body)}";
        var hash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(fingerprint)));
        return await action(new Idempotency(key, hash));
    }

    private static bool TryParseStatus(string text, out InstanceStatus? status)
    {
        var parsed = Enum.TryParse<InstanceStatus>(text, ignoreCase: true, out var value) && text.All(char.IsLetter);
        status = parsed ? value : null;
        return parsed;
    }

    /// <summary>
    /// Free-form JSON whose text is not Unicode, such as an unpaired surrogate (<c>\ud800</c>), can't be fingerprinted, validated
    /// or stored. It gets <paramref name="problem"/> with <c>invalid_value</c> at the empty key before anything else, and the answer
    /// is not stored for replay (workflow-engine.md §13.1, card #129). Null when the text is Unicode.
    /// </summary>
    private static IResult? NotUnicode(JsonElement? json, Func<IReadOnlyList<FieldErrorView>, IResult> problem) =>
        json is { } element && !ClientText.IsUnicode(element) ? problem([new FieldErrorView(string.Empty, "invalid_value")]) : null;

    private static Microsoft.AspNetCore.Http.HttpResults.ProblemHttpResult SubmissionProblem(IReadOnlyList<FieldErrorView> errors) =>
        FieldProblem("submission_invalid", "The submitted data is invalid.", errors);

    private static Microsoft.AspNetCore.Http.HttpResults.ProblemHttpResult CorrectionProblem(IReadOnlyList<FieldErrorView> errors) =>
        FieldProblem("correction_invalid", "The corrected data is invalid.", errors);

    /// <summary>422 with per-key findings <c>errors: [{ key, code }]</c> (forms.md §F1, workflow-engine.md §16.3).</summary>
    private static Microsoft.AspNetCore.Http.HttpResults.ProblemHttpResult FieldProblem(string code, string title, IReadOnlyList<FieldErrorView> errors)
    {
        var problem = new Microsoft.AspNetCore.Mvc.ProblemDetails { Status = StatusCodes.Status422UnprocessableEntity, Title = title };
        problem.Extensions["code"] = code;
        problem.Extensions["errors"] = errors.Select(e => new { key = e.Key, code = e.Code }).ToList();
        return TypedResults.Problem(problem);
    }

    private static IResult ToResult<T>(EngineResult<T> result, Func<T, IResult> onSuccess) => result.Error switch
    {
        null => onSuccess(result.Value!),
        EngineError.NotFound => Problems.Create(StatusCodes.Status404NotFound, "not_found", "The resource does not exist."),
        EngineError.Forbidden => Problems.Create(StatusCodes.Status403Forbidden, "forbidden", "The action is not allowed."),
        EngineError.ValidationFailed => Problems.ValidationFailed([.. result.Details]),
        EngineError.WorkflowNotStartable => Problems.Create(StatusCodes.Status409Conflict, "workflow_not_startable", "The workflow is inactive or has no published version."),
        EngineError.TaskNotOpen => Problems.Create(StatusCodes.Status409Conflict, "task_not_open", "The task is no longer open."),
        EngineError.TaskAssigned => Problems.Create(StatusCodes.Status409Conflict, "task_assigned", "Someone else is working on this task; take it over first."),
        EngineError.WrongTaskKind => Problems.Create(StatusCodes.Status409Conflict, "wrong_task_kind", "Use complete for tasks and decide for decisions."),
        EngineError.InstanceNotRunning => Problems.Create(StatusCodes.Status409Conflict, "instance_not_running", "The request is no longer running."),
        EngineError.SubmissionInvalid => SubmissionProblem(result.FieldErrors ?? []),
        EngineError.RetryFailed => Problems.Create(StatusCodes.Status409Conflict, "retry_failed", "The step failed again.", result.Details),
        EngineError.InstanceNotFaulted => Problems.Create(StatusCodes.Status409Conflict, "instance_not_faulted", "Only faulted requests can be retried or corrected."),
        EngineError.VersionMismatch => ETags.VersionMismatch(),
        EngineError.CorrectionInvalid => CorrectionProblem(result.FieldErrors ?? []),
        EngineError.FileInvalid => Problems.Create(StatusCodes.Status422UnprocessableEntity, "file_invalid", "The file is unknown, already used, or was uploaded by someone else."),
        EngineError.IdempotencyKeyReused => Problems.Create(StatusCodes.Status422UnprocessableEntity, "idempotency_key_reused", "The Idempotency-Key was already used for a different request."),
        _ => throw new ArgumentOutOfRangeException(nameof(result)),
    };
}
