using System.Text.Json;
using System.Text.Json.Nodes;
using Chain.Workflows.Application.Engine;
using ModelContextProtocol.Protocol;

namespace Chain.Mcp;

/// <summary>
/// Tool results (mcp.md §2–§3). Every result carries <c>structuredContent</c> and the same JSON as one text block. Failures are
/// tool execution errors with the HTTP API's codes, so a model can correct its input and retry.
/// </summary>
internal static class ToolResults
{
    /// <summary>The HTTP API's JSON shape: web defaults, camelCase.</summary>
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static CallToolResult Ok(object value) => Result(JsonSerializer.SerializeToElement(value, Json), isError: false);

    public static CallToolResult From<T>(EngineResult<T> result) => result.Error switch
    {
        null => Ok(result.Value!),
        { } error => Failure(error, result.Details, result.FieldErrors),
    };

    public static CallToolResult Error(
        string code, string message, IReadOnlyList<string>? details = null, IReadOnlyList<FieldErrorView>? fieldErrors = null, int? retryAfterSeconds = null)
    {
        var error = new JsonObject { ["code"] = code, ["message"] = message };
        if (details is { Count: > 0 })
        {
            error["details"] = new JsonArray([.. details.Select(detail => JsonValue.Create(detail))]);
        }

        if (fieldErrors is { Count: > 0 })
        {
            error["fieldErrors"] = new JsonArray([.. fieldErrors.Select(field => new JsonObject { ["key"] = field.Key, ["code"] = field.Code })]);
        }

        if (retryAfterSeconds is { } seconds)
        {
            error["retryAfterSeconds"] = seconds;
        }

        return Result(JsonSerializer.SerializeToElement(error, Json), isError: true);
    }

    /// <summary>The same code and message as the HTTP API's problem for each engine error (InstanceEndpoints).</summary>
    private static CallToolResult Failure(EngineError error, IReadOnlyList<string> details, IReadOnlyList<FieldErrorView>? fieldErrors) => error switch
    {
        EngineError.NotFound => Error("not_found", "The resource does not exist."),
        EngineError.Forbidden => Error("forbidden", "The action is not allowed."),
        EngineError.ValidationFailed => Error("validation_failed", "The request is invalid.", details),
        EngineError.WorkflowNotStartable => Error("workflow_not_startable", "The workflow is inactive or has no published version."),
        EngineError.TaskNotOpen => Error("task_not_open", "The task is no longer open."),
        EngineError.TaskAssigned => Error("task_assigned", "Someone else is working on this task; take it over first."),
        EngineError.WrongTaskKind => Error("wrong_task_kind", "Use complete_task for tasks and decide_task for decisions."),
        EngineError.InstanceNotRunning => Error("instance_not_running", "The request is no longer running."),
        EngineError.SubmissionInvalid => Error("submission_invalid", "The submitted data is invalid.", fieldErrors: fieldErrors ?? []),
        EngineError.RetryFailed => Error("retry_failed", "The step failed again.", details),
        EngineError.InstanceNotFaulted => Error("instance_not_faulted", "Only faulted requests can be retried."),
        EngineError.FileInvalid => Error("file_invalid", "The file is unknown, already used, or was uploaded by someone else."),
        EngineError.IdempotencyKeyReused => Error("idempotency_key_reused", "The idempotencyKey was already used for a different call."),
        _ => throw new ArgumentOutOfRangeException(nameof(error), error, "Unmapped engine error."),
    };

    private static CallToolResult Result(JsonElement content, bool isError) => new()
    {
        Content = [new TextContentBlock { Text = content.GetRawText() }],
        StructuredContent = content,
        IsError = isError ? true : null,
    };
}
