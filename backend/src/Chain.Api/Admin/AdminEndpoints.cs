using Chain.Api.Auth;
using Chain.Api.Http;
using Chain.Identity.Application;

namespace Chain.Api.Admin;

internal sealed record CreateUserRequest(string? Username, string? DisplayName, bool IsAdmin);

internal sealed record UpdateUserRequest(string? DisplayName, bool? IsAdmin);

internal sealed record CreateGroupRequest(string? Name, string? Description);

internal sealed record UpdateGroupRequest(string? Name, string? Description);

/// <summary>Admin user management and groups (identity increment I2, specs/modules/identity.md).</summary>
internal static class AdminEndpoints
{
    public const string AdminPolicy = "Admin";

    public static IEndpointRouteBuilder MapAdminEndpoints(this IEndpointRouteBuilder routes)
    {
        var users = routes.MapGroup("/api/admin/users").RequireAuthorization(AdminPolicy);
        users.MapGet("/", async (string? search, int? limit, int? offset, AdministrationService admin, HttpContext http) =>
            TypedResults.Ok(await admin.ListUsersAsync(search, limit ?? 50, offset ?? 0, http.RequestAborted)));
        users.MapPost("/", async (CreateUserRequest request, AdministrationService admin, HttpContext http) =>
            ToResult(await admin.CreateUserAsync(Actor(http), request.Username, request.DisplayName, request.IsAdmin, http.RequestAborted),
                created => TypedResults.Created($"/api/admin/users/{created.User.Id}", created)));
        users.MapGet("/{id:guid}", async (Guid id, AdministrationService admin, HttpContext http) =>
            Versioned(http, await admin.GetUserAsync(id, http.RequestAborted), user => user.Version));
        users.MapPatch("/{id:guid}", async (Guid id, UpdateUserRequest request, AdministrationService admin, HttpContext http) =>
            await WithVersionAsync(http, version => admin.UpdateUserAsync(Actor(http), id, version, request.DisplayName, request.IsAdmin, http.RequestAborted),
                user => user.Version));
        users.MapPost("/{id:guid}/deactivate", async (Guid id, AdministrationService admin, HttpContext http) =>
            NoContent(await admin.DeactivateUserAsync(Actor(http), id, http.RequestAborted)));
        users.MapPost("/{id:guid}/activate", async (Guid id, AdministrationService admin, HttpContext http) =>
            NoContent(await admin.ActivateUserAsync(Actor(http), id, http.RequestAborted)));
        users.MapPost("/{id:guid}/unlock", async (Guid id, AdministrationService admin, HttpContext http) =>
            NoContent(await admin.UnlockUserAsync(Actor(http), id, http.RequestAborted)));
        users.MapPost("/{id:guid}/reset-password", async (Guid id, AdministrationService admin, HttpContext http) =>
            ToResult(await admin.ResetPasswordAsync(Actor(http), id, http.RequestAborted),
                password => TypedResults.Ok(new { temporaryPassword = password })));

        var groups = routes.MapGroup("/api/admin/groups").RequireAuthorization(AdminPolicy);
        groups.MapGet("/", async (bool? includeArchived, AdministrationService admin, HttpContext http) =>
            TypedResults.Ok(await admin.ListGroupsAsync(includeArchived ?? false, http.RequestAborted)));
        groups.MapPost("/", async (CreateGroupRequest request, AdministrationService admin, HttpContext http) =>
            ToResult(await admin.CreateGroupAsync(Actor(http), request.Name, request.Description, http.RequestAborted),
                group => TypedResults.Created($"/api/admin/groups/{group.Id}", group)));
        groups.MapGet("/{id:guid}", async (Guid id, AdministrationService admin, HttpContext http) =>
            Versioned(http, await admin.GetGroupAsync(id, http.RequestAborted), group => group.Version));
        groups.MapPatch("/{id:guid}", async (Guid id, UpdateGroupRequest request, AdministrationService admin, HttpContext http) =>
            await WithVersionAsync(http, version => admin.UpdateGroupAsync(Actor(http), id, version, request.Name, request.Description, http.RequestAborted),
                group => group.Version));
        groups.MapPost("/{id:guid}/archive", async (Guid id, AdministrationService admin, HttpContext http) =>
            NoContent(await admin.ArchiveGroupAsync(Actor(http), id, archived: true, http.RequestAborted)));
        groups.MapPost("/{id:guid}/unarchive", async (Guid id, AdministrationService admin, HttpContext http) =>
            NoContent(await admin.ArchiveGroupAsync(Actor(http), id, archived: false, http.RequestAborted)));
        groups.MapPut("/{id:guid}/modeler", async (Guid id, AdministrationService admin, HttpContext http) =>
            NoContent(await admin.SetModelerAsync(Actor(http), id, granted: true, http.RequestAborted)));
        groups.MapDelete("/{id:guid}/modeler", async (Guid id, AdministrationService admin, HttpContext http) =>
            NoContent(await admin.SetModelerAsync(Actor(http), id, granted: false, http.RequestAborted)));
        groups.MapPut("/{id:guid}/members/{userId:guid}", async (Guid id, Guid userId, AdministrationService admin, HttpContext http) =>
            NoContent(await admin.AddMemberAsync(Actor(http), id, userId, http.RequestAborted)));
        groups.MapDelete("/{id:guid}/members/{userId:guid}", async (Guid id, Guid userId, AdministrationService admin, HttpContext http) =>
            NoContent(await admin.RemoveMemberAsync(Actor(http), id, userId, http.RequestAborted)));

        return routes;
    }

    private static Guid Actor(HttpContext http) => http.User.ToCaller().UserId;

    internal static IResult NoContent(AdminResult<bool> result) => ToResult(result, _ => TypedResults.NoContent());

    internal static IResult ToResult<T>(AdminResult<T> result, Func<T, IResult> onSuccess) =>
        result.IsSuccess ? onSuccess(result.Value!) : ToProblem(result.Error!.Value, result.Details);

    /// <summary>Returns the value with an <c>ETag</c> of its version (ADR-0008 §3).</summary>
    internal static IResult Versioned<T>(HttpContext http, AdminResult<T> result, Func<T, uint> version) =>
        ToResult(result, value =>
        {
            http.Response.Headers.ETag = ETags.Format(version(value));
            return TypedResults.Ok(value);
        });

    /// <summary>Requires <c>If-Match</c>: missing → 428, unparsable or stale → 412.</summary>
    internal static async Task<IResult> WithVersionAsync<T>(HttpContext http, Func<uint, Task<AdminResult<T>>> update, Func<T, uint> version) =>
        ETags.ReadIfMatch(http, out var problem) is { } expected ? Versioned(http, await update(expected), version) : problem!;

    private static IResult ToProblem(AdminError error, IReadOnlyList<string> details) => error switch
    {
        AdminError.NotFound => Problems.Create(StatusCodes.Status404NotFound, "not_found", "The resource does not exist."),
        AdminError.ValidationFailed => Problems.ValidationFailed([.. details]),
        AdminError.UsernameTaken => Problems.Create(StatusCodes.Status409Conflict, "username_taken", "The username is already in use."),
        AdminError.GroupNameTaken => Problems.Create(StatusCodes.Status409Conflict, "group_name_taken", "A group with this name already exists."),
        AdminError.LastAdmin => Problems.Create(StatusCodes.Status409Conflict, "last_admin", "At least one active admin must remain."),
        AdminError.TokenLimitReached => Problems.Create(StatusCodes.Status409Conflict, "token_limit_reached", "The bot already has the maximum number of active tokens."),
        AdminError.CannotDeactivateSelf => Problems.Create(StatusCodes.Status409Conflict, "cannot_deactivate_self", "Admins cannot deactivate their own account."),
        AdminError.GroupArchived => Problems.Create(StatusCodes.Status409Conflict, "group_archived", "Archived groups cannot gain members."),
        AdminError.VersionMismatch => ETags.VersionMismatch(),
        _ => throw new ArgumentOutOfRangeException(nameof(error)),
    };
}
