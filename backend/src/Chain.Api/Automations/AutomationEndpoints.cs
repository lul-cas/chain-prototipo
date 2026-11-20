using Chain.Api.Admin;
using Chain.Api.Auth;
using Chain.Api.Http;
using Chain.Automations;
using Chain.Automations.Application;
using Microsoft.AspNetCore.Mvc;

namespace Chain.Api.Automations;

internal sealed record DestinationRequest(
    string? Name, string? Description, string? Scheme, string? Host, int? Port, string? PathPrefix, bool? Internal, bool? AllowSecretsOverHttp,
    long? MaxRequestBytes, long? MaxResponseBytes)
{
    public DestinationSettings Settings =>
        new(Description, Scheme, Host, Port, PathPrefix, Internal ?? false, AllowSecretsOverHttp ?? false, MaxRequestBytes, MaxResponseBytes);
}

internal sealed record CreateSecretRequest(string? Name, string? Description, string? Value, string[]? AllowedDestinations);

internal sealed record UpdateSecretRequest(string? Description, string[]? AllowedDestinations);

internal sealed record SecretValueRequest(string? Value);

/// <summary>
/// Destinations and secrets of automations (automation.md §3.2, §4.2, §4.3). Secret values are write-only: no response carries
/// them, and request bodies are never logged (ASP.NET Core does not log bodies, and no HTTP logging middleware is configured).
/// </summary>
internal static class AutomationEndpoints
{
    public static IEndpointRouteBuilder MapAutomationEndpoints(this IEndpointRouteBuilder routes)
    {
        var destinations = routes.MapGroup("/api/admin/automation/destinations").RequireAuthorization(AdminEndpoints.AdminPolicy);
        destinations.MapGet("/", async (AutomationAdminService automations, HttpContext http) =>
            TypedResults.Ok(await automations.ListDestinationsAsync(http.RequestAborted)));
        destinations.MapPost("/", async (DestinationRequest request, AutomationAdminService automations, HttpContext http) =>
            ToResult(await automations.CreateDestinationAsync(Actor(http), request.Name, request.Settings, http.RequestAborted), view =>
            {
                http.Response.Headers.ETag = ETags.Format(view.Version);
                return TypedResults.Created($"/api/admin/automation/destinations/{view.Name}", view);
            }));
        destinations.MapGet("/{name}", async (string name, AutomationAdminService automations, HttpContext http) =>
            Versioned(http, await automations.GetDestinationAsync(name, http.RequestAborted), view => view.Version));
        destinations.MapPut("/{name}", async (string name, bool? force, DestinationRequest request, AutomationAdminService automations, HttpContext http) =>
            await WithVersionAsync(http, version => automations.UpdateDestinationAsync(Actor(http), name, version, request.Settings, force ?? false, http.RequestAborted),
                view => view.Version));
        destinations.MapDelete("/{name}", async (string name, bool? force, AutomationAdminService automations, HttpContext http) =>
            ToResult(await automations.DeleteDestinationAsync(Actor(http), name, force ?? false, http.RequestAborted), _ => TypedResults.NoContent()));

        var secrets = routes.MapGroup("/api/admin/automation/secrets").RequireAuthorization(AdminEndpoints.AdminPolicy);
        secrets.MapGet("/", async (AutomationAdminService automations, HttpContext http) =>
            TypedResults.Ok(await automations.ListSecretsAsync(http.RequestAborted)));
        secrets.MapPost("/", async (CreateSecretRequest request, AutomationAdminService automations, HttpContext http) =>
            ToResult(await automations.CreateSecretAsync(Actor(http), request.Name, request.Description, request.Value, request.AllowedDestinations, http.RequestAborted),
                view =>
                {
                    http.Response.Headers.ETag = ETags.Format(view.RowVersion);
                    return TypedResults.Created($"/api/admin/automation/secrets/{view.Name}", view);
                }));
        secrets.MapGet("/{name}", async (string name, AutomationAdminService automations, HttpContext http) =>
            Versioned(http, await automations.GetSecretAsync(name, http.RequestAborted), view => view.RowVersion));
        secrets.MapPatch("/{name}", async (string name, bool? force, UpdateSecretRequest request, AutomationAdminService automations, HttpContext http) =>
            await WithVersionAsync(http, version => automations.UpdateSecretAsync(Actor(http), name, version, request.Description, request.AllowedDestinations, force ?? false, http.RequestAborted),
                view => view.RowVersion));
        secrets.MapPut("/{name}/value", async (string name, SecretValueRequest request, AutomationAdminService automations, HttpContext http) =>
            await WithVersionAsync(http, version => automations.RotateSecretAsync(Actor(http), name, version, request.Value, http.RequestAborted),
                view => view.RowVersion));
        secrets.MapDelete("/{name}", async (string name, bool? force, AutomationAdminService automations, HttpContext http) =>
            ToResult(await automations.DeleteSecretAsync(Actor(http), name, force ?? false, http.RequestAborted), _ => TypedResults.NoContent()));

        routes.MapGet("/api/automations/resources", async (AutomationAdminService automations, HttpContext http) =>
            ToResult(await automations.GetResourcesAsync(Actor(http), http.RequestAborted), resources => TypedResults.Ok(resources)))
            .RequireAuthorization();

        return routes.MapAutomationDefinitionEndpoints();
    }

    private static Guid Actor(HttpContext http) => http.User.ToCaller().UserId;

    internal static IResult ToResult<T>(AutomationResult<T> result, Func<T, IResult> onSuccess) =>
        result.IsSuccess ? onSuccess(result.Value!) : ToProblem(result);

    /// <summary>Returns the value with an <c>ETag</c> of its row version (ADR-0008 §3).</summary>
    private static IResult Versioned<T>(HttpContext http, AutomationResult<T> result, Func<T, uint> version) =>
        ToResult(result, value =>
        {
            http.Response.Headers.ETag = ETags.Format(version(value));
            return TypedResults.Ok(value);
        });

    /// <summary>Requires <c>If-Match</c>: missing → 428, unparsable or stale → 412.</summary>
    private static async Task<IResult> WithVersionAsync<T>(HttpContext http, Func<uint, Task<AutomationResult<T>>> update, Func<T, uint> version) =>
        ETags.ReadIfMatch(http, out var problem) is { } expected ? Versioned(http, await update(expected), version) : problem!;

    private static IResult ToProblem<T>(AutomationResult<T> result) => result.Error switch
    {
        AutomationError.NotFound => Problems.Create(StatusCodes.Status404NotFound, "not_found", "The resource does not exist."),
        AutomationError.Forbidden => Problems.Create(StatusCodes.Status403Forbidden, "forbidden", "The action is not allowed."),
        AutomationError.ValidationFailed => Problems.ValidationFailed([.. result.Details]),
        AutomationError.DestinationNameTaken => Problems.Create(StatusCodes.Status409Conflict, "destination_name_taken", "A destination with this name already exists."),
        AutomationError.SecretNameTaken => Problems.Create(StatusCodes.Status409Conflict, "secret_name_taken", "A secret with this name already exists."),
        AutomationError.UnknownDestination => Problems.Create(StatusCodes.Status422UnprocessableEntity, "unknown_destination", "An allowed destination does not exist.", result.Details),
        AutomationError.DestinationInUse => InUse(result.Usage!, "destination_in_use", "Secrets or published automations use this destination; delete with force=true to remove it anyway.", withSecrets: true),
        AutomationError.DestinationChangeBreaksVersions => InUse(result.Usage!, "destination_in_use", "Published automation versions would fail with this change; save with force=true to make it anyway.", withSecrets: false),
        AutomationError.SecretInUse => InUse(result.Usage!, "secret_in_use", "Published automations use this secret; delete with force=true to remove it anyway.", withSecrets: false),
        AutomationError.SecretChangeBreaksVersions => InUse(result.Usage!, "secret_in_use", "Published automation versions would fail with this change; save with force=true to make it anyway.", withSecrets: false),
        AutomationError.SecretsUnavailable => Problems.Create(StatusCodes.Status503ServiceUnavailable, "secrets_unavailable", "No active key-encryption key is configured."),
        AutomationError.VersionMismatch => ETags.VersionMismatch(),
        AutomationError.AutomationNameTaken => Problems.Create(StatusCodes.Status409Conflict, "automation_name_taken", "An automation with this name already exists."),
        AutomationError.InvalidDocument => Issues(StatusCodes.Status400BadRequest, "invalid_document", "The document is not a valid automation document.", result.Issues),
        AutomationError.AutomationValidationFailed => Issues(StatusCodes.Status422UnprocessableEntity, "automation_validation_failed", "The draft cannot be published.", result.Issues),
        _ => throw new ArgumentOutOfRangeException(nameof(result)),
    };

    /// <summary>
    /// A 409 naming what still uses a destination (secrets and automations) or a secret (automations). For a refused change of a
    /// destination or a secret it also lists the versions the change would break, with the rules each would fail (automation.md
    /// §3.2, §4.2).
    /// </summary>
    private static Microsoft.AspNetCore.Http.HttpResults.ProblemHttpResult InUse(AutomationUsage usage, string code, string title, bool withSecrets)
    {
        var problem = new ProblemDetails { Status = StatusCodes.Status409Conflict, Title = title };
        problem.Extensions["code"] = code;
        if (withSecrets)
        {
            problem.Extensions["secrets"] = usage.Secrets;
        }

        problem.Extensions["automations"] = usage.Automations;
        if (usage.Versions.Count > 0)
        {
            problem.Extensions["versions"] = usage.Versions.Select(v => new
            {
                automation = v.Automation,
                version = v.Version,
                errors = v.Errors.Select(i => new { code = i.Code, message = i.Message, path = i.Path }).ToList(),
            }).ToList();
        }

        return TypedResults.Problem(problem);
    }

    private static Microsoft.AspNetCore.Http.HttpResults.ProblemHttpResult Issues(int status, string code, string title, IReadOnlyList<AutomationIssue> issues)
    {
        var problem = new ProblemDetails { Status = status, Title = title };
        problem.Extensions["code"] = code;
        problem.Extensions["errors"] = issues.Select(i => new { code = i.Code, message = i.Message, path = i.Path }).ToList();
        return TypedResults.Problem(problem);
    }
}
