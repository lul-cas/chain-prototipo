namespace Chain.Workflows.Files;

public enum StoredFileStatus { Pending, Attached }

public enum ScanStatus { NotScanned, Clean, Infected }

public enum AttachmentTarget { Comment, Submission }

public sealed class StoredFile
{
    public const int MaxNameLength = 255;

    private StoredFile()
    {
    }

    public Guid Id { get; private set; }
    public StoredFileStatus Status { get; private set; }
    public Guid UploadedBy { get; private set; }
    public Guid? InstanceId { get; private set; }
    public AttachmentTarget? AttachedToKind { get; private set; }
    public Guid? AttachedToId { get; private set; }
    public string OriginalName { get; private set; } = string.Empty;
    public string ContentType { get; private set; } = string.Empty;
    public long SizeBytes { get; private set; }
    public string Sha256 { get; private set; } = string.Empty;
    public ScanStatus ScanStatus { get; private set; }
    public DateTimeOffset CreatedAt { get; private set; }
    public DateTimeOffset? AttachedAt { get; private set; }

    public static StoredFile Pending(Guid uploadedBy, string name, string contentType, long sizeBytes, string sha256, DateTimeOffset now) => new()
    {
        Id = Guid.CreateVersion7(now),
        Status = StoredFileStatus.Pending,
        UploadedBy = uploadedBy,
        OriginalName = name,
        ContentType = contentType,
        SizeBytes = sizeBytes,
        Sha256 = sha256,
        ScanStatus = ScanStatus.NotScanned,
        CreatedAt = now,
    };

    /// <summary>
    /// Whether the file is attached to <paramref name="instanceId"/> through one of its form submissions, so that a later
    /// submission to the same instance may send it again (forms.md F4, card #69). A comment's file is not.
    /// </summary>
    public bool IsAttachedToSubmissionOf(Guid instanceId) =>
        Status == StoredFileStatus.Attached && InstanceId == instanceId && AttachedToKind == AttachmentTarget.Submission;

    public void Attach(Guid instanceId, AttachmentTarget kind, Guid targetId, DateTimeOffset now)
    {
        if (Status != StoredFileStatus.Pending)
        {
            throw new InvalidOperationException("The file is already attached.");
        }

        Status = StoredFileStatus.Attached;
        InstanceId = instanceId;
        AttachedToKind = kind;
        AttachedToId = targetId;
        AttachedAt = now;
    }
}
