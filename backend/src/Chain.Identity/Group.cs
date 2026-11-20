namespace Chain.Identity;

/// <summary>A named set of actors responsible for work (ADR-0006 §2). Groups are archived, never deleted.</summary>
public sealed class Group
{
    public const int MaxDescriptionLength = 500;

    private Group()
    {
    }

    public Guid Id { get; private set; }
    public string Name { get; private set; } = string.Empty;
    public string NormalizedName { get; private set; } = string.Empty;
    public string? Description { get; private set; }
    public bool IsArchived { get; private set; }
    public DateTimeOffset CreatedAt { get; private set; }
    public DateTimeOffset UpdatedAt { get; private set; }

    public static Group Create(GroupName name, string? description, DateTimeOffset now)
    {
        var group = new Group
        {
            Id = Guid.CreateVersion7(now),
            CreatedAt = now,
        };
        group.Rename(name, now);
        group.Describe(description, now);
        return group;
    }

    public void Rename(GroupName name, DateTimeOffset now)
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

    public void Archive(DateTimeOffset now)
    {
        IsArchived = true;
        UpdatedAt = now;
    }

    public void Unarchive(DateTimeOffset now)
    {
        IsArchived = false;
        UpdatedAt = now;
    }
}

/// <summary>Membership of a user in a group.</summary>
public sealed class GroupMember
{
    private GroupMember()
    {
    }

    public Guid GroupId { get; private set; }
    public Guid UserId { get; private set; }
    public DateTimeOffset AddedAt { get; private set; }

    public static GroupMember Create(Guid groupId, Guid userId, DateTimeOffset now) =>
        new() { GroupId = groupId, UserId = userId, AddedAt = now };
}

/// <summary>Platform-level capabilities a group can grant its members (ADR-0006 §3).</summary>
public enum PlatformCapability
{
    /// <summary>Create, edit and publish workflows and forms.</summary>
    Modeler,
}

/// <summary>A platform capability granted to a group.</summary>
public sealed class PlatformGrant
{
    private PlatformGrant()
    {
    }

    public Guid GroupId { get; private set; }
    public PlatformCapability Capability { get; private set; }

    public static PlatformGrant Create(Guid groupId, PlatformCapability capability) => new() { GroupId = groupId, Capability = capability };
}
