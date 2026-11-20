using Chain.Automations;
using Chain.Automations.Application;
using Chain.Workflows.Application;
using Microsoft.EntityFrameworkCore;

namespace Chain.Infrastructure.Automations;

internal sealed class AutomationStore(ChainDbContext db) : StoreBase(db), IAutomationStore
{
    public async Task<IReadOnlyList<Destination>> ListDestinationsAsync(CancellationToken cancellationToken) =>
        await Db.AutomationDestinations.OrderBy(d => d.Name).ToListAsync(cancellationToken);

    public Task<Destination?> FindDestinationAsync(string name, CancellationToken cancellationToken) =>
        Db.AutomationDestinations.SingleOrDefaultAsync(d => d.Name == name, cancellationToken);

    public async Task<IReadOnlySet<string>> ExistingDestinationsAsync(IReadOnlyCollection<string> names, CancellationToken cancellationToken)
    {
        var list = names.Distinct(StringComparer.Ordinal).ToList();
        return list.Count == 0
            ? new HashSet<string>(StringComparer.Ordinal)
            : (await Db.AutomationDestinations.AsNoTracking().Where(d => list.Contains(d.Name)).Select(d => d.Name).ToListAsync(cancellationToken))
                .ToHashSet(StringComparer.Ordinal);
    }

    public async Task<IReadOnlyList<Secret>> ListSecretsAsync(CancellationToken cancellationToken) =>
        await Db.AutomationSecrets.OrderBy(s => s.Name).ToListAsync(cancellationToken);

    public Task<Secret?> FindSecretAsync(string name, CancellationToken cancellationToken) =>
        Db.AutomationSecrets.SingleOrDefaultAsync(s => s.Name == name, cancellationToken);

    public async Task<IReadOnlyList<string>> SecretNamesAsync(CancellationToken cancellationToken) =>
        await Db.AutomationSecrets.AsNoTracking().OrderBy(s => s.Name).Select(s => s.Name).ToListAsync(cancellationToken);

    public void ClearTracking() => Db.ChangeTracker.Clear();

    public async Task<IReadOnlyList<Secret>> SecretsAllowingAsync(string destination, CancellationToken cancellationToken) =>
        await Db.AutomationSecrets.Where(s => s.AllowedDestinations.Contains(destination)).OrderBy(s => s.Name).ToListAsync(cancellationToken);

    public async Task<IReadOnlyList<Secret>> FindSecretsAsync(IReadOnlyCollection<string> names, CancellationToken cancellationToken)
    {
        var list = names.Distinct(StringComparer.Ordinal).ToList();
        return list.Count == 0 ? [] : await Db.AutomationSecrets.AsNoTracking().Where(s => list.Contains(s.Name)).ToListAsync(cancellationToken);
    }

    public async Task<IReadOnlyList<AutomationDefinition>> ListDefinitionsAsync(CancellationToken cancellationToken) =>
        await Db.AutomationDefinitions.AsNoTracking().OrderBy(a => a.Name).ToListAsync(cancellationToken);

    public Task<AutomationDefinition?> FindDefinitionAsync(Guid id, CancellationToken cancellationToken) =>
        Db.AutomationDefinitions.SingleOrDefaultAsync(a => a.Id == id, cancellationToken);

    public Task<bool> DefinitionNameExistsAsync(string normalizedName, Guid? excludingId, CancellationToken cancellationToken) =>
        Db.AutomationDefinitions.AnyAsync(a => a.NormalizedName == normalizedName && a.Id != excludingId, cancellationToken);

    public Task<AutomationVersion?> FindVersionAsync(Guid definitionId, int versionNumber, CancellationToken cancellationToken) =>
        Db.AutomationVersions.AsNoTracking().SingleOrDefaultAsync(v => v.DefinitionId == definitionId && v.VersionNumber == versionNumber, cancellationToken);

    public async Task<IReadOnlyList<AutomationVersion>> ListVersionsAsync(Guid definitionId, CancellationToken cancellationToken) =>
        await Db.AutomationVersions.AsNoTracking().Where(v => v.DefinitionId == definitionId).OrderBy(v => v.VersionNumber).ToListAsync(cancellationToken);

    public async Task<IReadOnlyList<string>> AutomationsCallingAsync(string destination, CancellationToken cancellationToken) =>
        await Db.AutomationDefinitions.AsNoTracking()
            .Where(a => Db.AutomationVersions.Any(v => v.DefinitionId == a.Id && v.Destination == destination))
            .OrderBy(a => a.Name).Select(a => a.Name).ToListAsync(cancellationToken);

    public async Task<IReadOnlyList<CallingVersion>> VersionsCallingAsync(string destination, CancellationToken cancellationToken) =>
        await Db.AutomationVersions.AsNoTracking()
            .Where(v => v.Destination == destination)
            .Join(Db.AutomationDefinitions, v => v.DefinitionId, a => a.Id, (v, a) => new { a.Name, v.VersionNumber, v.CanonicalJson })
            .OrderBy(row => row.Name).ThenBy(row => row.VersionNumber)
            .Select(row => new CallingVersion(row.Name, row.VersionNumber, row.CanonicalJson))
            .ToListAsync(cancellationToken);

    public async Task<IReadOnlyList<CallingVersion>> VersionsUsingSecretAsync(string secret, CancellationToken cancellationToken) =>
        await Db.AutomationVersions.AsNoTracking()
            .Where(v => v.Secrets.Contains(secret))
            .Join(Db.AutomationDefinitions, v => v.DefinitionId, a => a.Id, (v, a) => new { a.Name, v.VersionNumber, v.CanonicalJson })
            .OrderBy(row => row.Name).ThenBy(row => row.VersionNumber)
            .Select(row => new CallingVersion(row.Name, row.VersionNumber, row.CanonicalJson))
            .ToListAsync(cancellationToken);

    public async Task<IReadOnlyList<string>> AutomationsUsingSecretAsync(string secret, CancellationToken cancellationToken) =>
        await Db.AutomationDefinitions.AsNoTracking()
            .Where(a => Db.AutomationVersions.Any(v => v.DefinitionId == a.Id && v.Secrets.Contains(secret)))
            .OrderBy(a => a.Name).Select(a => a.Name).ToListAsync(cancellationToken);

    public void Add(AutomationDefinition definition) => Db.AutomationDefinitions.Add(definition);

    public void Add(AutomationVersion version) => Db.AutomationVersions.Add(version);

    public void Add(Destination destination) => Db.AutomationDestinations.Add(destination);

    public void Remove(Destination destination) => Db.AutomationDestinations.Remove(destination);

    public void Add(Secret secret) => Db.AutomationSecrets.Add(secret);

    public void Remove(Secret secret) => Db.AutomationSecrets.Remove(secret);
}

internal sealed class AutomationDirectory(ChainDbContext db) : IAutomationDirectory
{
    public async Task<PublishedAutomation?> LatestPublishedAsync(Guid automationId, CancellationToken cancellationToken) =>
        await db.AutomationDefinitions.AsNoTracking().Where(a => a.Id == automationId).Select(a => a.LatestVersion)
            .SingleOrDefaultAsync(cancellationToken) is { } latest
            ? await VersionAsync(automationId, latest, cancellationToken)
            : null;

    public async Task<PublishedAutomation?> VersionAsync(Guid automationId, int versionNumber, CancellationToken cancellationToken)
    {
        var row = await db.AutomationVersions.AsNoTracking()
            .Where(v => v.DefinitionId == automationId && v.VersionNumber == versionNumber)
            .Join(db.AutomationDefinitions, v => v.DefinitionId, a => a.Id, (v, a) => new { v.CanonicalJson, v.Destination, v.Secrets, a.Name })
            .SingleOrDefaultAsync(cancellationToken);
        if (row is null)
        {
            return null;
        }

        var document = AutomationDocumentParser.Parse(row.CanonicalJson).Document
            ?? throw new InvalidOperationException($"Published version {versionNumber} of automation {automationId} does not parse.");
        var destination = await db.AutomationDestinations.AsNoTracking().SingleOrDefaultAsync(d => d.Name == row.Destination, cancellationToken);
        var secrets = await db.AutomationSecrets.AsNoTracking().Where(s => row.Secrets.Contains(s.Name)).ToListAsync(cancellationToken);
        return new PublishedAutomation(
            versionNumber, row.Name, document, destination,
            secrets.ToDictionary(s => s.Name, s => (IReadOnlyList<string>)s.AllowedDestinations, StringComparer.Ordinal));
    }

    public async Task<AutomationDocument?> GetVersionDocumentAsync(Guid automationId, int versionNumber, CancellationToken cancellationToken) =>
        await db.AutomationVersions.AsNoTracking()
            .Where(v => v.DefinitionId == automationId && v.VersionNumber == versionNumber)
            .Select(v => v.CanonicalJson)
            .SingleOrDefaultAsync(cancellationToken) is { } json
            ? AutomationDocumentParser.Parse(json).Document
                ?? throw new InvalidOperationException($"Published version {versionNumber} of automation {automationId} does not parse.")
            : null;
}
