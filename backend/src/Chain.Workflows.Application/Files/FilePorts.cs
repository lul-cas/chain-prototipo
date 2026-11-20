using Chain.Workflows.Files;

namespace Chain.Workflows.Application.Files;

public sealed record FileSettings(long MaxBytes, int MaxFiles, int PendingTtlHours);

public sealed record FileCreated(Guid Id, string Name, long Size, string ContentType);

public interface IFileContentStore
{
    Task WriteAsync(Guid fileId, Stream content, CancellationToken cancellationToken);

    Task CopyToAsync(Guid fileId, Stream destination, CancellationToken cancellationToken);

    Task DeleteAsync(Guid fileId, CancellationToken cancellationToken);
}

public interface IFileStore
{
    void Add(StoredFile file);

    void Remove(StoredFile file);

    Task<StoredFile?> FindAsync(Guid id, CancellationToken cancellationToken);

    Task<IReadOnlyList<StoredFile>> LockAsync(IReadOnlyCollection<Guid> ids, CancellationToken cancellationToken);

    StoredFile Tracked(Guid id);

    Task<IReadOnlyList<Guid>> PendingIdsCreatedBeforeAsync(DateTimeOffset cutoff, CancellationToken cancellationToken);
}
