using Chain.SharedKernel;

namespace Chain.Workflows.Modeling;

/// <summary>A workflow definition name: 1–100 characters, trimmed, of text PostgreSQL can store; unique ignoring case.</summary>
public readonly record struct WorkflowName
{
    public const int MaxLength = 100;

    private WorkflowName(string value) => Value = value;

    public string Value { get; }

    public string Normalized => Value.ToLowerInvariant();

    public static bool TryCreate(string? raw, out WorkflowName name)
    {
        name = default;
        var candidate = raw?.Trim();
        if (string.IsNullOrEmpty(candidate) || candidate.Length > MaxLength || !ClientText.IsStorable(candidate))
        {
            return false;
        }

        name = new WorkflowName(candidate);
        return true;
    }

    public static WorkflowName Create(string raw) =>
        TryCreate(raw, out var name) ? name : throw new ArgumentException("Invalid workflow name.", nameof(raw));
}

/// <summary>
/// A workflow definition with one editable draft and a sequence of immutable published versions
/// (ADR-0004; workflow-definition.md §5).
/// </summary>
public sealed class WorkflowDefinition
{
    public const int MaxDescriptionLength = 500;
    public const string EmptyDraft = """{"schemaVersion":1,"lanes":[],"nodes":[],"flows":[]}""";

    private WorkflowDefinition()
    {
    }

    public Guid Id { get; private set; }
    public string Name { get; private set; } = string.Empty;
    public string NormalizedName { get; private set; } = string.Empty;
    public string? Description { get; private set; }
    public bool IsActive { get; private set; }
    public string Draft { get; private set; } = EmptyDraft;
    public DateTimeOffset DraftUpdatedAt { get; private set; }
    public Guid DraftUpdatedBy { get; private set; }
    public int? LatestVersion { get; private set; }
    public DateTimeOffset CreatedAt { get; private set; }
    public Guid CreatedBy { get; private set; }
    public DateTimeOffset UpdatedAt { get; private set; }

    public static WorkflowDefinition Create(WorkflowName name, string? description, Guid actorId, DateTimeOffset now)
    {
        var definition = new WorkflowDefinition
        {
            Id = Guid.CreateVersion7(now),
            CreatedAt = now,
            CreatedBy = actorId,
            DraftUpdatedAt = now,
            DraftUpdatedBy = actorId,
        };
        definition.Rename(name, now);
        definition.Describe(description, now);
        return definition;
    }

    public void Rename(WorkflowName name, DateTimeOffset now)
    {
        Name = name.Value;
        NormalizedName = name.Normalized;
        UpdatedAt = now;
    }

    public void Describe(string? description, DateTimeOffset now)
    {
        var trimmed = string.IsNullOrWhiteSpace(description) ? null : description.Trim();
        if (trimmed?.Length > MaxDescriptionLength)
        {
            throw new ArgumentException($"The description is limited to {MaxDescriptionLength} characters.", nameof(description));
        }

        Description = trimmed;
        UpdatedAt = now;
    }

    /// <summary>Stores a draft document. Callers must have checked that it parses; drafts are not otherwise validated.</summary>
    public void SaveDraft(string document, Guid actorId, DateTimeOffset now)
    {
        Draft = document;
        DraftUpdatedAt = now;
        DraftUpdatedBy = actorId;
        UpdatedAt = now;
    }

    public int NextVersionNumber => (LatestVersion ?? 0) + 1;

    /// <summary>Records a new published version. The first publish activates the definition.</summary>
    public void RecordPublished(int versionNumber, DateTimeOffset now)
    {
        if (versionNumber != NextVersionNumber)
        {
            throw new InvalidOperationException($"Expected version {NextVersionNumber}, got {versionNumber}.");
        }

        IsActive = LatestVersion is null || IsActive;
        LatestVersion = versionNumber;
        UpdatedAt = now;
    }

    public void Activate(DateTimeOffset now)
    {
        IsActive = true;
        UpdatedAt = now;
    }

    public void Deactivate(DateTimeOffset now)
    {
        IsActive = false;
        UpdatedAt = now;
    }

    /// <summary>Marks a change made outside this row (e.g. grants) so the definition's version moves on (ADR-0008 §3).</summary>
    public void Touch(DateTimeOffset now) => UpdatedAt = now;
}

/// <summary>An immutable published version: the pinned document, its canonical form and hash (ADR-0004).</summary>
public sealed class WorkflowVersion
{
    private WorkflowVersion()
    {
    }

    public Guid Id { get; private set; }
    public Guid DefinitionId { get; private set; }
    public int VersionNumber { get; private set; }
    public string Document { get; private set; } = string.Empty;
    public string CanonicalJson { get; private set; } = string.Empty;
    public string ContentHash { get; private set; } = string.Empty;
    public DateTimeOffset PublishedAt { get; private set; }
    public Guid PublishedBy { get; private set; }

    /// <summary>
    /// The keys the version's pinned forms mark sensitive, sorted: their union, recorded at publish so it never changes for the
    /// version's requests (sensitive-data.md §2, card #53). Versions published before it have none.
    /// </summary>
    public string[] SensitiveKeys { get; private set; } = [];

    public static WorkflowVersion Create(
        Guid definitionId, int versionNumber, string canonicalJson, string contentHash, Guid publishedBy, DateTimeOffset now,
        IReadOnlyList<string>? sensitiveKeys = null) => new()
    {
        Id = Guid.CreateVersion7(now),
        DefinitionId = definitionId,
        VersionNumber = versionNumber,
        Document = canonicalJson,
        CanonicalJson = canonicalJson,
        ContentHash = contentHash,
        PublishedAt = now,
        PublishedBy = publishedBy,
        SensitiveKeys = [.. (sensitiveKeys ?? []).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal)],
    };
}

/// <summary>Actions a group may take on a workflow's instances (ADR-0006 §3).</summary>
/// <summary>Workflow capabilities (ADR-0006); <see cref="ViewSensitive"/> is sensitive-data.md §3 (card #53).</summary>
public enum WorkflowCapability { Start, View, Close, Comment, ViewSensitive }

public sealed class WorkflowGrant
{
    private WorkflowGrant()
    {
    }

    public Guid DefinitionId { get; private set; }
    public Guid GroupId { get; private set; }
    public WorkflowCapability Capability { get; private set; }

    public static WorkflowGrant Create(Guid definitionId, Guid groupId, WorkflowCapability capability) =>
        new() { DefinitionId = definitionId, GroupId = groupId, Capability = capability };
}
