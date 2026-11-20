using Chain.SharedKernel;
using Chain.Workflows.Modeling;
using Chain.Workflows.Runtime;

namespace Chain.Workflows.Application.Engine;

/// <summary>An actor as the engine needs it: identity, admin flag and group memberships.</summary>
public sealed record ActorInfo(Guid Id, string Username, string DisplayName, bool IsAdmin, bool IsActive,
    IReadOnlySet<Guid> GroupIds, IReadOnlySet<Guid> ActiveGroupIds)
{
    /// <summary>Eligible for a task: the requester for requester tasks, a member (archived groups included) otherwise.</summary>
    public bool IsEligibleFor(InstanceTask task, Instance instance) =>
        task.GroupId is { } groupId ? GroupIds.Contains(groupId) : instance.RequesterId == Id;
}

/// <summary>Read access to actors and groups owned by the identity module.</summary>
public interface IActorDirectory
{
    Task<ActorInfo?> GetActorAsync(Guid actorId, CancellationToken cancellationToken);

    Task<IReadOnlyDictionary<Guid, ActorRef>> GetActorsAsync(IReadOnlyCollection<Guid> ids, CancellationToken cancellationToken);

    Task<IReadOnlyDictionary<Guid, GroupInfo>> GetGroupsAsync(IReadOnlyCollection<Guid> ids, CancellationToken cancellationToken);
}

/// <summary>Published form versions owned by the forms module (ADR-0009).</summary>
public interface IFormVersionSource
{
    /// <summary>The document of a published form version, or null if it does not exist.</summary>
    Task<string?> GetDocumentAsync(Guid formId, int versionNumber, CancellationToken cancellationToken);
}

/// <summary>A stored idempotent command result (ADR-0008 §4).</summary>
public sealed record IdempotencyRecord(Guid ActorId, string Key, string RequestHash, string? ResultJson);

/// <summary>Persistence for instances. Every use case runs inside <see cref="InTransactionAsync{T}"/> (ADR-0008 §1).</summary>
public interface IInstanceStore
{
    Task<T> InTransactionAsync<T>(Func<CancellationToken, Task<T>> work, CancellationToken cancellationToken);

    Task<WorkflowDefinition?> FindDefinitionAsync(Guid id, CancellationToken cancellationToken);

    Task<WorkflowVersion?> FindVersionAsync(Guid definitionId, int versionNumber, CancellationToken cancellationToken);

    /// <summary>Definitions on which any of <paramref name="groupIds"/> holds <paramref name="capability"/>.</summary>
    Task<IReadOnlySet<Guid>> DefinitionsGrantedAsync(IReadOnlySet<Guid> groupIds, WorkflowCapability capability, CancellationToken cancellationToken);

    Task<bool> HasCapabilityAsync(Guid definitionId, IReadOnlySet<Guid> groupIds, WorkflowCapability capability, CancellationToken cancellationToken);

    Task<Guid?> CommentGroupAsync(Guid definitionId, IReadOnlySet<Guid> groupIds, CancellationToken cancellationToken);

    Task<IReadOnlyList<WorkflowDefinition>> ListActiveDefinitionsAsync(IReadOnlySet<Guid> definitionIds, CancellationToken cancellationToken);

    Task<Instance?> FindInstanceAsync(Guid id, CancellationToken cancellationToken);

    /// <summary>The tracked aggregate's row version (<c>xmin</c>, ADR-0008 §3).</summary>
    uint VersionOf(object aggregate);

    /// <summary>Loads and locks the instance row until the transaction ends, serializing commands on one request.</summary>
    Task<Instance?> LockInstanceAsync(Guid id, CancellationToken cancellationToken);

    /// <summary>The instance a task belongs to, read without tracking (used before taking the instance lock).</summary>
    Task<Guid?> FindTaskInstanceIdAsync(Guid taskId, CancellationToken cancellationToken);

    Task<InstanceTask?> FindTaskAsync(Guid id, CancellationToken cancellationToken);

    Task<IReadOnlyList<InstanceTask>> GetOpenTasksAsync(Guid instanceId, CancellationToken cancellationToken);

    Task<IReadOnlyList<Guid>> GetParticipantIdsAsync(Guid instanceId, CancellationToken cancellationToken);

    Task<IReadOnlyList<InstanceEvent>> GetEventsAsync(Guid instanceId, CancellationToken cancellationToken);

    /// <summary>Instances requested by the actor (<paramref name="mineOnly"/>) or visible to them (workflow-engine.md §6).</summary>
    Task<IReadOnlyList<Instance>> ListInstancesAsync(ActorInfo actor, IReadOnlySet<Guid> viewableDefinitions, bool mineOnly, InstanceStatus? status, CancellationToken cancellationToken);

    /// <summary>Open tasks of running instances the actor is eligible for, with their instances.</summary>
    Task<IReadOnlyList<(InstanceTask Task, Instance Instance)>> GetInboxAsync(ActorInfo actor, CancellationToken cancellationToken);

    Task<bool> IsParticipantAsync(Guid instanceId, Guid actorId, CancellationToken cancellationToken);

    Task<IdempotencyRecord?> FindIdempotencyAsync(Guid actorId, string key, CancellationToken cancellationToken);

    /// <summary>
    /// Reserves the key for this transaction. Returns false when the key already exists and was first used at or after
    /// <paramref name="expiredBefore"/>; an older key is taken over as if it were new (the replay window, ADR-0008 §4).
    /// A concurrent request with the same key waits until the first commits and then also gets false, so it can replay the stored result.
    /// </summary>
    Task<bool> TryReserveIdempotencyAsync(IdempotencyRecord record, DateTimeOffset now, DateTimeOffset expiredBefore, CancellationToken cancellationToken);

    Task CompleteIdempotencyAsync(Guid actorId, string key, string resultJson, CancellationToken cancellationToken);

    void Add(Instance instance);

    void Add(InstanceTask task);

    void Add(InstanceParticipant participant);

    void Add(InstanceEvent instanceEvent);

    void Add(InstanceSubmission submission);

    /// <summary>Locks the instance and its ancestors, root first, so parent and child commands never deadlock (workflow-engine.md §14.2).</summary>
    Task<Instance?> LockChainAsync(Guid id, CancellationToken cancellationToken);

    Task<IReadOnlyList<Instance>> GetChildrenAsync(Guid parentId, CancellationToken cancellationToken);

    void Add(InstanceIncident incident);

    void Add(AutomationWorkRequest request);

    /// <summary>The step's execute request with the highest activation in the instance, untracked; null before the first dispatch.</summary>
    Task<AutomationWorkRequest?> LatestExecutionAsync(Guid instanceId, string nodeId, CancellationToken cancellationToken);

    /// <summary>Up to <paramref name="limit"/> pending execute requests whose deadline has passed, read without locking (automation.md §6.7).</summary>
    Task<IReadOnlyList<(Guid RequestId, Guid InstanceId)>> DueExecutionsAsync(DateTimeOffset now, int limit, CancellationToken cancellationToken);

    Task<AutomationWorkRequest?> FindWorkRequestAsync(Guid id, CancellationToken cancellationToken);

    /// <summary>The instance of an execute request, read without locking; null for an unknown id or a cancel request.</summary>
    Task<Guid?> FindExecutionInstanceAsync(Guid requestId, CancellationToken cancellationToken);

    /// <summary>The stored result of a request, if one was received (automation-contract.md §4.3).</summary>
    Task<AutomationResultRecord?> FindResultAsync(Guid requestId, CancellationToken cancellationToken);

    void Add(AutomationResultRecord result);

    /// <summary>Pending cancel requests whose 24-hour window has passed, tracked.</summary>
    Task<IReadOnlyList<AutomationWorkRequest>> ExpiredCancellationsAsync(DateTimeOffset now, int limit, CancellationToken cancellationToken);

    /// <summary>The instance's pending execute request, tracked; there is at most one (automation.md §6.2).</summary>
    Task<AutomationWorkRequest?> FindPendingExecutionAsync(Guid instanceId, CancellationToken cancellationToken);

    /// <summary>All incidents of the instance, tracked so open ones can be resolved.</summary>
    Task<IReadOnlyList<InstanceIncident>> GetIncidentsAsync(Guid instanceId, CancellationToken cancellationToken);

    void Audit(AuditRecord record, DateTimeOffset now);

    Task SaveChangesAsync(CancellationToken cancellationToken);
}
