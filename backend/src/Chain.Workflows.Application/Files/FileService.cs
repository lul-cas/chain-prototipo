using System.Text.Json;
using Chain.Forms;
using Chain.Workflows.Application.Engine;
using Chain.Workflows.Files;

namespace Chain.Workflows.Application.Files;

public sealed class FileService(
    IInstanceStore instances, IFileStore files, IFileContentStore contents, IActorDirectory directory, InstanceAccess access, TimeProvider time, FileSettings settings)
{
    private static readonly JsonSerializerOptions ResultJson = new(JsonSerializerDefaults.Web);

    public Task<EngineResult<FileCreated>> StoreAsync(
        Guid actorId, string name, string contentType, long size, string sha256, Stream content, Idempotency idempotency, CancellationToken cancellationToken) =>
        IdempotentAsync(actorId, idempotency, async ct =>
        {
            if (await directory.GetActorAsync(actorId, ct) is not { IsActive: true })
            {
                return EngineResult.Fail<FileCreated>(EngineError.NotFound);
            }

            var file = StoredFile.Pending(actorId, name, contentType, size, sha256, time.GetUtcNow());
            files.Add(file);
            await instances.SaveChangesAsync(ct);
            content.Position = 0;
            await contents.WriteAsync(file.Id, content, ct);
            return EngineResult.Ok(new FileCreated(file.Id, file.OriginalName, file.SizeBytes, file.ContentType));
        }, cancellationToken);

    public Task<EngineResult<StoredFile>> AuthorizeAsync(Guid actorId, Guid fileId, CancellationToken cancellationToken) =>
        instances.InTransactionAsync(async ct =>
        {
            var actor = await directory.GetActorAsync(actorId, ct);
            var file = await files.FindAsync(fileId, ct);
            if (actor is not { IsActive: true } || file is null || !await MayDownloadAsync(actor, file, ct))
            {
                return EngineResult.Fail<StoredFile>(EngineError.NotFound);
            }

            return EngineResult.Ok(file);
        }, cancellationToken);

    public Task CopyAsync(Guid fileId, Stream destination, CancellationToken cancellationToken) =>
        contents.CopyToAsync(fileId, destination, cancellationToken);

    public Task<int> PurgePendingAsync(CancellationToken cancellationToken) =>
        instances.InTransactionAsync(async ct =>
        {
            var cutoff = time.GetUtcNow() - TimeSpan.FromHours(settings.PendingTtlHours);
            var removed = 0;
            foreach (var id in await files.PendingIdsCreatedBeforeAsync(cutoff, ct))
            {
                if (await files.LockAsync([id], ct) is not [{ Status: StoredFileStatus.Pending } file])
                {
                    continue;
                }

                await contents.DeleteAsync(file.Id, ct);
                files.Remove(file);
                removed++;
            }

            await instances.SaveChangesAsync(ct);
            return removed;
        }, cancellationToken);

    private async Task<bool> MayDownloadAsync(ActorInfo actor, StoredFile file, CancellationToken cancellationToken)
    {
        if (file.Status == StoredFileStatus.Pending)
        {
            return file.UploadedBy == actor.Id;
        }

        return file.InstanceId is { } instanceId
            && await instances.FindInstanceAsync(instanceId, cancellationToken) is { } instance
            && await access.CanSeeAsync(actor, instance, cancellationToken);
    }

    private Task<EngineResult<T>> IdempotentAsync<T>(
        Guid actorId, Idempotency idempotency, Func<CancellationToken, Task<EngineResult<T>>> work, CancellationToken cancellationToken) =>
        instances.InTransactionAsync(async ct =>
        {
            var now = time.GetUtcNow();
            var reserved = await instances.TryReserveIdempotencyAsync(
                new IdempotencyRecord(actorId, idempotency.Key, idempotency.RequestHash, null), now, now - InstanceService.IdempotencyWindow, ct);
            if (!reserved)
            {
                var existing = await instances.FindIdempotencyAsync(actorId, idempotency.Key, ct)
                    ?? throw new InvalidOperationException("Idempotency key vanished after a conflict.");
                return existing.RequestHash != idempotency.RequestHash || existing.ResultJson is null
                    ? EngineResult.Fail<T>(EngineError.IdempotencyKeyReused)
                    : JsonSerializer.Deserialize<EngineResult<T>>(existing.ResultJson, ResultJson)!;
            }

            var result = await work(ct);
            await instances.SaveChangesAsync(ct);
            await instances.CompleteIdempotencyAsync(actorId, idempotency.Key, JsonSerializer.Serialize(result, ResultJson), ct);
            return result;
        }, cancellationToken);
}
