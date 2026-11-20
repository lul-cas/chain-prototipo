using System.Data;
using Chain.Forms;
using Chain.Forms.Application;
using Chain.Workflows.Application.Files;
using Chain.Workflows.Files;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Npgsql;
using NpgsqlTypes;

namespace Chain.Infrastructure.Files;

internal sealed class FileStore(ChainDbContext db) : IFileStore, IKnownFileSource
{
    public void Add(StoredFile file) => db.Files.Add(file);

    public void Remove(StoredFile file) => db.Files.Remove(file);

    public Task<StoredFile?> FindAsync(Guid id, CancellationToken cancellationToken) =>
        db.Files.AsNoTracking().SingleOrDefaultAsync(file => file.Id == id, cancellationToken);

    public async Task<IReadOnlyList<StoredFile>> LockAsync(IReadOnlyCollection<Guid> ids, CancellationToken cancellationToken)
    {
        var found = new List<StoredFile>();
        foreach (var id in ids.Distinct().Order())
        {
            var file = await db.Files.FromSql($"SELECT *, xmin FROM chain.files WHERE id = {id} FOR UPDATE").SingleOrDefaultAsync(cancellationToken);
            if (file is not null)
            {
                found.Add(file);
            }
        }

        return found;
    }

    public StoredFile Tracked(Guid id) => db.Files.Local.Single(file => file.Id == id);

    public async Task<IReadOnlyList<Guid>> PendingIdsCreatedBeforeAsync(DateTimeOffset cutoff, CancellationToken cancellationToken) =>
        await db.Files.AsNoTracking()
            .Where(file => file.Status == StoredFileStatus.Pending && file.CreatedAt < cutoff)
            .Select(file => file.Id)
            .ToListAsync(cancellationToken);

    public async Task<IReadOnlyDictionary<Guid, FileBinding>> FindAsync(IReadOnlyCollection<Guid> ids, CancellationToken cancellationToken)
    {
        var list = ids.Distinct().ToList();
        if (list.Count == 0)
        {
            return new Dictionary<Guid, FileBinding>();
        }

        var rows = await db.Files.AsNoTracking().Where(file => list.Contains(file.Id)).ToListAsync(cancellationToken);
        return rows.ToDictionary(
            file => file.Id,
            file => new FileBinding(file.UploadedBy, file.Status == StoredFileStatus.Pending, file.OriginalName, file.SizeBytes, file.ContentType));
    }
}

internal sealed class PostgresFileContentStore(ChainDbContext db) : IFileContentStore
{
    public async Task WriteAsync(Guid fileId, Stream content, CancellationToken cancellationToken)
    {
        var connection = await OpenAsync(cancellationToken);
        var transaction = CurrentTransaction() ?? throw new InvalidOperationException("File content is written inside the command transaction.");
        await using var command = new NpgsqlCommand("INSERT INTO chain.file_contents (file_id, content) VALUES ($1, $2)", connection, transaction);
        command.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Uuid, Value = fileId });
        command.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Bytea, Value = content });
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task CopyToAsync(Guid fileId, Stream destination, CancellationToken cancellationToken)
    {
        var connection = await OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand("SELECT content FROM chain.file_contents WHERE file_id = $1", connection);
        command.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Uuid, Value = fileId });
        await using var reader = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess | CommandBehavior.SingleRow, cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            return;
        }

        await using var stream = await reader.GetStreamAsync(0, cancellationToken);
        await stream.CopyToAsync(destination, 81920, cancellationToken);
    }

    public async Task DeleteAsync(Guid fileId, CancellationToken cancellationToken)
    {
        var connection = await OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand("DELETE FROM chain.file_contents WHERE file_id = $1", connection, CurrentTransaction());
        command.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Uuid, Value = fileId });
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private NpgsqlTransaction? CurrentTransaction() => db.Database.CurrentTransaction?.GetDbTransaction() as NpgsqlTransaction;

    private async Task<NpgsqlConnection> OpenAsync(CancellationToken cancellationToken)
    {
        var connection = (NpgsqlConnection)db.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open)
        {
            await connection.OpenAsync(cancellationToken);
        }

        return connection;
    }
}

internal sealed class FileContentRow
{
    public Guid FileId { get; set; }
}
