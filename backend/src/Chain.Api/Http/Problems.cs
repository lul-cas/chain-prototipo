using Microsoft.AspNetCore.Mvc;

namespace Chain.Api.Http;

/// <summary>RFC 9457 problem responses with a machine-readable <c>code</c> extension.</summary>
internal static class Problems
{
    public static IResult Create(int status, string code, string title, IReadOnlyList<string>? errors = null)
    {
        var problem = new ProblemDetails { Status = status, Title = title };
        problem.Extensions["code"] = code;
        if (errors is { Count: > 0 })
        {
            problem.Extensions["errors"] = errors;
        }

        return TypedResults.Problem(problem);
    }

    /// <summary>A problem carrying validation findings (<c>code</c>, <c>message</c>, <c>elementId</c>) for the editor.</summary>
    public static IResult WithFindings(int status, string code, string title, IReadOnlyList<Chain.Workflows.Definitions.ValidationError> findings)
    {
        var problem = new ProblemDetails { Status = status, Title = title };
        problem.Extensions["code"] = code;
        problem.Extensions["errors"] = findings.Select(f => new { code = f.Code, message = f.Message, elementId = f.ElementId }).ToList();
        return TypedResults.Problem(problem);
    }

    public static IResult ValidationFailed(params string[] errors) =>
        Create(StatusCodes.Status400BadRequest, "validation_failed", "The request is invalid.", errors);

    public static Task WriteAsync(HttpContext context, int status, string code, string title, string? detail = null)
    {
        var problem = new ProblemDetails { Status = status, Title = title, Detail = detail };
        problem.Extensions["code"] = code;
        return TypedResults.Problem(problem).ExecuteAsync(context);
    }

    /// <summary>A request the endpoint cannot read: 400 <c>validation_failed</c>, with what is wrong as the detail (card #180).</summary>
    public static Task WriteUnreadableAsync(HttpContext context, string detail) =>
        WriteAsync(context, StatusCodes.Status400BadRequest, "validation_failed", "The request is invalid.", detail);
}
