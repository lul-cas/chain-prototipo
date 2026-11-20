using System.Text.Json;
using System.Text.Json.Nodes;

namespace Chain.Workflows.Runtime;

public enum InstanceStatus { Running, Completed, Cancelled, Faulted }

/// <summary>One request: a running copy of a pinned workflow version (workflow-engine.md §2).</summary>
public sealed class Instance
{
    public const int MaxJustificationLength = 1000;

    private Instance()
    {
    }

    public Guid Id { get; private set; }
    public Guid DefinitionId { get; private set; }
    public string DefinitionName { get; private set; } = string.Empty;
    public int VersionNumber { get; private set; }
    public Guid RequesterId { get; private set; }
    public InstanceStatus Status { get; private set; }
    public string CurrentNodeId { get; private set; } = string.Empty;
    public string Data { get; private set; } = "{}";
    public DateTimeOffset StartedAt { get; private set; }
    public DateTimeOffset? EndedAt { get; private set; }

    /// <summary>Number of timeline events recorded so far; gives each event its position.</summary>
    public int EventCount { get; private set; }

    /// <summary>The instance that started this one at its sub-workflow step (workflow-engine.md §14).</summary>
    public Guid? ParentInstanceId { get; private set; }

    public string? ParentNodeId { get; private set; }

    /// <summary>0 for a request started directly; parent depth + 1 for a child.</summary>
    public int Depth { get; private set; }

    /// <summary>The child this instance waits for at its current sub-workflow step, if any.</summary>
    public Guid? ChildInstanceId { get; private set; }

    public bool IsRunning => Status == InstanceStatus.Running;

    /// <summary>The position of the next timeline event (1, 2, 3…). Timestamps alone can tie.</summary>
    public int NextEventSequence() => ++EventCount;

    public static Instance Start(Guid definitionId, string definitionName, int versionNumber, Guid requesterId, string startNodeId, DateTimeOffset now) => new()
    {
        Id = Guid.CreateVersion7(now),
        DefinitionId = definitionId,
        DefinitionName = definitionName,
        VersionNumber = versionNumber,
        RequesterId = requesterId,
        Status = InstanceStatus.Running,
        CurrentNodeId = startNodeId,
        StartedAt = now,
    };

    /// <summary>Starts a child of <paramref name="parent"/> at its step <paramref name="parentNodeId"/>; the requester is the parent's (S-1).</summary>
    public static Instance StartChild(
        Instance parent, string parentNodeId, Guid definitionId, string definitionName, int versionNumber, string startNodeId, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(parent);
        var child = Start(definitionId, definitionName, versionNumber, parent.RequesterId, startNodeId, now);
        child.ParentInstanceId = parent.Id;
        child.ParentNodeId = parentNodeId;
        child.Depth = parent.Depth + 1;
        return child;
    }

    /// <summary>Waits at the current sub-workflow step for <paramref name="childId"/>.</summary>
    public void WaitFor(Guid childId)
    {
        EnsureRunning();
        ChildInstanceId = childId;
    }

    /// <summary>The awaited child completed or was cancelled; the step no longer waits for it.</summary>
    public void ReleaseChild() => ChildInstanceId = null;

    public void MoveTo(string nodeId)
    {
        EnsureRunning();
        CurrentNodeId = nodeId;
    }

    public void Complete(DateTimeOffset now)
    {
        EnsureRunning();
        Status = InstanceStatus.Completed;
        EndedAt = now;
    }

    /// <summary>Cancels a running or faulted instance (workflow-engine.md §13.3).</summary>
    public void Cancel(DateTimeOffset now)
    {
        if (Status is not (InstanceStatus.Running or InstanceStatus.Faulted))
        {
            throw new InvalidOperationException($"The instance is {Status}.");
        }

        Status = InstanceStatus.Cancelled;
        EndedAt = now;
    }

    /// <summary>Stops at <paramref name="nodeId"/> after an automatic step failed (§7).</summary>
    public void Fault(string nodeId)
    {
        EnsureRunning();
        CurrentNodeId = nodeId;
        Status = InstanceStatus.Faulted;
    }

    public void Resume()
    {
        if (Status != InstanceStatus.Faulted)
        {
            throw new InvalidOperationException($"The instance is {Status}.");
        }

        Status = InstanceStatus.Running;
    }

    /// <summary>
    /// Merges values into the data at the top level; the last write wins, and null removes the key, as when a form field is
    /// cleared with an empty value (workflow-engine.md §13.1).
    /// </summary>
    public void MergeData(JsonObject values)
    {
        ArgumentNullException.ThrowIfNull(values);
        var data = JsonNode.Parse(Data)!.AsObject();
        foreach (var (key, value) in values)
        {
            if (value is null)
            {
                data.Remove(key);
            }
            else
            {
                data[key] = value.DeepClone();
            }
        }

        Data = data.ToJsonString();
    }

    /// <summary>
    /// Applies an admin data correction at the top level, like a JSON merge patch (workflow-engine.md §16.2): a value replaces
    /// the key as a whole and null removes it. Only a faulted instance, or a completed child of a parent faulted on its outputs
    /// (§16.5), is corrected; the service checks which. The status, step and tasks never change.
    /// </summary>
    public IReadOnlyList<DataChange> CorrectData(IReadOnlyList<KeyValuePair<string, JsonNode?>> changes)
    {
        ArgumentNullException.ThrowIfNull(changes);
        if (Status is not (InstanceStatus.Faulted or InstanceStatus.Completed))
        {
            throw new InvalidOperationException($"The instance is {Status}.");
        }

        var data = JsonNode.Parse(Data)!.AsObject();
        var applied = new List<DataChange>(changes.Count);
        foreach (var (key, value) in changes)
        {
            var before = data[key]?.DeepClone();
            if (value is null)
            {
                data.Remove(key);
            }
            else
            {
                data[key] = value.DeepClone();
            }

            applied.Add(new DataChange(key, before, value?.DeepClone()));
        }

        Data = data.ToJsonString();
        return applied;
    }

    private void EnsureRunning()
    {
        if (!IsRunning)
        {
            throw new InvalidOperationException($"The instance is {Status}.");
        }
    }
}

/// <summary>One key of an admin data correction: its value before and after; null when absent (workflow-engine.md §16.4).</summary>
public sealed record DataChange(string Key, JsonNode? Before, JsonNode? After);

public enum TaskState { Open, Completed, Cancelled }

/// <summary>Work waiting for a person or bot at a wait state; assignment rules per workflow-engine.md §5.1.</summary>
public sealed class InstanceTask
{
    private InstanceTask()
    {
    }

    public Guid Id { get; private set; }
    public Guid InstanceId { get; private set; }
    public string NodeId { get; private set; } = string.Empty;
    public string Label { get; private set; } = string.Empty;
    public TaskKindAtNode Kind { get; private set; }
    public string? Question { get; private set; }

    /// <summary>The lane's group; null when the requester acts.</summary>
    public Guid? GroupId { get; private set; }

    public TaskState Status { get; private set; }
    public Guid? AssigneeId { get; private set; }
    public DateTimeOffset CreatedAt { get; private set; }
    public DateTimeOffset? EndedAt { get; private set; }
    public Guid? CompletedBy { get; private set; }
    public bool? Outcome { get; private set; }

    public bool IsOpen => Status == TaskState.Open;

    public static InstanceTask Create(Guid instanceId, Arrival.Wait wait, DateTimeOffset now) => new()
    {
        Id = Guid.CreateVersion7(now),
        InstanceId = instanceId,
        NodeId = wait.Node.Id,
        Label = wait.Node.Label ?? wait.Node.Id,
        Kind = wait.Kind,
        Question = wait.Kind == TaskKindAtNode.Decision ? wait.Node.Question : null,
        GroupId = wait.GroupId,
        Status = TaskState.Open,
        CreatedAt = now,
    };

    /// <summary>Links <paramref name="actorId"/> as the assignee (start working, take over, or first action).</summary>
    public void AssignTo(Guid actorId)
    {
        EnsureOpen();
        AssigneeId = actorId;
    }

    public void Complete(Guid actorId, DateTimeOffset now) => Finish(actorId, TaskKindAtNode.Task, null, now);

    public void Decide(Guid actorId, bool outcome, DateTimeOffset now) => Finish(actorId, TaskKindAtNode.Decision, outcome, now);

    public void Cancel(DateTimeOffset now)
    {
        EnsureOpen();
        Status = TaskState.Cancelled;
        EndedAt = now;
    }

    private void Finish(Guid actorId, TaskKindAtNode expectedKind, bool? outcome, DateTimeOffset now)
    {
        EnsureOpen();
        if (Kind != expectedKind)
        {
            throw new InvalidOperationException($"Task {Id} is a {Kind}, not a {expectedKind}.");
        }

        if (AssigneeId != actorId)
        {
            throw new InvalidOperationException("Only the assignee can finish the task.");
        }

        Status = TaskState.Completed;
        CompletedBy = actorId;
        Outcome = outcome;
        EndedAt = now;
    }

    private void EnsureOpen()
    {
        if (!IsOpen)
        {
            throw new InvalidOperationException($"Task {Id} is {Status}.");
        }
    }
}

/// <summary>Someone who has been assigned one of the instance's tasks (workflow-engine.md §5.1).</summary>
public sealed class InstanceParticipant
{
    private InstanceParticipant()
    {
    }

    public Guid InstanceId { get; private set; }
    public Guid ActorId { get; private set; }
    public DateTimeOffset FirstAssignedAt { get; private set; }

    public static InstanceParticipant Create(Guid instanceId, Guid actorId, DateTimeOffset now) =>
        new() { InstanceId = instanceId, ActorId = actorId, FirstAssignedAt = now };
}

/// <summary>An append-only timeline entry (workflow-engine.md §8).</summary>
public sealed class InstanceEvent
{
    private InstanceEvent()
    {
    }

    public Guid Id { get; private set; }

    /// <summary>Position in the instance's timeline, assigned by <see cref="Instance.NextEventSequence"/>.</summary>
    public int Sequence { get; private set; }

    public Guid InstanceId { get; private set; }
    public string Type { get; private set; } = string.Empty;
    public Guid? ActorId { get; private set; }
    public Guid? ActedAsGroupId { get; private set; }
    public Guid? TaskId { get; private set; }
    public string Details { get; private set; } = "{}";
    public DateTimeOffset OccurredAt { get; private set; }

    /// <summary>The way in of the request that recorded it: <c>ui</c>, <c>api</c> or <c>mcp</c>; null without a caller (workflow-engine.md §8).</summary>
    public string? Channel { get; private set; }

    public static InstanceEvent Create(
        Instance instance, string type, Guid? actorId, Guid? actedAsGroupId, Guid? taskId,
        IReadOnlyDictionary<string, object?> details, DateTimeOffset now, string? channel) => new()
    {
        Id = Guid.CreateVersion7(now),
        InstanceId = instance.Id,
        Sequence = instance.NextEventSequence(),
        Type = type,
        ActorId = actorId,
        ActedAsGroupId = actedAsGroupId,
        TaskId = taskId,
        Details = JsonSerializer.Serialize(details),
        OccurredAt = now,
        Channel = channel,
    };
}

public enum SubmissionKind { Submission, Correction }

/// <summary>
/// The append-only data history of an instance (FR-023): accepted form submissions (workflow-engine.md §13.1) and admin data
/// corrections (§16.4).
/// </summary>
public sealed class InstanceSubmission
{
    public const int MaxJustificationLength = 2000;

    private InstanceSubmission()
    {
    }

    public Guid Id { get; private set; }
    public Guid InstanceId { get; private set; }
    public SubmissionKind Kind { get; private set; }

    /// <summary>Null for the start form and for corrections.</summary>
    public Guid? TaskId { get; private set; }

    /// <summary>The submitted step, or the step a corrected instance is faulted at.</summary>
    public string NodeId { get; private set; } = string.Empty;

    /// <summary>Null for corrections, which have no form.</summary>
    public Guid? FormId { get; private set; }

    public int? FormVersion { get; private set; }

    /// <summary>The values written to the data: accepted answers, or each corrected key's new value; null clears the key.</summary>
    public string Values { get; private set; } = "{}";

    public Guid SubmittedBy { get; private set; }
    public DateTimeOffset SubmittedAt { get; private set; }

    /// <summary>A correction's justification.</summary>
    public string? Justification { get; private set; }

    /// <summary>A correction's open incidents at that moment, as a JSON array of ids.</summary>
    public string? IncidentIds { get; private set; }

    /// <summary>A correction's <c>[{ key, before, after }]</c>, as JSON.</summary>
    public string? Changes { get; private set; }

    public static InstanceSubmission Create(
        Guid instanceId, Guid? taskId, string nodeId, Guid formId, int formVersion, JsonObject values, Guid submittedBy, DateTimeOffset now) => new()
    {
        Id = Guid.CreateVersion7(now),
        InstanceId = instanceId,
        Kind = SubmissionKind.Submission,
        TaskId = taskId,
        NodeId = nodeId,
        FormId = formId,
        FormVersion = formVersion,
        Values = values.ToJsonString(),
        SubmittedBy = submittedBy,
        SubmittedAt = now,
    };

    /// <summary>Records an admin data correction (workflow-engine.md §16.4).</summary>
    public static InstanceSubmission Correction(
        Instance instance, IReadOnlyList<DataChange> changes, string justification, IReadOnlyList<Guid> incidentIds, Guid correctedBy, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(instance);
        ArgumentNullException.ThrowIfNull(changes);
        var values = new JsonObject();
        foreach (var change in changes)
        {
            values[change.Key] = change.After?.DeepClone();
        }

        return new InstanceSubmission
        {
            Id = Guid.CreateVersion7(now),
            InstanceId = instance.Id,
            Kind = SubmissionKind.Correction,
            NodeId = instance.CurrentNodeId,
            Values = values.ToJsonString(),
            SubmittedBy = correctedBy,
            SubmittedAt = now,
            Justification = justification,
            IncidentIds = JsonSerializer.Serialize(incidentIds),
            Changes = ToJson(changes).ToJsonString(),
        };
    }

    /// <summary><c>[{ key, before, after }]</c>, as stored in the history and in the <c>data.corrected</c> event.</summary>
    public static JsonArray ToJson(IReadOnlyList<DataChange> changes)
    {
        ArgumentNullException.ThrowIfNull(changes);
        return [.. changes.Select(c => new JsonObject { ["key"] = c.Key, ["before"] = c.Before?.DeepClone(), ["after"] = c.After?.DeepClone() })];
    }
}

/// <summary>A failed automatic step that needs an admin (workflow-engine.md §7, §13.3).</summary>
public sealed class InstanceIncident
{
    private InstanceIncident()
    {
    }

    public Guid Id { get; private set; }
    public Guid InstanceId { get; private set; }
    public string NodeId { get; private set; } = string.Empty;
    public string Code { get; private set; } = string.Empty;
    public string Message { get; private set; } = string.Empty;
    public DateTimeOffset CreatedAt { get; private set; }
    public DateTimeOffset? ResolvedAt { get; private set; }
    public Guid? ResolvedBy { get; private set; }

    /// <summary><c>retried</c> or <c>cancelled</c> once resolved.</summary>
    public string? Resolution { get; private set; }

    public bool IsOpen => ResolvedAt is null;

    public static InstanceIncident Open(Guid instanceId, string nodeId, string code, string message, DateTimeOffset now) => new()
    {
        Id = Guid.CreateVersion7(now),
        InstanceId = instanceId,
        NodeId = nodeId,
        Code = code,
        Message = message.Length > 1000 ? message[..1000] : message,
        CreatedAt = now,
    };

    /// <summary>Resolves the incident; <paramref name="actorId"/> is null when the engine resolves it on its own.</summary>
    public void Resolve(string resolution, Guid? actorId, DateTimeOffset now)
    {
        if (!IsOpen)
        {
            throw new InvalidOperationException("The incident is already resolved.");
        }

        Resolution = resolution;
        ResolvedBy = actorId;
        ResolvedAt = now;
    }
}
