using Chain.Identity;
using Chain.Workflows.Application.Engine;
using Chain.Workflows.Modeling;
using Chain.Workflows.Runtime;
using Microsoft.EntityFrameworkCore;

namespace Chain.Infrastructure.Engine;

internal sealed class InstanceStore(ChainDbContext db) : StoreBase(db), IInstanceStore
{
    public Task<WorkflowDefinition?> FindDefinitionAsync(Guid id, CancellationToken cancellationToken) =>
        Db.WorkflowDefinitions.AsNoTracking().SingleOrDefaultAsync(d => d.Id == id, cancellationToken);

    public Task<WorkflowVersion?> FindVersionAsync(Guid definitionId, int versionNumber, CancellationToken cancellationToken) =>
        Db.WorkflowVersions.AsNoTracking().SingleOrDefaultAsync(v => v.DefinitionId == definitionId && v.VersionNumber == versionNumber, cancellationToken);

    public async Task<IReadOnlySet<Guid>> DefinitionsGrantedAsync(IReadOnlySet<Guid> groupIds, WorkflowCapability capability, CancellationToken cancellationToken)
    {
        var ids = groupIds.ToList();
        return (await Db.WorkflowGrants.Where(g => ids.Contains(g.GroupId) && g.Capability == capability)
            .Select(g => g.DefinitionId).Distinct().ToListAsync(cancellationToken)).ToHashSet();
    }

    public Task<bool> HasCapabilityAsync(Guid definitionId, IReadOnlySet<Guid> groupIds, WorkflowCapability capability, CancellationToken cancellationToken)
    {
        var ids = groupIds.ToList();
        return Db.WorkflowGrants.AnyAsync(g => g.DefinitionId == definitionId && ids.Contains(g.GroupId) && g.Capability == capability, cancellationToken);
    }

    public async Task<Guid?> CommentGroupAsync(Guid definitionId, IReadOnlySet<Guid> groupIds, CancellationToken cancellationToken)
    {
        var ids = groupIds.ToList();
        return ids.Count == 0
            ? null
            : await Db.WorkflowGrants.AsNoTracking()
                .Where(grant => grant.DefinitionId == definitionId && ids.Contains(grant.GroupId) && grant.Capability == WorkflowCapability.Comment)
                .OrderBy(grant => grant.GroupId)
                .Select(grant => (Guid?)grant.GroupId)
                .FirstOrDefaultAsync(cancellationToken);
    }

    public async Task<IReadOnlyList<WorkflowDefinition>> ListActiveDefinitionsAsync(IReadOnlySet<Guid> definitionIds, CancellationToken cancellationToken)
    {
        var ids = definitionIds.ToList();
        return await Db.WorkflowDefinitions.AsNoTracking().Where(d => ids.Contains(d.Id) && d.IsActive).OrderBy(d => d.Name).ToListAsync(cancellationToken);
    }

    public Task<Instance?> FindInstanceAsync(Guid id, CancellationToken cancellationToken) =>
        Db.Instances.SingleOrDefaultAsync(i => i.Id == id, cancellationToken);

    public Task<Instance?> LockInstanceAsync(Guid id, CancellationToken cancellationToken) =>
        Db.Instances.FromSql($"SELECT *, xmin FROM chain.instances WHERE id = {id} FOR UPDATE").SingleOrDefaultAsync(cancellationToken);

    public Task<Guid?> FindTaskInstanceIdAsync(Guid taskId, CancellationToken cancellationToken) =>
        Db.InstanceTasks.AsNoTracking().Where(t => t.Id == taskId).Select(t => (Guid?)t.InstanceId).SingleOrDefaultAsync(cancellationToken);

    public Task<InstanceTask?> FindTaskAsync(Guid id, CancellationToken cancellationToken) =>
        Db.InstanceTasks.SingleOrDefaultAsync(t => t.Id == id, cancellationToken);

    public async Task<IReadOnlyList<InstanceTask>> GetOpenTasksAsync(Guid instanceId, CancellationToken cancellationToken) =>
        await Db.InstanceTasks.Where(t => t.InstanceId == instanceId && t.Status == TaskState.Open).OrderBy(t => t.CreatedAt).ToListAsync(cancellationToken);

    public async Task<IReadOnlyList<Guid>> GetParticipantIdsAsync(Guid instanceId, CancellationToken cancellationToken) =>
        await Db.InstanceParticipants.Where(p => p.InstanceId == instanceId).OrderBy(p => p.FirstAssignedAt).Select(p => p.ActorId).ToListAsync(cancellationToken);

    public async Task<IReadOnlyList<InstanceEvent>> GetEventsAsync(Guid instanceId, CancellationToken cancellationToken) =>
        await Db.InstanceEvents.AsNoTracking().Where(e => e.InstanceId == instanceId).OrderBy(e => e.Sequence).ToListAsync(cancellationToken);

    public async Task<IReadOnlyList<Instance>> ListInstancesAsync(
        ActorInfo actor, IReadOnlySet<Guid> viewableDefinitions, bool mineOnly, InstanceStatus? status, CancellationToken cancellationToken)
    {
        var me = actor.Id;
        var groups = actor.GroupIds.ToList();
        var viewable = viewableDefinitions.ToList();
        var query = Db.Instances.AsNoTracking();

        if (mineOnly)
        {
            query = query.Where(i => i.RequesterId == me);
        }
        else if (!actor.IsAdmin)
        {
            query = query.Where(i =>
                i.RequesterId == me
                || viewable.Contains(i.DefinitionId)
                || Db.InstanceParticipants.Any(p => p.InstanceId == i.Id && p.ActorId == me)
                || Db.InstanceTasks.Any(t => t.InstanceId == i.Id && t.Status == TaskState.Open && t.GroupId != null && groups.Contains(t.GroupId.Value)));
        }

        if (status is { } wanted)
        {
            query = query.Where(i => i.Status == wanted);
        }

        return await query.OrderByDescending(i => i.StartedAt).Take(500).ToListAsync(cancellationToken);
    }

    public async Task<IReadOnlyList<(InstanceTask Task, Instance Instance)>> GetInboxAsync(ActorInfo actor, CancellationToken cancellationToken)
    {
        var me = actor.Id;
        var groups = actor.GroupIds.ToList();
        var rows = await (
            from task in Db.InstanceTasks.AsNoTracking()
            join instance in Db.Instances.AsNoTracking() on task.InstanceId equals instance.Id
            where task.Status == TaskState.Open && instance.Status == InstanceStatus.Running
                  && ((task.GroupId != null && groups.Contains(task.GroupId.Value)) || (task.GroupId == null && instance.RequesterId == me))
            orderby task.CreatedAt
            select new { task, instance }).ToListAsync(cancellationToken);
        return [.. rows.Select(r => (r.task, r.instance))];
    }

    /// <summary>Includes participants added earlier in the same command but not saved yet.</summary>
    public async Task<bool> IsParticipantAsync(Guid instanceId, Guid actorId, CancellationToken cancellationToken) =>
        Db.InstanceParticipants.Local.Any(p => p.InstanceId == instanceId && p.ActorId == actorId)
        || await Db.InstanceParticipants.AnyAsync(p => p.InstanceId == instanceId && p.ActorId == actorId, cancellationToken);

    public async Task<IdempotencyRecord?> FindIdempotencyAsync(Guid actorId, string key, CancellationToken cancellationToken) =>
        await Db.IdempotencyKeys.AsNoTracking().Where(k => k.ActorId == actorId && k.Key == key)
            .Select(k => new IdempotencyRecord(k.ActorId, k.Key, k.RequestHash, k.ResultJson)).SingleOrDefaultAsync(cancellationToken);

    public async Task<bool> TryReserveIdempotencyAsync(IdempotencyRecord record, DateTimeOffset now, DateTimeOffset expiredBefore, CancellationToken cancellationToken) =>
        await Db.Database.ExecuteSqlAsync($"""
            INSERT INTO chain.idempotency_keys (actor_id, key, request_hash, created_at)
            VALUES ({record.ActorId}, {record.Key}, {record.RequestHash}, {now})
            ON CONFLICT (actor_id, key) DO UPDATE
                SET request_hash = EXCLUDED.request_hash, created_at = EXCLUDED.created_at, result_json = NULL
                WHERE idempotency_keys.created_at < {expiredBefore}
            """, cancellationToken) == 1;

    public Task CompleteIdempotencyAsync(Guid actorId, string key, string resultJson, CancellationToken cancellationToken) =>
        Db.IdempotencyKeys.Where(k => k.ActorId == actorId && k.Key == key)
            .ExecuteUpdateAsync(set => set.SetProperty(k => k.ResultJson, resultJson), cancellationToken);

    public void Add(Instance instance) => Db.Instances.Add(instance);

    public void Add(InstanceTask task) => Db.InstanceTasks.Add(task);

    public void Add(InstanceParticipant participant) => Db.InstanceParticipants.Add(participant);

    public void Add(InstanceEvent instanceEvent) => Db.InstanceEvents.Add(instanceEvent);

    public void Add(InstanceSubmission submission) => Db.InstanceSubmissions.Add(submission);

    public async Task<Instance?> LockChainAsync(Guid id, CancellationToken cancellationToken)
    {
        var chain = new List<Guid>();
        for (Guid? current = id; current is { } link && chain.Count <= 64; )
        {
            chain.Add(link);
            current = await Db.Instances.AsNoTracking().Where(i => i.Id == link).Select(i => i.ParentInstanceId).SingleOrDefaultAsync(cancellationToken);
        }

        Instance? locked = null;
        for (var i = chain.Count - 1; i >= 0; i--)
        {
            locked = await LockInstanceAsync(chain[i], cancellationToken);
        }

        return locked;
    }

    public async Task<IReadOnlyList<Instance>> GetChildrenAsync(Guid parentId, CancellationToken cancellationToken) =>
        await Db.Instances.Where(i => i.ParentInstanceId == parentId).ToListAsync(cancellationToken);

    public void Add(InstanceIncident incident) => Db.InstanceIncidents.Add(incident);

    public void Add(AutomationWorkRequest request) => Db.AutomationWorkRequests.Add(request);

    public Task<AutomationWorkRequest?> LatestExecutionAsync(Guid instanceId, string nodeId, CancellationToken cancellationToken) =>
        Db.AutomationWorkRequests.AsNoTracking()
            .Where(r => r.InstanceId == instanceId && r.NodeId == nodeId && r.Kind == AutomationWorkRequest.Execute)
            .OrderByDescending(r => r.Activation)
            .FirstOrDefaultAsync(cancellationToken);

    public async Task<IReadOnlyList<(Guid RequestId, Guid InstanceId)>> DueExecutionsAsync(DateTimeOffset now, int limit, CancellationToken cancellationToken) =>
        [.. (await Db.AutomationWorkRequests.AsNoTracking()
            .Where(r => r.Kind == AutomationWorkRequest.Execute && r.Status == AutomationWorkRequest.Pending && r.DeadlineAt < now)
            .OrderBy(r => r.DeadlineAt)
            .Take(limit)
            .Select(r => new { r.Id, r.InstanceId })
            .ToListAsync(cancellationToken)).Select(r => (r.Id, r.InstanceId))];

    public Task<AutomationWorkRequest?> FindWorkRequestAsync(Guid id, CancellationToken cancellationToken) =>
        Db.AutomationWorkRequests.SingleOrDefaultAsync(r => r.Id == id, cancellationToken);

    public Task<Guid?> FindExecutionInstanceAsync(Guid requestId, CancellationToken cancellationToken) =>
        Db.AutomationWorkRequests.AsNoTracking()
            .Where(r => r.Id == requestId && r.Kind == AutomationWorkRequest.Execute)
            .Select(r => (Guid?)r.InstanceId)
            .SingleOrDefaultAsync(cancellationToken);

    public Task<AutomationResultRecord?> FindResultAsync(Guid requestId, CancellationToken cancellationToken) =>
        Db.AutomationResults.AsNoTracking().SingleOrDefaultAsync(r => r.RequestId == requestId, cancellationToken);

    public void Add(AutomationResultRecord result) => Db.AutomationResults.Add(result);

    public async Task<IReadOnlyList<AutomationWorkRequest>> ExpiredCancellationsAsync(DateTimeOffset now, int limit, CancellationToken cancellationToken) =>
        await Db.AutomationWorkRequests
            .Where(r => r.Kind == AutomationWorkRequest.Cancel && r.Status == AutomationWorkRequest.Pending && r.DeadlineAt < now)
            .OrderBy(r => r.DeadlineAt)
            .Take(limit)
            .ToListAsync(cancellationToken);

    public Task<AutomationWorkRequest?> FindPendingExecutionAsync(Guid instanceId, CancellationToken cancellationToken) =>
        Db.AutomationWorkRequests.SingleOrDefaultAsync(
            r => r.InstanceId == instanceId && r.Kind == AutomationWorkRequest.Execute && r.Status == AutomationWorkRequest.Pending, cancellationToken);

    public async Task<IReadOnlyList<InstanceIncident>> GetIncidentsAsync(Guid instanceId, CancellationToken cancellationToken) =>
        await Db.InstanceIncidents.Where(i => i.InstanceId == instanceId).OrderBy(i => i.CreatedAt).ToListAsync(cancellationToken);
}

internal sealed class ActorDirectory(ChainDbContext db) : IActorDirectory
{
    public async Task<ActorInfo?> GetActorAsync(Guid actorId, CancellationToken cancellationToken)
    {
        var user = await db.Users.AsNoTracking().SingleOrDefaultAsync(u => u.Id == actorId, cancellationToken);
        if (user is null)
        {
            return null;
        }

        var memberships = await (
            from member in db.GroupMembers.AsNoTracking()
            join grp in db.Groups.AsNoTracking() on member.GroupId equals grp.Id
            where member.UserId == actorId
            select new { grp.Id, grp.IsArchived }).ToListAsync(cancellationToken);

        return new ActorInfo(user.Id, user.Username, user.DisplayName, user.IsAdmin, user.IsActive,
            memberships.Select(m => m.Id).ToHashSet(), memberships.Where(m => !m.IsArchived).Select(m => m.Id).ToHashSet());
    }

    public async Task<IReadOnlyDictionary<Guid, ActorRef>> GetActorsAsync(IReadOnlyCollection<Guid> ids, CancellationToken cancellationToken)
    {
        var list = ids.ToList();
        return list.Count == 0
            ? new Dictionary<Guid, ActorRef>()
            : await db.Users.AsNoTracking().Where(u => list.Contains(u.Id))
                .ToDictionaryAsync(u => u.Id, u => new ActorRef(u.Id, u.Username, u.DisplayName), cancellationToken);
    }

    public async Task<IReadOnlyDictionary<Guid, GroupInfo>> GetGroupsAsync(IReadOnlyCollection<Guid> ids, CancellationToken cancellationToken)
    {
        var list = ids.ToList();
        return list.Count == 0
            ? new Dictionary<Guid, GroupInfo>()
            : await db.Groups.AsNoTracking().Where(g => list.Contains(g.Id))
                .ToDictionaryAsync(g => g.Id, g => new GroupInfo(g.Id, g.Name), cancellationToken);
    }
}
