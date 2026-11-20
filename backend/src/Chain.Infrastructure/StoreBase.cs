using System.Data;
using System.Diagnostics;
using System.Text.Json;
using Chain.SharedKernel;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Chain.Infrastructure;

/// <summary>Shared plumbing for module stores: one transaction per use case, audit, versions and error translation (ADR-0008).</summary>
internal abstract class StoreBase(ChainDbContext db)
{
    protected ChainDbContext Db { get; } = db;

    public async Task<T> InTransactionAsync<T>(Func<CancellationToken, Task<T>> work, CancellationToken cancellationToken)
    {
        await using var transaction = await Db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var result = await work(cancellationToken);
        await SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return result;
    }

    public void Audit(AuditRecord record, DateTimeOffset now) => Db.AuditEvents.Add(new AuditEventRow
    {
        Id = Guid.CreateVersion7(now),
        OccurredAt = now,
        ActorId = record.ActorId,
        Action = record.Action,
        SubjectId = record.SubjectId,
        Details = JsonSerializer.Serialize(record.Details),
        CorrelationId = Activity.Current?.TraceId.ToString(),
    });

    public uint VersionOf(object aggregate) => (uint)Db.Entry(aggregate).Property("xmin").CurrentValue!;

    public void ExpectVersion(object aggregate, uint version) => Db.Entry(aggregate).Property("xmin").OriginalValue = version;

    public async Task SaveChangesAsync(CancellationToken cancellationToken)
    {
        try
        {
            await Db.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateConcurrencyException ex)
        {
            throw new ConcurrencyConflictException(ex);
        }
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation } unique)
        {
            throw new UniqueConstraintViolationException(unique.ConstraintName, ex);
        }
    }
}
