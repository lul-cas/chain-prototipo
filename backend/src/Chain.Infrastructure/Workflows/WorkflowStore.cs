using Chain.SharedKernel;
using Chain.Identity;
using Chain.Workflows.Application;
using Chain.Workflows.Modeling;
using Microsoft.EntityFrameworkCore;

namespace Chain.Infrastructure.Workflows;

internal sealed class WorkflowStore(ChainDbContext db) : StoreBase(db), IWorkflowStore
{
    public async Task<IReadOnlyList<WorkflowDefinition>> ListDefinitionsAsync(CancellationToken cancellationToken) =>
        await Db.WorkflowDefinitions.AsNoTracking().OrderBy(d => d.Name).ToListAsync(cancellationToken);

    public Task<WorkflowDefinition?> FindDefinitionAsync(Guid id, CancellationToken cancellationToken) =>
        Db.WorkflowDefinitions.SingleOrDefaultAsync(d => d.Id == id, cancellationToken);

    public Task<bool> DefinitionNameExistsAsync(string normalizedName, Guid? excludingId, CancellationToken cancellationToken) =>
        Db.WorkflowDefinitions.AnyAsync(d => d.NormalizedName == normalizedName && d.Id != excludingId, cancellationToken);

    public Task<WorkflowVersion?> FindVersionAsync(Guid definitionId, int versionNumber, CancellationToken cancellationToken) =>
        Db.WorkflowVersions.AsNoTracking().SingleOrDefaultAsync(v => v.DefinitionId == definitionId && v.VersionNumber == versionNumber, cancellationToken);

    public async Task<IReadOnlyList<WorkflowVersion>> ListVersionsAsync(Guid definitionId, CancellationToken cancellationToken) =>
        await Db.WorkflowVersions.AsNoTracking().Where(v => v.DefinitionId == definitionId).OrderBy(v => v.VersionNumber).ToListAsync(cancellationToken);

    public async Task<IReadOnlyList<WorkflowGrant>> GetGrantsAsync(Guid definitionId, CancellationToken cancellationToken) =>
        await Db.WorkflowGrants.AsNoTracking().Where(g => g.DefinitionId == definitionId).ToListAsync(cancellationToken);

    public async Task ReplaceGrantsAsync(Guid definitionId, IReadOnlyList<WorkflowGrant> grants, CancellationToken cancellationToken)
    {
        await Db.WorkflowGrants.Where(g => g.DefinitionId == definitionId).ExecuteDeleteAsync(cancellationToken);
        Db.WorkflowGrants.AddRange(grants);
    }

    public void Add(WorkflowDefinition definition) => Db.WorkflowDefinitions.Add(definition);

    public void Add(WorkflowVersion version) => Db.WorkflowVersions.Add(version);
}

internal sealed class ModelingAuthorization(ChainDbContext db) : IModelingAuthorization
{
    public Task<bool> CanModelAsync(Guid actorId, CancellationToken cancellationToken) =>
        db.Users.AnyAsync(u => u.Id == actorId && u.IsActive && (u.IsAdmin ||
            (from member in db.GroupMembers
             join grant in db.PlatformGrants on member.GroupId equals grant.GroupId
             join grp in db.Groups on member.GroupId equals grp.Id
             where member.UserId == actorId && grant.Capability == PlatformCapability.Modeler && !grp.IsArchived
             select member).Any()), cancellationToken);
}

internal sealed class GroupDirectory(ChainDbContext db) : IGroupDirectory
{
    public async Task<IReadOnlyDictionary<Guid, GroupState>> GetGroupsAsync(IReadOnlyCollection<Guid> ids, CancellationToken cancellationToken) =>
        ids.Count == 0
            ? new Dictionary<Guid, GroupState>()
            : await db.Groups.AsNoTracking().Where(g => ids.Contains(g.Id))
                .ToDictionaryAsync(g => g.Id, g => new GroupState(g.Id, g.Name, g.IsArchived), cancellationToken);

    public async Task<IReadOnlyList<GroupState>> ListActiveAsync(CancellationToken cancellationToken) =>
        await db.Groups.AsNoTracking().Where(g => !g.IsArchived).OrderBy(g => g.Name)
            .Select(g => new GroupState(g.Id, g.Name, g.IsArchived)).ToListAsync(cancellationToken);
}
