using Chain.SharedKernel;

namespace Chain.Automations;

/// <summary>
/// An automation name: 1–100 characters, trimmed, of text PostgreSQL can store; unique ignoring case (automation.md §5.1).
/// </summary>
public readonly record struct AutomationName
{
    public const int MaxLength = 100;

    private AutomationName(string value) => Value = value;

    public string Value { get; }

    public string Normalized => Value.ToLowerInvariant();

    public static bool TryCreate(string? raw, out AutomationName name)
    {
        name = default;
        var candidate = raw?.Trim();
        if (string.IsNullOrEmpty(candidate) || candidate.Length > MaxLength || !ClientText.IsStorable(candidate))
        {
            return false;
        }

        name = new AutomationName(candidate);
        return true;
    }
}

/// <summary>An automation with one editable draft and immutable published versions, like a form (automation.md §5.1; ADR-0004).</summary>
public sealed class AutomationDefinition
{
    public const int MaxDescriptionLength = 500;

    /// <summary>A draft that parses and names no destination yet, so it cannot be published until one is chosen (AU101).</summary>
    public const string EmptyDraft =
        """{"schemaVersion":1,"kind":"http","inputs":[],"request":{"method":"GET","destination":"","path":"/"},"response":{"type":"none"},"outputs":[]}""";

    private AutomationDefinition()
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

    public static AutomationDefinition Create(AutomationName name, string? description, Guid actorId, DateTimeOffset now)
    {
        var definition = new AutomationDefinition { Id = Guid.CreateVersion7(now), CreatedAt = now, CreatedBy = actorId, DraftUpdatedAt = now, DraftUpdatedBy = actorId };
        definition.Rename(name, now);
        definition.Describe(description, now);
        return definition;
    }

    public void Rename(AutomationName name, DateTimeOffset now)
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

/// <summary>
/// An immutable published automation version (ADR-0004). <see cref="Destination"/> and <see cref="Secrets"/> repeat what the
/// document references, so deleting a destination or secret that a version uses can be refused (automation.md §3.2, §4.2).
/// </summary>
public sealed class AutomationVersion
{
    private AutomationVersion()
    {
    }

    public Guid Id { get; private set; }
    public Guid DefinitionId { get; private set; }
    public int VersionNumber { get; private set; }
    public string Document { get; private set; } = string.Empty;
    public string CanonicalJson { get; private set; } = string.Empty;
    public string ContentHash { get; private set; } = string.Empty;
    public string Destination { get; private set; } = string.Empty;
    public string[] Secrets { get; private set; } = [];
    public DateTimeOffset PublishedAt { get; private set; }
    public Guid PublishedBy { get; private set; }

    public static AutomationVersion Create(
        Guid definitionId, int versionNumber, string canonicalJson, string contentHash, string destination, IReadOnlyList<string> secrets, Guid publishedBy, DateTimeOffset now) => new()
    {
        Id = Guid.CreateVersion7(now),
        DefinitionId = definitionId,
        VersionNumber = versionNumber,
        Document = canonicalJson,
        CanonicalJson = canonicalJson,
        ContentHash = contentHash,
        Destination = destination,
        Secrets = [.. secrets],
        PublishedAt = now,
        PublishedBy = publishedBy,
    };
}
