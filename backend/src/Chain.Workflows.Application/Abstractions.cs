using Chain.Automations;
using Chain.SharedKernel;
using Chain.Workflows.Modeling;

namespace Chain.Workflows.Application;

/// <summary>Persistence for workflow definitions. Every use case runs inside <see cref="InTransactionAsync{T}"/> (ADR-0008 §1).</summary>
public interface IWorkflowStore
{
    /// <summary>Runs <paramref name="work"/> in one transaction; tracked changes are saved and committed when it completes.</summary>
    Task<T> InTransactionAsync<T>(Func<CancellationToken, Task<T>> work, CancellationToken cancellationToken);

    Task<IReadOnlyList<WorkflowDefinition>> ListDefinitionsAsync(CancellationToken cancellationToken);

    Task<WorkflowDefinition?> FindDefinitionAsync(Guid id, CancellationToken cancellationToken);

    Task<bool> DefinitionNameExistsAsync(string normalizedName, Guid? excludingId, CancellationToken cancellationToken);

    Task<WorkflowVersion?> FindVersionAsync(Guid definitionId, int versionNumber, CancellationToken cancellationToken);

    Task<IReadOnlyList<WorkflowVersion>> ListVersionsAsync(Guid definitionId, CancellationToken cancellationToken);

    Task<IReadOnlyList<WorkflowGrant>> GetGrantsAsync(Guid definitionId, CancellationToken cancellationToken);

    Task ReplaceGrantsAsync(Guid definitionId, IReadOnlyList<WorkflowGrant> grants, CancellationToken cancellationToken);

    void Add(WorkflowDefinition definition);

    void Add(WorkflowVersion version);

    void Audit(AuditRecord record, DateTimeOffset now);

    uint VersionOf(object aggregate);

    void ExpectVersion(object aggregate, uint version);

    Task SaveChangesAsync(CancellationToken cancellationToken);
}


public sealed record GroupState(Guid Id, string Name, bool IsArchived);

/// <summary>Read access to forms owned by the forms module (ADR-0009).</summary>
public interface IFormDirectory
{
    /// <summary>The latest published version of the form, or null if it doesn't exist or was never published.</summary>
    Task<int?> LatestPublishedVersionAsync(Guid formId, CancellationToken cancellationToken);

    /// <summary>The document of a published form version, or null if it does not exist (used by the data catalog).</summary>
    Task<string?> GetVersionDocumentAsync(Guid formId, int versionNumber, CancellationToken cancellationToken);
}

/// <summary>Read access to automations owned by the automations module (automation.md §5.5).</summary>
public interface IAutomationDirectory
{
    /// <summary>
    /// The latest published version of the automation, with its destination and secrets as they are now; null if the automation
    /// doesn't exist or was never published.
    /// </summary>
    Task<PublishedAutomation?> LatestPublishedAsync(Guid automationId, CancellationToken cancellationToken);

    /// <summary>A pinned version, with its destination and secrets as they are now (dispatch, automation.md §6.1); null if it doesn't exist.</summary>
    Task<PublishedAutomation?> VersionAsync(Guid automationId, int versionNumber, CancellationToken cancellationToken);

    /// <summary>A published version's document only, for its contracts (workflow-definition.md §6, card #76); null if it doesn't exist.</summary>
    Task<AutomationDocument?> GetVersionDocumentAsync(Guid automationId, int versionNumber, CancellationToken cancellationToken);
}

/// <summary>
/// A published automation version, the destination it calls (null when that no longer exists), and the allowed destinations of
/// each secret it uses that still exists, by name: what <c>AutomationRules.CheckReferences</c> takes.
/// </summary>
public sealed record PublishedAutomation(
    int Version, string Name, AutomationDocument Document, Destination? Destination, IReadOnlyDictionary<string, IReadOnlyList<string>> Secrets);

/// <summary>Read access to groups owned by the identity module.</summary>
public interface IGroupDirectory
{
    Task<IReadOnlyDictionary<Guid, GroupState>> GetGroupsAsync(IReadOnlyCollection<Guid> ids, CancellationToken cancellationToken);

    /// <summary>The groups that are not archived, by name: those a lane can be given.</summary>
    Task<IReadOnlyList<GroupState>> ListActiveAsync(CancellationToken cancellationToken);
}
