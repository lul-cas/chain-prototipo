using Chain.SharedKernel;

namespace Chain.Forms;

/// <summary>A form definition name: 1–100 characters, trimmed, of text PostgreSQL can store; unique ignoring case.</summary>
public readonly record struct FormName
{
    public const int MaxLength = 100;

    private FormName(string value) => Value = value;

    public string Value { get; }

    public string Normalized => Value.ToLowerInvariant();

    public static bool TryCreate(string? raw, out FormName name)
    {
        name = default;
        var candidate = raw?.Trim();
        if (string.IsNullOrEmpty(candidate) || candidate.Length > MaxLength || !ClientText.IsStorable(candidate))
        {
            return false;
        }

        name = new FormName(candidate);
        return true;
    }
}

/// <summary>A form definition with one editable draft and immutable published versions (ADR-0004, ADR-0009).</summary>
public sealed class FormDefinition
{
    public const int MaxDescriptionLength = 500;
    public const string EmptyDraft = """{"schemaVersion":1,"components":[]}""";

    private FormDefinition()
    {
    }

    public Guid Id { get; private set; }
    public string Name { get; private set; } = string.Empty;
    public string NormalizedName { get; private set; } = string.Empty;
    public string? Description { get; private set; }
    public string Draft { get; private set; } = EmptyDraft;
    public DateTimeOffset DraftUpdatedAt { get; private set; }
    public Guid DraftUpdatedBy { get; private set; }
    public int? LatestVersion { get; private set; }
    public DateTimeOffset CreatedAt { get; private set; }
    public Guid CreatedBy { get; private set; }
    public DateTimeOffset UpdatedAt { get; private set; }

    public int NextVersionNumber => (LatestVersion ?? 0) + 1;

    public static FormDefinition Create(FormName name, string? description, Guid actorId, DateTimeOffset now)
    {
        var definition = new FormDefinition { Id = Guid.CreateVersion7(now), CreatedAt = now, CreatedBy = actorId, DraftUpdatedAt = now, DraftUpdatedBy = actorId };
        definition.Rename(name, now);
        definition.Describe(description, now);
        return definition;
    }

    public void Rename(FormName name, DateTimeOffset now)
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

    public void SaveDraft(string document, Guid actorId, DateTimeOffset now)
    {
        Draft = document;
        DraftUpdatedAt = now;
        DraftUpdatedBy = actorId;
        UpdatedAt = now;
    }

    public void RecordPublished(int versionNumber, DateTimeOffset now)
    {
        if (versionNumber != NextVersionNumber)
        {
            throw new InvalidOperationException($"Expected version {NextVersionNumber}, got {versionNumber}.");
        }

        LatestVersion = versionNumber;
        UpdatedAt = now;
    }
}

/// <summary>An immutable published form version (ADR-0004).</summary>
public sealed class FormVersion
{
    private FormVersion()
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

    public static FormVersion Create(Guid definitionId, int versionNumber, string canonicalJson, string contentHash, Guid publishedBy, DateTimeOffset now) => new()
    {
        Id = Guid.CreateVersion7(now),
        DefinitionId = definitionId,
        VersionNumber = versionNumber,
        Document = canonicalJson,
        CanonicalJson = canonicalJson,
        ContentHash = contentHash,
        PublishedAt = now,
        PublishedBy = publishedBy,
    };
}
