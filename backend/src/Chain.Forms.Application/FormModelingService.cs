using System.Globalization;
using System.Text.Json;
using Chain.Forms;
using Chain.SharedKernel;

namespace Chain.Forms.Application;

/// <summary>Persistence for forms. Every use case runs inside <see cref="InTransactionAsync{T}"/> (ADR-0008 §1).</summary>
public interface IFormStore
{
    Task<T> InTransactionAsync<T>(Func<CancellationToken, Task<T>> work, CancellationToken cancellationToken);

    Task<IReadOnlyList<FormDefinition>> ListDefinitionsAsync(CancellationToken cancellationToken);

    Task<FormDefinition?> FindDefinitionAsync(Guid id, CancellationToken cancellationToken);

    Task<bool> DefinitionNameExistsAsync(string normalizedName, Guid? excludingId, CancellationToken cancellationToken);

    Task<FormVersion?> FindVersionAsync(Guid definitionId, int versionNumber, CancellationToken cancellationToken);

    Task<IReadOnlyList<FormVersion>> ListVersionsAsync(Guid definitionId, CancellationToken cancellationToken);

    void Add(FormDefinition definition);

    void Add(FormVersion version);

    void Audit(AuditRecord record, DateTimeOffset now);

    uint VersionOf(object aggregate);

    void ExpectVersion(object aggregate, uint version);

    Task SaveChangesAsync(CancellationToken cancellationToken);
}

public enum FormError { Forbidden, NotFound, ValidationFailed, InvalidDocument, NameTaken, VersionMismatch, FormValidationFailed }

public sealed record FormResult<T>(T? Value, FormError? Error, IReadOnlyList<string> Details, IReadOnlyList<FormIssue> Issues)
{
    public bool IsSuccess => Error is null;
}

public static class FormResult
{
    public static FormResult<T> Ok<T>(T value) => new(value, null, [], []);

    public static FormResult<T> Fail<T>(FormError error, params string[] details) => new(default, error, details, []);

    public static FormResult<T> Invalid<T>(FormError error, IReadOnlyList<FormIssue> issues) => new(default, error, [], issues);
}

public sealed record FormSummary(Guid Id, string Name, string? Description, int? LatestVersion, DateTimeOffset DraftUpdatedAt);

public sealed record FormView(Guid Id, string Name, string? Description, int? LatestVersion, DateTimeOffset DraftUpdatedAt, uint Version, JsonElement Draft);

public sealed record FormVersionSummary(int VersionNumber, string ContentHash, DateTimeOffset PublishedAt, Guid PublishedBy);

public sealed record FormVersionView(int VersionNumber, string ContentHash, DateTimeOffset PublishedAt, JsonElement Document);

public sealed record FormPublishOutcome(int VersionNumber, string ContentHash, bool Created);

public sealed record FormValidationReport(bool Valid, IReadOnlyList<FormIssue> Errors);

public sealed record SubmissionReport(bool Valid, IReadOnlyList<FieldError> Errors, JsonElement Values);

/// <summary>Form definitions: drafts, validation, publishing, versions and test submissions (forms.md §F1).</summary>
public sealed class FormModelingService(IFormStore store, IKnownFileSource files, IModelingAuthorization authorization, EvaluationZone zone, TimeProvider time)
{
    public const int MaxSubmissionBytes = 256 * 1024;

    public Task<FormResult<IReadOnlyList<FormSummary>>> ListAsync(Guid actorId, CancellationToken cancellationToken) =>
        AsModeler<IReadOnlyList<FormSummary>>(actorId, async ct =>
            FormResult.Ok<IReadOnlyList<FormSummary>>([.. (await store.ListDefinitionsAsync(ct)).Select(d => new FormSummary(d.Id, d.Name, d.Description, d.LatestVersion, d.DraftUpdatedAt))]),
            cancellationToken);

    public async Task<FormResult<FormView>> CreateAsync(Guid actorId, string? rawName, string? description, CancellationToken cancellationToken)
    {
        if (!FormName.TryCreate(rawName, out var name))
        {
            return FormResult.Fail<FormView>(FormError.ValidationFailed, "invalid_name");
        }

        if (description?.Trim().Length > FormDefinition.MaxDescriptionLength)
        {
            return FormResult.Fail<FormView>(FormError.ValidationFailed, "description_too_long");
        }

        if (!ClientText.IsStorable(description))
        {
            return FormResult.Fail<FormView>(FormError.ValidationFailed, "invalid_description");
        }

        try
        {
            return await AsModeler(actorId, async ct =>
            {
                if (await store.DefinitionNameExistsAsync(name.Normalized, null, ct))
                {
                    return FormResult.Fail<FormView>(FormError.NameTaken);
                }

                var now = time.GetUtcNow();
                var definition = FormDefinition.Create(name, description, actorId, now);
                store.Add(definition);
                Audit("form.created", actorId, definition.Id, now, ("name", definition.Name));
                await store.SaveChangesAsync(ct);
                return FormResult.Ok(View(definition));
            }, cancellationToken);
        }
        catch (UniqueConstraintViolationException)
        {
            return FormResult.Fail<FormView>(FormError.NameTaken);
        }
    }

    public Task<FormResult<FormView>> GetAsync(Guid actorId, Guid id, CancellationToken cancellationToken) =>
        WithDefinition(actorId, id, null, (d, _) => Task.FromResult(FormResult.Ok(View(d))), cancellationToken);

    public async Task<FormResult<FormView>> UpdateAsync(Guid actorId, Guid id, uint expectedVersion, string? rawName, string? description, CancellationToken cancellationToken)
    {
        FormName name = default;
        if (rawName is not null && !FormName.TryCreate(rawName, out name))
        {
            return FormResult.Fail<FormView>(FormError.ValidationFailed, "invalid_name");
        }

        if (description?.Trim().Length > FormDefinition.MaxDescriptionLength)
        {
            return FormResult.Fail<FormView>(FormError.ValidationFailed, "description_too_long");
        }

        if (!ClientText.IsStorable(description))
        {
            return FormResult.Fail<FormView>(FormError.ValidationFailed, "invalid_description");
        }

        try
        {
            return await WithDefinition(actorId, id, expectedVersion, async (definition, ct) =>
            {
                if (rawName is not null && await store.DefinitionNameExistsAsync(name.Normalized, id, ct))
                {
                    return FormResult.Fail<FormView>(FormError.NameTaken);
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

                Audit("form.updated", actorId, id, now, ("name", definition.Name));
                await store.SaveChangesAsync(ct);
                return FormResult.Ok(View(definition));
            }, cancellationToken);
        }
        catch (UniqueConstraintViolationException)
        {
            return FormResult.Fail<FormView>(FormError.NameTaken);
        }
    }

    public Task<FormResult<FormView>> SaveDraftAsync(Guid actorId, Guid id, uint expectedVersion, string document, CancellationToken cancellationToken)
    {
        var parsed = FormDocumentParser.Parse(document);
        if (!parsed.IsSuccess)
        {
            return Task.FromResult(FormResult.Invalid<FormView>(FormError.InvalidDocument, [parsed.Error!]));
        }

        return WithDefinition(actorId, id, expectedVersion, async (definition, ct) =>
        {
            var now = time.GetUtcNow();
            definition.SaveDraft(document, actorId, now);
            Audit("form.draft_saved", actorId, id, now);
            await store.SaveChangesAsync(ct);
            return FormResult.Ok(View(definition));
        }, cancellationToken);
    }

    public Task<FormResult<FormValidationReport>> ValidateAsync(Guid actorId, Guid id, CancellationToken cancellationToken) =>
        WithDefinition(actorId, id, null, (definition, _) =>
        {
            var issues = Check(definition.Draft);
            return Task.FromResult(FormResult.Ok(new FormValidationReport(issues.Count == 0, issues)));
        }, cancellationToken);

    public async Task<FormResult<FormPublishOutcome>> PublishAsync(Guid actorId, Guid id, uint expectedVersion, CancellationToken cancellationToken)
    {
        try
        {
            return await WithDefinition(actorId, id, expectedVersion, async (definition, ct) =>
            {
                var issues = Check(definition.Draft);
                if (issues.Count > 0)
                {
                    return FormResult.Invalid<FormPublishOutcome>(FormError.FormValidationFailed, issues);
                }

                var canonical = ContentHash.Canonicalize(definition.Draft);
                var hash = ContentHash.ForCanonical(canonical);
                if (definition.LatestVersion is { } latestNumber && await store.FindVersionAsync(id, latestNumber, ct) is { } latest && latest.ContentHash == hash)
                {
                    return FormResult.Ok(new FormPublishOutcome(latestNumber, hash, Created: false));
                }

                var now = time.GetUtcNow();
                var number = definition.NextVersionNumber;
                store.Add(FormVersion.Create(id, number, canonical, hash, actorId, now));
                definition.RecordPublished(number, now);
                Audit("form.published", actorId, id, now, ("versionNumber", number.ToString(CultureInfo.InvariantCulture)), ("contentHash", hash));
                await store.SaveChangesAsync(ct);
                return FormResult.Ok(new FormPublishOutcome(number, hash, Created: true));
            }, cancellationToken);
        }
        catch (UniqueConstraintViolationException ex)
        {
            throw new ConcurrencyConflictException(ex);
        }
    }

    public Task<FormResult<IReadOnlyList<FormVersionSummary>>> ListVersionsAsync(Guid actorId, Guid id, CancellationToken cancellationToken) =>
        WithDefinition<IReadOnlyList<FormVersionSummary>>(actorId, id, null, async (_, ct) =>
            FormResult.Ok<IReadOnlyList<FormVersionSummary>>([.. (await store.ListVersionsAsync(id, ct)).Select(v => new FormVersionSummary(v.VersionNumber, v.ContentHash, v.PublishedAt, v.PublishedBy))]),
            cancellationToken);

    public Task<FormResult<FormVersionView>> GetVersionAsync(Guid actorId, Guid id, int versionNumber, CancellationToken cancellationToken) =>
        WithDefinition(actorId, id, null, async (_, ct) =>
            await store.FindVersionAsync(id, versionNumber, ct) is { } version
                ? FormResult.Ok(new FormVersionView(version.VersionNumber, version.ContentHash, version.PublishedAt, Json(version.Document)))
                : FormResult.Fail<FormVersionView>(FormError.NotFound),
            cancellationToken);

    public Task<FormResult<FormView>> RestoreAsync(Guid actorId, Guid id, int versionNumber, uint expectedVersion, CancellationToken cancellationToken) =>
        WithDefinition(actorId, id, expectedVersion, async (definition, ct) =>
        {
            if (await store.FindVersionAsync(id, versionNumber, ct) is not { } version)
            {
                return FormResult.Fail<FormView>(FormError.NotFound);
            }

            var now = time.GetUtcNow();
            definition.SaveDraft(version.Document, actorId, now);
            Audit("form.restored", actorId, id, now, ("fromVersion", versionNumber.ToString(CultureInfo.InvariantCulture)));
            await store.SaveChangesAsync(ct);
            return FormResult.Ok(View(definition));
        }, cancellationToken);

    /// <summary>Validates a sample submission against a published version without storing anything (forms.md §F1).</summary>
    public Task<FormResult<SubmissionReport>> ValidateSubmissionAsync(Guid actorId, Guid id, int versionNumber, string submission, CancellationToken cancellationToken)
    {
        if (System.Text.Encoding.UTF8.GetByteCount(submission) > MaxSubmissionBytes)
        {
            return Task.FromResult(FormResult.Fail<SubmissionReport>(FormError.ValidationFailed, "payload_too_large"));
        }

        return WithDefinition(actorId, id, null, async (_, ct) =>
        {
            if (await store.FindVersionAsync(id, versionNumber, ct) is not { } version)
            {
                return FormResult.Fail<SubmissionReport>(FormError.NotFound);
            }

            var form = FormDocumentParser.Parse(version.Document).Document!;
            using var json = JsonDocument.Parse(submission);
            if (!ClientText.IsUnicode(json.RootElement))
            {
                // A submission whose text is not Unicode can't be read: one error at the empty key, as the engine gives (card #129).
                return FormResult.Ok(new SubmissionReport(false, [new FieldError(string.Empty, "invalid_value")], JsonSerializer.SerializeToElement(new { })));
            }

            var known = await files.FindAsync(FileRules.CollectIds(json.RootElement), ct);
            var result = SubmissionProcessor.Process(form, json.RootElement, SubmissionProcessor.EmptyObject, time.GetUtcNow(), zone.Offset, actorId, known, FileRules.MaxFiles);
            return FormResult.Ok(new SubmissionReport(result.Errors.Count == 0, result.Errors, JsonSerializer.SerializeToElement(result.Values)));
        }, cancellationToken);
    }

    // Helpers

    private static List<FormIssue> Check(string draft)
    {
        var parsed = FormDocumentParser.Parse(draft);
        return parsed.IsSuccess ? [.. FormValidator.Validate(parsed.Document!)] : [parsed.Error!];
    }

    private Task<FormResult<T>> AsModeler<T>(Guid actorId, Func<CancellationToken, Task<FormResult<T>>> work, CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
            await authorization.CanModelAsync(actorId, ct) ? await work(ct) : FormResult.Fail<T>(FormError.Forbidden),
            cancellationToken);

    private Task<FormResult<T>> WithDefinition<T>(
        Guid actorId, Guid id, uint? expectedVersion, Func<FormDefinition, CancellationToken, Task<FormResult<T>>> work, CancellationToken cancellationToken) =>
        AsModeler(actorId, async ct =>
        {
            var definition = await store.FindDefinitionAsync(id, ct);
            if (definition is null)
            {
                return FormResult.Fail<T>(FormError.NotFound);
            }

            if (expectedVersion is { } version)
            {
                if (store.VersionOf(definition) != version)
                {
                    return FormResult.Fail<T>(FormError.VersionMismatch);
                }

                store.ExpectVersion(definition, version);
            }

            return await work(definition, ct);
        }, cancellationToken);

    private FormView View(FormDefinition d) => new(d.Id, d.Name, d.Description, d.LatestVersion, d.DraftUpdatedAt, store.VersionOf(d), Json(d.Draft));

    private static JsonElement Json(string document)
    {
        using var parsed = JsonDocument.Parse(document);
        return parsed.RootElement.Clone();
    }

    private void Audit(string action, Guid actorId, Guid subjectId, DateTimeOffset now, params (string Key, string? Value)[] details) =>
        store.Audit(new AuditRecord(action, actorId, subjectId, details.ToDictionary(d => d.Key, d => d.Value)), now);
}
