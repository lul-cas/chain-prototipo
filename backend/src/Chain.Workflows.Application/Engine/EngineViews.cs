using System.Text.Json;

namespace Chain.Workflows.Application.Engine;

public enum EngineError
{
    NotFound,
    Forbidden,
    ValidationFailed,
    WorkflowNotStartable,
    TaskNotOpen,
    TaskAssigned,
    WrongTaskKind,
    InstanceNotRunning,
    IdempotencyKeyReused,
    SubmissionInvalid,
    RetryFailed,
    InstanceNotFaulted,
    FileInvalid,
    VersionMismatch,
    CorrectionInvalid,
}

/// <summary>A form submission error for the field at <see cref="Key"/> (forms.md §F1).</summary>
public sealed record FieldErrorView(string Key, string Code);

/// <summary>Outcome of an engine use case. Serializable, so idempotent replays return the stored outcome (ADR-0008 §4).</summary>
public sealed record EngineResult<T>(T? Value, EngineError? Error, IReadOnlyList<string> Details, IReadOnlyList<FieldErrorView>? FieldErrors = null)
{
    public bool IsSuccess => Error is null;
}

public static class EngineResult
{
    public static EngineResult<T> Ok<T>(T value) => new(value, null, []);

    public static EngineResult<T> Fail<T>(EngineError error, params string[] details) => new(default, error, details);

    public static EngineResult<T> InvalidSubmission<T>(IEnumerable<FieldErrorView> errors) => new(default, EngineError.SubmissionInvalid, [], [.. errors]);

    public static EngineResult<T> InvalidCorrection<T>(IEnumerable<FieldErrorView> errors) => new(default, EngineError.CorrectionInvalid, [], [.. errors]);
}

public sealed record ActorRef(Guid Id, string Username, string DisplayName);

public sealed record GroupInfo(Guid Id, string Name);

public sealed record TaskView(
    Guid Id, Guid InstanceId, string NodeId, string Label, string Kind, string? Question, GroupInfo? Group, ActorRef? Assignee, DateTimeOffset CreatedAt);

/// <summary>A timeline event; <see cref="Channel"/> is the way in of the request that recorded it (workflow-engine.md §8).</summary>
public sealed record EventView(string Type, DateTimeOffset OccurredAt, ActorRef? Actor, GroupInfo? ActedAsGroup, Guid? TaskId, JsonElement Details, string? Channel);

/// <param name="Message">As recorded; null for a caller who may not see the request's sensitive values, since it can quote one (sensitive-data.md §5).</param>
public sealed record IncidentView(Guid Id, string NodeId, string Code, string? Message, DateTimeOffset CreatedAt, DateTimeOffset? ResolvedAt, string? Resolution);

/// <summary>An instance as its viewers see it. <see cref="Version"/> is the instance record's version (<c>xmin</c>), sent as its ETag (ADR-0008 §3).</summary>
public sealed record InstanceView(
    Guid Id, Guid DefinitionId, string DefinitionName, int VersionNumber, string Status, string CurrentNodeId,
    ActorRef Requester, DateTimeOffset StartedAt, DateTimeOffset? EndedAt,
    IReadOnlyList<TaskView> OpenTasks, IReadOnlyList<ActorRef> Participants, IReadOnlyList<EventView> Timeline,
    JsonElement Data, IReadOnlyList<IncidentView> Incidents, ParentView? Parent, IReadOnlyList<ChildView> Children, uint Version)
{
    /// <summary>The sensitive keys left out of <see cref="Data"/> for this caller, sorted (sensitive-data.md §5, card #53).</summary>
    public IReadOnlyList<string> MaskedKeys { get; init; } = [];
}

/// <summary>The instance and step that started a child (workflow-engine.md §14.3).</summary>
public sealed record ParentView(Guid Id, string NodeId);

public sealed record ChildView(Guid Id, string NodeId, string DefinitionName, string Status);

public sealed record TaskFormView(Guid FormId, int Version, JsonElement Document);

/// <summary>A task with its pinned form and the prefill from the instance's current data (workflow-engine.md §13.1).</summary>
public sealed record TaskDetail(TaskView Task, TaskFormView? Form, JsonElement Prefill)
{
    /// <summary>The sensitive keys left out of <see cref="Prefill"/> for this caller, sorted (sensitive-data.md §5, card #53).</summary>
    public IReadOnlyList<string> MaskedKeys { get; init; } = [];
}

public sealed record InstanceSummary(
    Guid Id, Guid DefinitionId, string DefinitionName, int VersionNumber, string Status, ActorRef Requester, DateTimeOffset StartedAt, DateTimeOffset? EndedAt);

/// <summary>An inbox card: the task plus the request it belongs to.</summary>
public sealed record InboxItem(
    Guid Id, Guid InstanceId, string NodeId, string Label, string Kind, string? Question, GroupInfo? Group, ActorRef? Assignee,
    DateTimeOffset CreatedAt, string DefinitionName, ActorRef Requester);

public sealed record InboxView(IReadOnlyList<InboxItem> AssignedToMe, IReadOnlyList<InboxItem> Unassigned, IReadOnlyList<InboxItem> AssignedToOthers);

public sealed record StartableWorkflow(Guid Id, string Name, string? Description, int LatestVersion);

/// <summary>The start form pinned by <see cref="VersionNumber"/>, the workflow's latest version; null when the start node has no form.</summary>
public sealed record StartFormView(Guid WorkflowId, int VersionNumber, TaskFormView? Form);

/// <summary>A command's idempotency context: the client's key and a hash of the request (ADR-0008 §4).</summary>
public sealed record Idempotency(string Key, string RequestHash);
