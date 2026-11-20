using System.Globalization;
using Chain.SharedKernel;

namespace Chain.Automations.Application;

/// <summary>
/// Persistence for destinations, secrets and automation definitions. Every use case runs inside <see cref="InTransactionAsync{T}"/>
/// (ADR-0008 §1).
/// </summary>
public interface IAutomationStore
{
    Task<T> InTransactionAsync<T>(Func<CancellationToken, Task<T>> work, CancellationToken cancellationToken);

    Task<IReadOnlyList<Destination>> ListDestinationsAsync(CancellationToken cancellationToken);

    Task<Destination?> FindDestinationAsync(string name, CancellationToken cancellationToken);

    /// <summary>The names among <paramref name="names"/> that exist as destinations.</summary>
    Task<IReadOnlySet<string>> ExistingDestinationsAsync(IReadOnlyCollection<string> names, CancellationToken cancellationToken);

    Task<IReadOnlyList<Secret>> ListSecretsAsync(CancellationToken cancellationToken);

    Task<Secret?> FindSecretAsync(string name, CancellationToken cancellationToken);

    /// <summary>Every secret's name, in order, without tracking the rows (the KEK re-wrap, ADR-0017 §5.2).</summary>
    Task<IReadOnlyList<string>> SecretNamesAsync(CancellationToken cancellationToken);

    /// <summary>Secrets whose allowed list contains <paramref name="destination"/>, tracked so they can be changed.</summary>
    Task<IReadOnlyList<Secret>> SecretsAllowingAsync(string destination, CancellationToken cancellationToken);

    /// <summary>The secrets among <paramref name="names"/> that exist.</summary>
    Task<IReadOnlyList<Secret>> FindSecretsAsync(IReadOnlyCollection<string> names, CancellationToken cancellationToken);

    Task<IReadOnlyList<AutomationDefinition>> ListDefinitionsAsync(CancellationToken cancellationToken);

    Task<AutomationDefinition?> FindDefinitionAsync(Guid id, CancellationToken cancellationToken);

    Task<bool> DefinitionNameExistsAsync(string normalizedName, Guid? excludingId, CancellationToken cancellationToken);

    Task<AutomationVersion?> FindVersionAsync(Guid definitionId, int versionNumber, CancellationToken cancellationToken);

    Task<IReadOnlyList<AutomationVersion>> ListVersionsAsync(Guid definitionId, CancellationToken cancellationToken);

    /// <summary>The names of the automations with a published version that calls <paramref name="destination"/>, in order.</summary>
    Task<IReadOnlyList<string>> AutomationsCallingAsync(string destination, CancellationToken cancellationToken);

    /// <summary>Every published version that calls <paramref name="destination"/>, by automation name and version number.</summary>
    Task<IReadOnlyList<CallingVersion>> VersionsCallingAsync(string destination, CancellationToken cancellationToken);

    /// <summary>The names of the automations with a published version that references <paramref name="secret"/>, in order.</summary>
    Task<IReadOnlyList<string>> AutomationsUsingSecretAsync(string secret, CancellationToken cancellationToken);

    /// <summary>Every published version that references <paramref name="secret"/>, by automation name and version number.</summary>
    Task<IReadOnlyList<CallingVersion>> VersionsUsingSecretAsync(string secret, CancellationToken cancellationToken);

    void Add(Destination destination);

    void Remove(Destination destination);

    void Add(Secret secret);

    void Remove(Secret secret);

    void Add(AutomationDefinition definition);

    void Add(AutomationVersion version);

    void Audit(AuditRecord record, DateTimeOffset now);

    /// <summary>Forgets every row read so far, so the next read sees the database: the re-wrap reads each secret afresh.</summary>
    void ClearTracking();

    uint VersionOf(object aggregate);

    void ExpectVersion(object aggregate, uint version);

    Task SaveChangesAsync(CancellationToken cancellationToken);
}

public enum AutomationError
{
    NotFound,
    Forbidden,
    ValidationFailed,
    DestinationNameTaken,
    SecretNameTaken,
    UnknownDestination,
    DestinationInUse,
    DestinationChangeBreaksVersions,
    SecretInUse,
    SecretChangeBreaksVersions,
    SecretsUnavailable,
    VersionMismatch,
    AutomationNameTaken,
    InvalidDocument,
    AutomationValidationFailed,
}

/// <summary>Outcome of an automation use case; <see cref="Details"/> carries rule codes or the names involved.</summary>
public sealed record AutomationResult<T>(T? Value, AutomationError? Error, IReadOnlyList<string> Details)
{
    public bool IsSuccess => Error is null;

    /// <summary>The document's problems, for <c>invalid_document</c> and <c>automation_validation_failed</c>.</summary>
    public IReadOnlyList<AutomationIssue> Issues { get; init; } = [];

    /// <summary>What still uses a destination or a secret, for <c>destination_in_use</c> and <c>secret_in_use</c>.</summary>
    public AutomationUsage? Usage { get; init; }
}

/// <summary>
/// The secrets that allow a destination, and the automations with a published version that use it. For a refused change of the
/// destination or of a secret, <see cref="Versions"/> lists the versions it would break.
/// </summary>
public sealed record AutomationUsage(IReadOnlyList<string> Secrets, IReadOnlyList<string> Automations)
{
    public IReadOnlyList<BrokenVersion> Versions { get; init; } = [];
}

/// <summary>A published version that calls a destination or uses a secret: its automation's name, its number and its canonical document.</summary>
public sealed record CallingVersion(string Automation, int Version, string Document);

/// <summary>A published version that a change of its destination or of a secret would break, with the rules it would fail (automation.md §3.2, §4.2).</summary>
public sealed record BrokenVersion(string Automation, int Version, IReadOnlyList<AutomationIssue> Errors);

public static class AutomationResult
{
    public static AutomationResult<T> Ok<T>(T value) => new(value, null, []);

    public static AutomationResult<T> Fail<T>(AutomationError error, IEnumerable<string>? details = null) => new(default, error, [.. details ?? []]);

    public static AutomationResult<T> Invalid<T>(AutomationError error, IReadOnlyList<AutomationIssue> issues) => new(default, error, []) { Issues = issues };

    public static AutomationResult<T> InUse<T>(AutomationError error, AutomationUsage usage) => new(default, error, []) { Usage = usage };
}

/// <summary>A destination as admins see it; <see cref="Version"/> is the row version sent as the <c>ETag</c> (ADR-0008 §3).</summary>
public sealed record DestinationView(
    string Name, string? Description, string Scheme, string Host, int? Port, string? PathPrefix, bool Internal, bool AllowSecretsOverHttp,
    long MaxRequestBytes, long MaxResponseBytes, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, uint Version);

/// <summary>Secret metadata; the value is never returned (automation.md §4.2). <see cref="Version"/> counts rotations.</summary>
public sealed record SecretView(
    string Name, string? Description, IReadOnlyList<string> AllowedDestinations, int Version, string KeyId,
    DateTimeOffset CreatedAt, DateTimeOffset? RotatedAt, DateTimeOffset UpdatedAt)
{
    /// <summary>The row version, sent as the <c>ETag</c> only: <see cref="Version"/> already names the rotation count.</summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public uint RowVersion { get; init; }
}

/// <summary>What Modelers see to author automations: names, never values (automation.md §4.3).</summary>
public sealed record AutomationResources(IReadOnlyList<ResourceDestination> Destinations, IReadOnlyList<ResourceSecret> Secrets);

public sealed record ResourceDestination(string Name, string? Description, string Scheme, string Host, int? Port, string? PathPrefix);

public sealed record ResourceSecret(string Name, string? Description, IReadOnlyList<string> AllowedDestinations);

/// <summary>
/// The egress allow-list and the secrets of automations (automation.md §3–§4; ADR-0012). Admin-only, except the resource list
/// for Modelers. No response, log or audit record ever carries a secret value.
/// </summary>
public sealed class AutomationAdminService(IAutomationStore store, KeyRing keys, IModelingAuthorization modeling, TimeProvider time)
{
    // Destinations (§3)

    public Task<IReadOnlyList<DestinationView>> ListDestinationsAsync(CancellationToken cancellationToken) =>
        store.InTransactionAsync<IReadOnlyList<DestinationView>>(
            async ct => [.. (await store.ListDestinationsAsync(ct)).Select(View)], cancellationToken);

    public Task<AutomationResult<DestinationView>> GetDestinationAsync(string name, CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
            await store.FindDestinationAsync(name, ct) is { } destination
                ? AutomationResult.Ok(View(destination))
                : AutomationResult.Fail<DestinationView>(AutomationError.NotFound),
            cancellationToken);

    public Task<AutomationResult<DestinationView>> CreateDestinationAsync(
        Guid actorId, string? name, DestinationSettings settings, CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
        {
            var now = time.GetUtcNow();
            var created = Destination.Create(name, settings, actorId, now);
            if (created.Value is not { } destination)
            {
                return AutomationResult.Fail<DestinationView>(AutomationError.ValidationFailed, created.Errors);
            }

            if (await store.FindDestinationAsync(destination.Name, ct) is not null)
            {
                return AutomationResult.Fail<DestinationView>(AutomationError.DestinationNameTaken);
            }

            store.Add(destination);
            store.Audit(new AuditRecord("admin.automation_destination.created", actorId, null, Describe(destination)), now);
            await store.SaveChangesAsync(ct);
            return AutomationResult.Ok(View(destination));
        }, cancellationToken);

    /// <summary>
    /// Replaces the settings. Refused with <c>destination_in_use</c> when the change would break a published version that calls the
    /// destination, unless forced (§3.2): the new settings are tried on a copy first, since the transaction saves what it tracks.
    /// </summary>
    public Task<AutomationResult<DestinationView>> UpdateDestinationAsync(
        Guid actorId, string name, uint expectedVersion, DestinationSettings settings, bool force, CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
        {
            if (await store.FindDestinationAsync(name, ct) is not { } destination)
            {
                return AutomationResult.Fail<DestinationView>(AutomationError.NotFound);
            }

            if (Stale(destination, expectedVersion))
            {
                return AutomationResult.Fail<DestinationView>(AutomationError.VersionMismatch);
            }

            var now = time.GetUtcNow();
            var changed = Destination.Create(destination.Name, settings, actorId, now);
            if (changed.Value is not { } candidate)
            {
                return AutomationResult.Fail<DestinationView>(AutomationError.ValidationFailed, changed.Errors);
            }

            var broken = await BrokenVersionsAsync(destination, candidate, ct);
            var automations = broken.Select(version => version.Automation).Distinct(StringComparer.Ordinal).ToList();
            if (broken.Count > 0 && !force)
            {
                return AutomationResult.InUse<DestinationView>(AutomationError.DestinationChangeBreaksVersions, new([], automations) { Versions = broken });
            }

            _ = destination.Update(settings, now); // valid: the copy took the same settings
            var details = Describe(destination);
            details["forced"] = broken.Count > 0 ? "true" : "false";
            details["automations"] = string.Join(',', automations);
            store.Audit(new AuditRecord("admin.automation_destination.updated", actorId, null, details), now);
            await store.SaveChangesAsync(ct);
            return AutomationResult.Ok(View(destination));
        }, cancellationToken);

    /// <summary>
    /// The published versions calling the destination that <paramref name="changed"/> would break: those failing a rule of AU104–AU106
    /// that they pass with the <paramref name="current"/> settings (§3.2). A version a forced change already broke blocks nothing more.
    /// </summary>
    private async Task<IReadOnlyList<BrokenVersion>> BrokenVersionsAsync(Destination current, Destination changed, CancellationToken cancellationToken)
    {
        var broken = new List<BrokenVersion>();
        foreach (var version in await store.VersionsCallingAsync(current.Name, cancellationToken))
        {
            var document = AutomationDocumentParser.Parse(version.Document).Document
                ?? throw new InvalidOperationException($"Published version {version.Version} of '{version.Automation}' does not parse.");
            var failing = AutomationRules.CheckDestination(document, current).Select(issue => issue.Code).ToHashSet(StringComparer.Ordinal);
            var errors = AutomationRules.CheckDestination(document, changed).Where(issue => !failing.Contains(issue.Code)).ToList();
            if (errors.Count > 0)
            {
                broken.Add(new BrokenVersion(version.Automation, version.Version, errors));
            }
        }

        return broken;
    }

    /// <summary>
    /// Refused with <c>destination_in_use</c> while a secret allows it or a published automation version calls it, unless forced
    /// (§3.2). A forced delete removes the name from every secret's list; versions are immutable, so their steps fault at dispatch.
    /// </summary>
    public Task<AutomationResult<bool>> DeleteDestinationAsync(Guid actorId, string name, bool force, CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
        {
            if (await store.FindDestinationAsync(name, ct) is not { } destination)
            {
                return AutomationResult.Fail<bool>(AutomationError.NotFound);
            }

            var secrets = await store.SecretsAllowingAsync(name, ct);
            var automations = await store.AutomationsCallingAsync(name, ct);
            var inUse = secrets.Count > 0 || automations.Count > 0;
            if (inUse && !force)
            {
                return AutomationResult.InUse<bool>(AutomationError.DestinationInUse, new([.. secrets.Select(s => s.Name)], automations));
            }

            var now = time.GetUtcNow();
            foreach (var secret in secrets)
            {
                secret.RemoveDestination(name, now);
            }

            store.Remove(destination);
            store.Audit(new AuditRecord("admin.automation_destination.deleted", actorId, null, new Dictionary<string, string?>
            {
                ["name"] = name,
                ["forced"] = force && inUse ? "true" : "false",
                ["secrets"] = string.Join(',', secrets.Select(s => s.Name)),
                ["automations"] = string.Join(',', automations),
            }), now);
            await store.SaveChangesAsync(ct);
            return AutomationResult.Ok(true);
        }, cancellationToken);

    // Secrets (§4)

    public Task<IReadOnlyList<SecretView>> ListSecretsAsync(CancellationToken cancellationToken) =>
        store.InTransactionAsync<IReadOnlyList<SecretView>>(async ct => [.. (await store.ListSecretsAsync(ct)).Select(View)], cancellationToken);

    public Task<AutomationResult<SecretView>> GetSecretAsync(string name, CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
            await store.FindSecretAsync(name, ct) is { } secret
                ? AutomationResult.Ok(View(secret))
                : AutomationResult.Fail<SecretView>(AutomationError.NotFound),
            cancellationToken);

    public Task<AutomationResult<SecretView>> CreateSecretAsync(
        Guid actorId, string? name, string? description, string? value, IReadOnlyList<string>? allowedDestinations, CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
        {
            var allowed = allowedDestinations ?? [];
            var errors = Secret.Validate(name, description, value, allowed);
            if (errors.Count > 0)
            {
                return AutomationResult.Fail<SecretView>(AutomationError.ValidationFailed, errors);
            }

            if (keys.Active is not { } kek)
            {
                return AutomationResult.Fail<SecretView>(AutomationError.SecretsUnavailable);
            }

            if (await store.FindSecretAsync(name!, ct) is not null)
            {
                return AutomationResult.Fail<SecretView>(AutomationError.SecretNameTaken);
            }

            if (await UnknownDestinationsAsync(allowed, ct) is { Count: > 0 } unknown)
            {
                return AutomationResult.Fail<SecretView>(AutomationError.UnknownDestination, unknown);
            }

            var now = time.GetUtcNow();
            var secret = Secret.Create(name!, Blank(description), allowed, kek, value!, actorId, now);
            store.Add(secret);
            store.Audit(new AuditRecord("admin.secret.created", actorId, null, Describe(secret)), now);
            await store.SaveChangesAsync(ct);
            return AutomationResult.Ok(View(secret));
        }, cancellationToken);

    /// <summary>Changes the description or the allowed destinations; null leaves a field as it is.</summary>
    /// <summary>
    /// Changes the description and the allowed destinations. A new list that would break a published version using the secret is
    /// refused with <c>secret_in_use</c>, unless forced (§4.2, card #206), as a destination change is (§3.2).
    /// </summary>
    public Task<AutomationResult<SecretView>> UpdateSecretAsync(
        Guid actorId, string name, uint expectedVersion, string? description, IReadOnlyList<string>? allowedDestinations, bool force,
        CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
        {
            if (await store.FindSecretAsync(name, ct) is not { } secret)
            {
                return AutomationResult.Fail<SecretView>(AutomationError.NotFound);
            }

            if (Stale(secret, expectedVersion))
            {
                return AutomationResult.Fail<SecretView>(AutomationError.VersionMismatch);
            }

            var newDescription = description is null ? secret.Description : Blank(description);
            var allowed = allowedDestinations ?? secret.AllowedDestinations;
            var errors = Secret.ValidateMetadata(newDescription, allowed);
            if (errors.Count > 0)
            {
                return AutomationResult.Fail<SecretView>(AutomationError.ValidationFailed, errors);
            }

            if (await UnknownDestinationsAsync(allowed, ct) is { Count: > 0 } unknown)
            {
                return AutomationResult.Fail<SecretView>(AutomationError.UnknownDestination, unknown);
            }

            IReadOnlyList<BrokenVersion> broken = allowedDestinations is null ? [] : await BrokenVersionsAsync(secret, allowed, ct);
            var automations = broken.Select(version => version.Automation).Distinct(StringComparer.Ordinal).ToList();
            if (broken.Count > 0 && !force)
            {
                return AutomationResult.InUse<SecretView>(AutomationError.SecretChangeBreaksVersions, new([], automations) { Versions = broken });
            }

            var now = time.GetUtcNow();
            secret.Update(newDescription, allowed, now);
            var details = Describe(secret);
            details["forced"] = broken.Count > 0 ? "true" : "false";
            details["automations"] = string.Join(',', automations);
            store.Audit(new AuditRecord("admin.secret.updated", actorId, null, details), now);
            await store.SaveChangesAsync(ct);
            return AutomationResult.Ok(View(secret));
        }, cancellationToken);

    /// <summary>
    /// The published versions using the secret that the new <paramref name="allowed"/> list would break: those failing AU103 for it
    /// that pass with its current list (§4.2). A version a forced change already broke blocks nothing more.
    /// </summary>
    private async Task<IReadOnlyList<BrokenVersion>> BrokenVersionsAsync(Secret current, IReadOnlyList<string> allowed, CancellationToken cancellationToken)
    {
        var broken = new List<BrokenVersion>();
        foreach (var version in await store.VersionsUsingSecretAsync(current.Name, cancellationToken))
        {
            var document = AutomationDocumentParser.Parse(version.Document).Document
                ?? throw new InvalidOperationException($"Published version {version.Version} of '{version.Automation}' does not parse.");
            if (AutomationRules.CheckSecret(document, current.Name, current.AllowedDestinations).Count == 0
                && AutomationRules.CheckSecret(document, current.Name, allowed) is { Count: > 0 } errors)
            {
                broken.Add(new BrokenVersion(version.Automation, version.Version, errors));
            }
        }

        return broken;
    }

    /// <summary>Seals a new value as the next version (ADR-0012 Part 1 §4).</summary>
    public Task<AutomationResult<SecretView>> RotateSecretAsync(Guid actorId, string name, uint expectedVersion, string? value, CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
        {
            if (await store.FindSecretAsync(name, ct) is not { } secret)
            {
                return AutomationResult.Fail<SecretView>(AutomationError.NotFound);
            }

            if (Stale(secret, expectedVersion))
            {
                return AutomationResult.Fail<SecretView>(AutomationError.VersionMismatch);
            }

            if (Secret.ValidateValue(value) is { Count: > 0 } errors)
            {
                return AutomationResult.Fail<SecretView>(AutomationError.ValidationFailed, errors);
            }

            if (keys.Active is not { } kek)
            {
                return AutomationResult.Fail<SecretView>(AutomationError.SecretsUnavailable);
            }

            var now = time.GetUtcNow();
            secret.Rotate(kek, value!, now);
            store.Audit(new AuditRecord("admin.secret.rotated", actorId, null, Describe(secret)), now);
            await store.SaveChangesAsync(ct);
            return AutomationResult.Ok(View(secret));
        }, cancellationToken);

    /// <summary>
    /// Deletes a secret; refused with <c>secret_in_use</c> while a published automation version references it, unless forced
    /// (§4.2, ADR-0012 §8). After a forced delete, steps that use it fail with <c>secret_missing</c>.
    /// </summary>
    public Task<AutomationResult<bool>> DeleteSecretAsync(Guid actorId, string name, bool force, CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
        {
            if (await store.FindSecretAsync(name, ct) is not { } secret)
            {
                return AutomationResult.Fail<bool>(AutomationError.NotFound);
            }

            var automations = await store.AutomationsUsingSecretAsync(name, ct);
            if (automations.Count > 0 && !force)
            {
                return AutomationResult.InUse<bool>(AutomationError.SecretInUse, new([], automations));
            }

            var now = time.GetUtcNow();
            store.Remove(secret);
            var details = Describe(secret);
            details["forced"] = force && automations.Count > 0 ? "true" : "false";
            details["automations"] = string.Join(',', automations);
            store.Audit(new AuditRecord("admin.secret.deleted", actorId, null, details), now);
            await store.SaveChangesAsync(ct);
            return AutomationResult.Ok(true);
        }, cancellationToken);

    // Modelers (§4.3)

    public Task<AutomationResult<AutomationResources>> GetResourcesAsync(Guid actorId, CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
        {
            if (!await modeling.CanModelAsync(actorId, ct))
            {
                return AutomationResult.Fail<AutomationResources>(AutomationError.Forbidden);
            }

            var destinations = await store.ListDestinationsAsync(ct);
            var secrets = await store.ListSecretsAsync(ct);
            return AutomationResult.Ok(new AutomationResources(
                [.. destinations.Select(d => new ResourceDestination(d.Name, d.Description, d.Scheme, d.Host, d.Port, d.PathPrefix))],
                [.. secrets.Select(s => new ResourceSecret(s.Name, s.Description, s.AllowedDestinations))]));
        }, cancellationToken);

    private async Task<IReadOnlyList<string>> UnknownDestinationsAsync(IReadOnlyList<string> names, CancellationToken cancellationToken)
    {
        var existing = await store.ExistingDestinationsAsync(names, cancellationToken);
        return [.. names.Where(name => !existing.Contains(name))];
    }

    /// <summary>
    /// <c>If-Match</c> names an older version (412). The loaded version is compared first, so a stale tag fails even when the
    /// request would change nothing and no row would be written; the expected version also guards the write against a race.
    /// </summary>
    private bool Stale(object aggregate, uint expectedVersion)
    {
        if (store.VersionOf(aggregate) != expectedVersion)
        {
            return true;
        }

        store.ExpectVersion(aggregate, expectedVersion);
        return false;
    }

    private static string? Blank(string? text) => string.IsNullOrWhiteSpace(text) ? null : text;

    private DestinationView View(Destination d) => new(
        d.Name, d.Description, d.Scheme, d.Host, d.Port, d.PathPrefix, d.Internal, d.AllowSecretsOverHttp, d.MaxRequestBytes, d.MaxResponseBytes,
        d.CreatedAt, d.UpdatedAt, store.VersionOf(d));

    private SecretView View(Secret s) =>
        new(s.Name, s.Description, s.AllowedDestinations, s.Version, s.KeyId, s.CreatedAt, s.RotatedAt, s.UpdatedAt) { RowVersion = store.VersionOf(s) };

    private static Dictionary<string, string?> Describe(Destination d) => new()
    {
        ["name"] = d.Name,
        ["scheme"] = d.Scheme,
        ["host"] = d.Host,
        ["port"] = d.Port?.ToString(CultureInfo.InvariantCulture),
        ["pathPrefix"] = d.PathPrefix,
        ["internal"] = d.Internal ? "true" : "false",
        ["allowSecretsOverHttp"] = d.AllowSecretsOverHttp ? "true" : "false",
    };

    /// <summary>The name, version and key id; never the value (ADR-0012 Part 1 §7).</summary>
    private static Dictionary<string, string?> Describe(Secret s) => new()
    {
        ["name"] = s.Name,
        ["version"] = s.Version.ToString(CultureInfo.InvariantCulture),
        ["keyId"] = s.KeyId,
        ["allowedDestinations"] = string.Join(',', s.AllowedDestinations),
    };
}
