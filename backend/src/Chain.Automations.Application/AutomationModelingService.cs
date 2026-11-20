using System.Globalization;
using System.Text.Json;
using Chain.SharedKernel;

namespace Chain.Automations.Application;

public sealed record AutomationSummary(Guid Id, string Name, string? Description, int? LatestVersion, DateTimeOffset DraftUpdatedAt);

/// <summary>An automation with its draft; <see cref="Version"/> is the row version sent as the <c>ETag</c> (ADR-0008 §3).</summary>
public sealed record AutomationView(Guid Id, string Name, string? Description, int? LatestVersion, DateTimeOffset DraftUpdatedAt, uint Version, JsonElement Draft);

public sealed record AutomationVersionSummary(int VersionNumber, string ContentHash, DateTimeOffset PublishedAt, Guid PublishedBy);

public sealed record AutomationVersionView(int VersionNumber, string ContentHash, DateTimeOffset PublishedAt, JsonElement Document);

public sealed record AutomationPublishOutcome(int VersionNumber, string ContentHash, bool Created);

public sealed record AutomationValidationReport(bool Valid, IReadOnlyList<AutomationIssue> Errors);

/// <summary>
/// Automation definitions: drafts, validation, publishing, versions and restore, with the same shapes as forms (automation.md §5.1).
/// Modelers and admins author them (AU-1); destinations and secrets stay admin-only, and Modelers reference secrets by name only.
/// </summary>
public sealed class AutomationModelingService(IAutomationStore store, IModelingAuthorization authorization, TimeProvider time)
{
    public Task<AutomationResult<IReadOnlyList<AutomationSummary>>> ListAsync(Guid actorId, CancellationToken cancellationToken) =>
        AsModeler<IReadOnlyList<AutomationSummary>>(actorId, async ct =>
            AutomationResult.Ok<IReadOnlyList<AutomationSummary>>(
                [.. (await store.ListDefinitionsAsync(ct)).Select(d => new AutomationSummary(d.Id, d.Name, d.Description, d.LatestVersion, d.DraftUpdatedAt))]),
            cancellationToken);

    public async Task<AutomationResult<AutomationView>> CreateAsync(Guid actorId, string? rawName, string? description, CancellationToken cancellationToken)
    {
        if (!AutomationName.TryCreate(rawName, out var name))
        {
            return AutomationResult.Fail<AutomationView>(AutomationError.ValidationFailed, ["invalid_name"]);
        }

        if (description?.Trim().Length > AutomationDefinition.MaxDescriptionLength)
        {
            return AutomationResult.Fail<AutomationView>(AutomationError.ValidationFailed, ["description_too_long"]);
        }

        if (!ClientText.IsStorable(description))
        {
            return AutomationResult.Fail<AutomationView>(AutomationError.ValidationFailed, ["invalid_description"]);
        }

        try
        {
            return await AsModeler(actorId, async ct =>
            {
                if (await store.DefinitionNameExistsAsync(name.Normalized, null, ct))
                {
                    return AutomationResult.Fail<AutomationView>(AutomationError.AutomationNameTaken);
                }

                var now = time.GetUtcNow();
                var definition = AutomationDefinition.Create(name, description, actorId, now);
                store.Add(definition);
                Audit("automation.created", actorId, definition.Id, now, ("name", definition.Name));
                await store.SaveChangesAsync(ct);
                return AutomationResult.Ok(View(definition));
            }, cancellationToken);
        }
        catch (UniqueConstraintViolationException)
        {
            return AutomationResult.Fail<AutomationView>(AutomationError.AutomationNameTaken);
        }
    }

    public Task<AutomationResult<AutomationView>> GetAsync(Guid actorId, Guid id, CancellationToken cancellationToken) =>
        WithDefinition(actorId, id, null, (d, _) => Task.FromResult(AutomationResult.Ok(View(d))), cancellationToken);

    public async Task<AutomationResult<AutomationView>> UpdateAsync(
        Guid actorId, Guid id, uint expectedVersion, string? rawName, string? description, CancellationToken cancellationToken)
    {
        AutomationName name = default;
        if (rawName is not null && !AutomationName.TryCreate(rawName, out name))
        {
            return AutomationResult.Fail<AutomationView>(AutomationError.ValidationFailed, ["invalid_name"]);
        }

        if (description?.Trim().Length > AutomationDefinition.MaxDescriptionLength)
        {
            return AutomationResult.Fail<AutomationView>(AutomationError.ValidationFailed, ["description_too_long"]);
        }

        if (!ClientText.IsStorable(description))
        {
            return AutomationResult.Fail<AutomationView>(AutomationError.ValidationFailed, ["invalid_description"]);
        }

        try
        {
            return await WithDefinition(actorId, id, expectedVersion, async (definition, ct) =>
            {
                if (rawName is not null && await store.DefinitionNameExistsAsync(name.Normalized, id, ct))
                {
                    return AutomationResult.Fail<AutomationView>(AutomationError.AutomationNameTaken);
                }

                var now = time.GetUtcNow();
                if (rawName is not null)
                {
                    definition.Rename(name, now);
                }

                if (description is not null)
                {
                    definition.Describe(description, now);
                }

                Audit("automation.updated", actorId, id, now, ("name", definition.Name));
                await store.SaveChangesAsync(ct);
                return AutomationResult.Ok(View(definition));
            }, cancellationToken);
        }
        catch (UniqueConstraintViolationException)
        {
            return AutomationResult.Fail<AutomationView>(AutomationError.AutomationNameTaken);
        }
    }

    /// <summary>Saves a draft that parses (<c>AU000</c>); the other rules run on validate and publish.</summary>
    public Task<AutomationResult<AutomationView>> SaveDraftAsync(Guid actorId, Guid id, uint expectedVersion, string document, CancellationToken cancellationToken)
    {
        var parsed = AutomationDocumentParser.Parse(document);
        if (!parsed.IsSuccess)
        {
            return Task.FromResult(AutomationResult.Invalid<AutomationView>(AutomationError.InvalidDocument, [parsed.Error!]));
        }

        return WithDefinition(actorId, id, expectedVersion, async (definition, ct) =>
        {
            var now = time.GetUtcNow();
            definition.SaveDraft(document, actorId, now);
            Audit("automation.draft_saved", actorId, id, now);
            await store.SaveChangesAsync(ct);
            return AutomationResult.Ok(View(definition));
        }, cancellationToken);
    }

    /// <summary>Every rule publishing would run, including the references to destinations and secrets as they are now.</summary>
    public Task<AutomationResult<AutomationValidationReport>> ValidateAsync(Guid actorId, Guid id, CancellationToken cancellationToken) =>
        WithDefinition(actorId, id, null, async (definition, ct) =>
        {
            var (_, issues) = await CheckAsync(definition.Draft, ct);
            return AutomationResult.Ok(new AutomationValidationReport(issues.Count == 0, issues));
        }, cancellationToken);

    /// <summary>
    /// Publishes the draft with its defaults made explicit (§5.2). An unchanged automation creates no version. The version records
    /// its destination and secrets, so deleting them can be refused while it exists (§3.2, §4.2).
    /// </summary>
    public async Task<AutomationResult<AutomationPublishOutcome>> PublishAsync(Guid actorId, Guid id, uint expectedVersion, CancellationToken cancellationToken)
    {
        try
        {
            return await WithDefinition(actorId, id, expectedVersion, async (definition, ct) =>
            {
                var (document, issues) = await CheckAsync(definition.Draft, ct);
                if (issues.Count > 0)
                {
                    return AutomationResult.Invalid<AutomationPublishOutcome>(AutomationError.AutomationValidationFailed, issues);
                }

                var canonical = ContentHash.Canonicalize(AutomationDocumentParser.Normalize(document!));
                var hash = ContentHash.ForCanonical(canonical);
                if (definition.LatestVersion is { } latestNumber && await store.FindVersionAsync(id, latestNumber, ct) is { } latest && latest.ContentHash == hash)
                {
                    return AutomationResult.Ok(new AutomationPublishOutcome(latestNumber, hash, Created: false));
                }

                var now = time.GetUtcNow();
                var number = definition.NextVersionNumber;
                store.Add(AutomationVersion.Create(id, number, canonical, hash, document!.Request.Destination, AutomationRules.SecretsOf(document), actorId, now));
                definition.RecordPublished(number, now);
                Audit("automation.published", actorId, id, now, ("versionNumber", number.ToString(CultureInfo.InvariantCulture)), ("contentHash", hash));
                await store.SaveChangesAsync(ct);
                return AutomationResult.Ok(new AutomationPublishOutcome(number, hash, Created: true));
            }, cancellationToken);
        }
        catch (UniqueConstraintViolationException ex)
        {
            throw new ConcurrencyConflictException(ex);
        }
    }

    public Task<AutomationResult<IReadOnlyList<AutomationVersionSummary>>> ListVersionsAsync(Guid actorId, Guid id, CancellationToken cancellationToken) =>
        WithDefinition<IReadOnlyList<AutomationVersionSummary>>(actorId, id, null, async (_, ct) =>
            AutomationResult.Ok<IReadOnlyList<AutomationVersionSummary>>(
                [.. (await store.ListVersionsAsync(id, ct)).Select(v => new AutomationVersionSummary(v.VersionNumber, v.ContentHash, v.PublishedAt, v.PublishedBy))]),
            cancellationToken);

    public Task<AutomationResult<AutomationVersionView>> GetVersionAsync(Guid actorId, Guid id, int versionNumber, CancellationToken cancellationToken) =>
        WithDefinition(actorId, id, null, async (_, ct) =>
            await store.FindVersionAsync(id, versionNumber, ct) is { } version
                ? AutomationResult.Ok(new AutomationVersionView(version.VersionNumber, version.ContentHash, version.PublishedAt, Json(version.Document)))
                : AutomationResult.Fail<AutomationVersionView>(AutomationError.NotFound),
            cancellationToken);

    public Task<AutomationResult<AutomationView>> RestoreAsync(Guid actorId, Guid id, int versionNumber, uint expectedVersion, CancellationToken cancellationToken) =>
        WithDefinition(actorId, id, expectedVersion, async (definition, ct) =>
        {
            if (await store.FindVersionAsync(id, versionNumber, ct) is not { } version)
            {
                return AutomationResult.Fail<AutomationView>(AutomationError.NotFound);
            }

            var now = time.GetUtcNow();
            definition.SaveDraft(version.Document, actorId, now);
            Audit("automation.restored", actorId, id, now, ("fromVersion", versionNumber.ToString(CultureInfo.InvariantCulture)));
            await store.SaveChangesAsync(ct);
            return AutomationResult.Ok(View(definition));
        }, cancellationToken);

    // Helpers

    /// <summary>Parses the draft and runs AU001–AU012 and AU101–AU106 against the current destination and secrets.</summary>
    private async Task<(AutomationDocument? Document, List<AutomationIssue> Issues)> CheckAsync(string draft, CancellationToken cancellationToken)
    {
        var parsed = AutomationDocumentParser.Parse(draft);
        if (parsed.Document is not { } document)
        {
            return (null, [parsed.Error!]);
        }

        var destination = Names.IsValid(document.Request.Destination) ? await store.FindDestinationAsync(document.Request.Destination, cancellationToken) : null;
        var secrets = (await store.FindSecretsAsync(AutomationRules.SecretsOf(document), cancellationToken))
            .ToDictionary(s => s.Name, s => (IReadOnlyList<string>)s.AllowedDestinations, StringComparer.Ordinal);
        return (document, [.. AutomationRules.Validate(document), .. AutomationRules.CheckReferences(document, destination, secrets)]);
    }

    private Task<AutomationResult<T>> AsModeler<T>(Guid actorId, Func<CancellationToken, Task<AutomationResult<T>>> work, CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
            await authorization.CanModelAsync(actorId, ct) ? await work(ct) : AutomationResult.Fail<T>(AutomationError.Forbidden),
            cancellationToken);

    private Task<AutomationResult<T>> WithDefinition<T>(
        Guid actorId, Guid id, uint? expectedVersion, Func<AutomationDefinition, CancellationToken, Task<AutomationResult<T>>> work, CancellationToken cancellationToken) =>
        AsModeler(actorId, async ct =>
        {
            var definition = await store.FindDefinitionAsync(id, ct);
            if (definition is null)
            {
                return AutomationResult.Fail<T>(AutomationError.NotFound);
            }

            if (expectedVersion is { } version)
            {
                if (store.VersionOf(definition) != version)
                {
                    return AutomationResult.Fail<T>(AutomationError.VersionMismatch);
                }

                store.ExpectVersion(definition, version);
            }

            return await work(definition, ct);
        }, cancellationToken);

    private AutomationView View(AutomationDefinition d) => new(d.Id, d.Name, d.Description, d.LatestVersion, d.DraftUpdatedAt, store.VersionOf(d), Json(d.Draft));

    private static JsonElement Json(string document)
    {
        using var parsed = JsonDocument.Parse(document);
        return parsed.RootElement.Clone();
    }

    private void Audit(string action, Guid actorId, Guid subjectId, DateTimeOffset now, params (string Key, string? Value)[] details) =>
        store.Audit(new AuditRecord(action, actorId, subjectId, details.ToDictionary(d => d.Key, d => d.Value)), now);
}
