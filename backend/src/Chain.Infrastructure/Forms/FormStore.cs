using Chain.Forms;
using Chain.Forms.Application;
using Chain.Workflows.Application;
using Microsoft.EntityFrameworkCore;

namespace Chain.Infrastructure.Forms;

internal sealed class FormStore(ChainDbContext db) : StoreBase(db), IFormStore
{
    public async Task<IReadOnlyList<FormDefinition>> ListDefinitionsAsync(CancellationToken cancellationToken) =>
        await Db.FormDefinitions.AsNoTracking().OrderBy(f => f.Name).ToListAsync(cancellationToken);

    public Task<FormDefinition?> FindDefinitionAsync(Guid id, CancellationToken cancellationToken) =>
        Db.FormDefinitions.SingleOrDefaultAsync(f => f.Id == id, cancellationToken);

    public Task<bool> DefinitionNameExistsAsync(string normalizedName, Guid? excludingId, CancellationToken cancellationToken) =>
        Db.FormDefinitions.AnyAsync(f => f.NormalizedName == normalizedName && f.Id != excludingId, cancellationToken);

    public Task<FormVersion?> FindVersionAsync(Guid definitionId, int versionNumber, CancellationToken cancellationToken) =>
        Db.FormVersions.AsNoTracking().SingleOrDefaultAsync(v => v.DefinitionId == definitionId && v.VersionNumber == versionNumber, cancellationToken);

    public async Task<IReadOnlyList<FormVersion>> ListVersionsAsync(Guid definitionId, CancellationToken cancellationToken) =>
        await Db.FormVersions.AsNoTracking().Where(v => v.DefinitionId == definitionId).OrderBy(v => v.VersionNumber).ToListAsync(cancellationToken);

    public void Add(FormDefinition definition) => Db.FormDefinitions.Add(definition);

    public void Add(FormVersion version) => Db.FormVersions.Add(version);
}

internal sealed class FormVersionSource(ChainDbContext db) : Chain.Workflows.Application.Engine.IFormVersionSource
{
    public Task<string?> GetDocumentAsync(Guid formId, int versionNumber, CancellationToken cancellationToken) =>
        db.FormVersions.AsNoTracking().Where(v => v.DefinitionId == formId && v.VersionNumber == versionNumber)
            .Select(v => v.CanonicalJson).SingleOrDefaultAsync(cancellationToken);
}

internal sealed class FormDirectory(ChainDbContext db) : IFormDirectory
{
    public Task<int?> LatestPublishedVersionAsync(Guid formId, CancellationToken cancellationToken) =>
        db.FormDefinitions.AsNoTracking().Where(f => f.Id == formId).Select(f => f.LatestVersion).SingleOrDefaultAsync(cancellationToken);

    public Task<string?> GetVersionDocumentAsync(Guid formId, int versionNumber, CancellationToken cancellationToken) =>
        db.FormVersions.AsNoTracking().Where(v => v.DefinitionId == formId && v.VersionNumber == versionNumber)
            .Select(v => v.CanonicalJson).SingleOrDefaultAsync(cancellationToken);
}
