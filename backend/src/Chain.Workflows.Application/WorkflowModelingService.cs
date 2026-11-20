using System.Text.Json;
using Chain.SharedKernel;
using Chain.Workflows.Definitions;
using Chain.Workflows.Modeling;

namespace Chain.Workflows.Application;

public enum ModelingError
{
    Forbidden,
    NotFound,
    ValidationFailed,
    InvalidDocument,
    NameTaken,
    VersionMismatch,
    PublishValidationFailed,
    InvalidGrants,
}

/// <summary>Outcome of a modeling use case: a value, or an error with optional details or validation findings.</summary>
public sealed record ModelingResult<T>(T? Value, ModelingError? Error, IReadOnlyList<string> Details, IReadOnlyList<ValidationError> Findings)
{
    public bool IsSuccess => Error is null;
}

public static class ModelingResult
{
    public static ModelingResult<T> Ok<T>(T value) => new(value, null, [], []);

    public static ModelingResult<T> Fail<T>(ModelingError error, params string[] details) => new(default, error, details, []);

    public static ModelingResult<T> Invalid<T>(ModelingError error, IReadOnlyList<ValidationError> findings) => new(default, error, [], findings);
}

public sealed record DefinitionSummary(Guid Id, string Name, string? Description, bool IsActive, int? LatestVersion, DateTimeOffset DraftUpdatedAt);

public sealed record DefinitionView(
    Guid Id, string Name, string? Description, bool IsActive, int? LatestVersion, DateTimeOffset DraftUpdatedAt, uint Version, JsonElement Draft);

public sealed record VersionSummary(int VersionNumber, string ContentHash, DateTimeOffset PublishedAt, Guid PublishedBy);

public sealed record VersionView(int VersionNumber, string ContentHash, DateTimeOffset PublishedAt, JsonElement Document);

public sealed record PublishOutcome(int VersionNumber, string ContentHash, bool Created);

public sealed record ValidationReport(bool Valid, IReadOnlyList<ValidationError> Errors);

public sealed record CatalogEntryView(IReadOnlyList<string> Path, string Type, string Presence, IReadOnlyList<string> Sources)
{
    /// <summary>The entry's key is sensitive (sensitive-data.md §2); left out when false, so other entries are as they were.</summary>
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
    public bool Sensitive { get; init; }
}

public sealed record NodeCatalogView(string NodeId, IReadOnlyList<CatalogEntryView> Entries);

/// <summary>A start-form field a parent's mapping can send to a sub-workflow (workflow-definition.md §6.5).</summary>
public sealed record ContractInputView(string Key, string Type, bool Required);

/// <summary>What a version takes and gives as a sub-workflow; <paramref name="Inputs"/> is null when it has no start form.</summary>
public sealed record VersionContractView(int VersionNumber, IReadOnlyList<ContractInputView>? Inputs, IReadOnlyList<CatalogEntryView> Outputs);

public sealed record DataCatalogView(IReadOnlyList<NodeCatalogView> Nodes);

public sealed record GrantView(Guid GroupId, string GroupName, IReadOnlyList<string> Capabilities);

/// <summary>The grants after a replace, and the process's new version: the change touches it (admin-ui.md §8, S-A2).</summary>
public sealed record GrantsReplaced(IReadOnlyList<GrantView> Grants, uint Version);

public sealed record GrantInput(Guid GroupId, IReadOnlyList<string>? Capabilities);

/// <summary>A group a lane can be given (workflow-editor.md §10.6): its id and name only.</summary>
public sealed record LaneGroup(Guid Id, string Name);

/// <summary>Workflow definitions: drafts, validation, publishing, versions and grants (workflow-definition.md §5).</summary>
public sealed class WorkflowModelingService(
    IWorkflowStore store, IModelingAuthorization authorization, IGroupDirectory groups, IFormDirectory forms, IAutomationDirectory automations,
    TimeProvider time)
{
    public Task<ModelingResult<IReadOnlyList<DefinitionSummary>>> ListAsync(Guid actorId, CancellationToken cancellationToken) =>
        AsModeler<IReadOnlyList<DefinitionSummary>>(actorId, async ct =>
            ModelingResult.Ok<IReadOnlyList<DefinitionSummary>>([.. (await store.ListDefinitionsAsync(ct)).Select(Summary)]), cancellationToken);

    /// <summary>The active groups, by name, for the lane panel's group select (workflow-definition.md §5.5).</summary>
    public Task<ModelingResult<IReadOnlyList<LaneGroup>>> ListLaneGroupsAsync(Guid actorId, CancellationToken cancellationToken) =>
        AsModeler<IReadOnlyList<LaneGroup>>(actorId, async ct =>
            ModelingResult.Ok<IReadOnlyList<LaneGroup>>([.. (await groups.ListActiveAsync(ct)).Select(group => new LaneGroup(group.Id, group.Name))]),
            cancellationToken);

    public async Task<ModelingResult<DefinitionView>> CreateAsync(Guid actorId, string? rawName, string? description, CancellationToken cancellationToken)
    {
        if (!WorkflowName.TryCreate(rawName, out var name))
        {
            return ModelingResult.Fail<DefinitionView>(ModelingError.ValidationFailed, "invalid_name");
        }

        if (description?.Trim().Length > WorkflowDefinition.MaxDescriptionLength)
        {
            return ModelingResult.Fail<DefinitionView>(ModelingError.ValidationFailed, "description_too_long");
        }

        if (!ClientText.IsStorable(description))
        {
            return ModelingResult.Fail<DefinitionView>(ModelingError.ValidationFailed, "invalid_description");
        }

        try
        {
            return await AsModeler(actorId, async ct =>
            {
                if (await store.DefinitionNameExistsAsync(name.Normalized, null, ct))
                {
                    return ModelingResult.Fail<DefinitionView>(ModelingError.NameTaken);
                }

                var now = time.GetUtcNow();
                var definition = WorkflowDefinition.Create(name, description, actorId, now);
                store.Add(definition);
                Audit("workflow.created", actorId, definition.Id, now, ("name", definition.Name));
                await store.SaveChangesAsync(ct);
                return ModelingResult.Ok(View(definition));
            }, cancellationToken);
        }
        catch (UniqueConstraintViolationException)
        {
            return ModelingResult.Fail<DefinitionView>(ModelingError.NameTaken);
        }
    }

    public Task<ModelingResult<DefinitionView>> GetAsync(Guid actorId, Guid id, CancellationToken cancellationToken) =>
        WithDefinition(actorId, id, null, (definition, _) => Task.FromResult(ModelingResult.Ok(View(definition))), cancellationToken);

    public async Task<ModelingResult<DefinitionView>> UpdateAsync(
        Guid actorId, Guid id, uint expectedVersion, string? rawName, string? description, CancellationToken cancellationToken)
    {
        WorkflowName name = default;
        if (rawName is not null && !WorkflowName.TryCreate(rawName, out name))
        {
            return ModelingResult.Fail<DefinitionView>(ModelingError.ValidationFailed, "invalid_name");
        }

        if (description?.Trim().Length > WorkflowDefinition.MaxDescriptionLength)
        {
            return ModelingResult.Fail<DefinitionView>(ModelingError.ValidationFailed, "description_too_long");
        }

        if (!ClientText.IsStorable(description))
        {
            return ModelingResult.Fail<DefinitionView>(ModelingError.ValidationFailed, "invalid_description");
        }

        try
        {
            return await WithDefinition(actorId, id, expectedVersion, async (definition, ct) =>
            {
                if (rawName is not null && await store.DefinitionNameExistsAsync(name.Normalized, id, ct))
                {
                    return ModelingResult.Fail<DefinitionView>(ModelingError.NameTaken);
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

                Audit("workflow.updated", actorId, definition.Id, now, ("name", definition.Name));
                await store.SaveChangesAsync(ct);
                return ModelingResult.Ok(View(definition));
            }, cancellationToken);
        }
        catch (UniqueConstraintViolationException)
        {
            return ModelingResult.Fail<DefinitionView>(ModelingError.NameTaken);
        }
    }

    /// <summary>Saves the draft. It only has to parse; structural problems are reported at validate/publish.</summary>
    public Task<ModelingResult<DefinitionView>> SaveDraftAsync(
        Guid actorId, Guid id, uint expectedVersion, string document, CancellationToken cancellationToken)
    {
        var parsed = WorkflowDocumentParser.Parse(document);
        if (!parsed.IsSuccess)
        {
            return Task.FromResult(ModelingResult.Invalid<DefinitionView>(ModelingError.InvalidDocument, [parsed.Error!]));
        }

        return WithDefinition(actorId, id, expectedVersion, async (definition, ct) =>
        {
            var now = time.GetUtcNow();
            definition.SaveDraft(document, actorId, now);
            Audit("workflow.draft_saved", actorId, definition.Id, now);
            await store.SaveChangesAsync(ct);
            return ModelingResult.Ok(View(definition));
        }, cancellationToken);
    }

    public Task<ModelingResult<ValidationReport>> ValidateAsync(Guid actorId, Guid id, CancellationToken cancellationToken) =>
        WithDefinition(actorId, id, null, async (definition, ct) =>
        {
            var (errors, _) = await CheckAsync(definition, ct);
            return ModelingResult.Ok(new ValidationReport(errors.Count == 0, errors));
        }, cancellationToken);

    /// <summary>Validates and publishes the draft as a new immutable version with pinned references (ADR-0004).</summary>
    public async Task<ModelingResult<PublishOutcome>> PublishAsync(Guid actorId, Guid id, uint expectedVersion, CancellationToken cancellationToken)
    {
        try
        {
            return await WithDefinition(actorId, id, expectedVersion, async (definition, ct) =>
            {
                var (errors, pins) = await CheckAsync(definition, ct);
                if (errors.Count > 0)
                {
                    return ModelingResult.Invalid<PublishOutcome>(ModelingError.PublishValidationFailed, errors);
                }

                var canonical = ContentHash.Canonicalize(ReferencePins.Pin(definition.Draft, pins.Subprocesses, pins.Forms, pins.Automations));
                var hash = ContentHash.ForCanonical(canonical);
                if (definition.LatestVersion is { } latestNumber
                    && await store.FindVersionAsync(id, latestNumber, ct) is { } latest
                    && latest.ContentHash == hash)
                {
                    return ModelingResult.Ok(new PublishOutcome(latestNumber, hash, Created: false));
                }

                var now = time.GetUtcNow();
                var number = definition.NextVersionNumber;
                store.Add(WorkflowVersion.Create(id, number, canonical, hash, actorId, now, pins.SensitiveKeys));
                definition.RecordPublished(number, now);
                Audit("workflow.published", actorId, id, now, ("versionNumber", number.ToString(System.Globalization.CultureInfo.InvariantCulture)), ("contentHash", hash));
                await store.SaveChangesAsync(ct);
                return ModelingResult.Ok(new PublishOutcome(number, hash, Created: true));
            }, cancellationToken);
        }
        catch (UniqueConstraintViolationException ex)
        {
            // Two publishes raced for the same version number; the definition's version check makes the loser retry.
            throw new ConcurrencyConflictException(ex);
        }
    }

    public Task<ModelingResult<bool>> SetActiveAsync(Guid actorId, Guid id, bool active, CancellationToken cancellationToken) =>
        WithDefinition(actorId, id, null, (definition, _) =>
        {
            var now = time.GetUtcNow();
            if (active)
            {
                definition.Activate(now);
            }
            else
            {
                definition.Deactivate(now);
            }

            Audit(active ? "workflow.activated" : "workflow.deactivated", actorId, id, now);
            return Task.FromResult(ModelingResult.Ok(true));
        }, cancellationToken);

    public Task<ModelingResult<IReadOnlyList<VersionSummary>>> ListVersionsAsync(Guid actorId, Guid id, CancellationToken cancellationToken) =>
        WithDefinition<IReadOnlyList<VersionSummary>>(actorId, id, null, async (_, ct) =>
            ModelingResult.Ok<IReadOnlyList<VersionSummary>>(
                [.. (await store.ListVersionsAsync(id, ct)).Select(v => new VersionSummary(v.VersionNumber, v.ContentHash, v.PublishedAt, v.PublishedBy))]),
            cancellationToken);

    public Task<ModelingResult<VersionView>> GetVersionAsync(Guid actorId, Guid id, int versionNumber, CancellationToken cancellationToken) =>
        WithDefinition(actorId, id, null, async (_, ct) =>
            await store.FindVersionAsync(id, versionNumber, ct) is { } version
                ? ModelingResult.Ok(new VersionView(version.VersionNumber, version.ContentHash, version.PublishedAt, Json(version.Document)))
                : ModelingResult.Fail<VersionView>(ModelingError.NotFound),
            cancellationToken);

    /// <summary>Copies a published version into the draft with its pins removed (ADR-0004 §6).</summary>
    public Task<ModelingResult<DefinitionView>> RestoreAsync(
        Guid actorId, Guid id, int versionNumber, uint expectedVersion, CancellationToken cancellationToken) =>
        WithDefinition(actorId, id, expectedVersion, async (definition, ct) =>
        {
            if (await store.FindVersionAsync(id, versionNumber, ct) is not { } version)
            {
                return ModelingResult.Fail<DefinitionView>(ModelingError.NotFound);
            }

            var now = time.GetUtcNow();
            definition.SaveDraft(ReferencePins.Unpin(version.Document), actorId, now);
            Audit("workflow.restored", actorId, id, now, ("fromVersion", versionNumber.ToString(System.Globalization.CultureInfo.InvariantCulture)));
            await store.SaveChangesAsync(ct);
            return ModelingResult.Ok(View(definition));
        }, cancellationToken);

    public Task<ModelingResult<IReadOnlyList<GrantView>>> GetGrantsAsync(Guid actorId, Guid id, CancellationToken cancellationToken) =>
        WithDefinition(actorId, id, null, async (_, ct) => ModelingResult.Ok(await GrantViewsAsync(id, ct)), cancellationToken);

    public Task<ModelingResult<GrantsReplaced>> ReplaceGrantsAsync(
        Guid actorId, Guid id, uint expectedVersion, IReadOnlyList<GrantInput>? input, CancellationToken cancellationToken) =>
        WithDefinition(actorId, id, expectedVersion, async (definition, ct) =>
        {
            var grants = new List<WorkflowGrant>();
            var problems = new List<string>();
            foreach (var item in input ?? [])
            {
                foreach (var raw in item.Capabilities ?? [])
                {
                    if (Enum.TryParse<WorkflowCapability>(raw, ignoreCase: true, out var capability) && Enum.IsDefined(capability) && raw.All(char.IsLetter))
                    {
                        grants.Add(WorkflowGrant.Create(id, item.GroupId, capability));
                    }
                    else
                    {
                        problems.Add($"unknown_capability:{raw}");
                    }
                }
            }

            var groupIds = (input ?? []).Select(g => g.GroupId).Distinct().ToList();
            var known = await groups.GetGroupsAsync(groupIds, ct);
            problems.AddRange(groupIds.Where(g => !known.TryGetValue(g, out var state) || state.IsArchived).Select(g => $"unknown_or_archived_group:{g}"));
            if (problems.Count > 0)
            {
                return ModelingResult.Fail<GrantsReplaced>(ModelingError.InvalidGrants, [.. problems]);
            }

            var now = time.GetUtcNow();
            await store.ReplaceGrantsAsync(id, [.. grants.DistinctBy(g => (g.GroupId, g.Capability))], ct);
            definition.Touch(now);
            Audit("workflow.grants_changed", actorId, id, now, ("grants", string.Join(';', grants.Select(g => $"{g.GroupId}:{g.Capability}"))));
            await store.SaveChangesAsync(ct);
            return ModelingResult.Ok(new GrantsReplaced(await GrantViewsAsync(id, ct), store.VersionOf(definition)));
        }, cancellationToken);

    // Publish checks

    /// <summary>Structural rules (WF000–WF019, WF109) plus reference rules (WF101–WF110); also returns the versions to pin.</summary>
    private async Task<(List<ValidationError> Errors, Pins Pinned)> CheckAsync(WorkflowDefinition definition, CancellationToken cancellationToken)
    {
        var parsed = WorkflowDocumentParser.Parse(definition.Draft);
        if (!parsed.IsSuccess)
        {
            return ([parsed.Error!], new Pins([], [], []));
        }

        var (errors, pinned, catalog) = await ResolveAsync(definition, parsed.Document!, cancellationToken);
        errors.AddRange(catalog.TypeErrors);
        return (errors, pinned);
    }

    /// <summary>The data catalog of the current draft (workflow-definition.md §6.5), with references resolved as publishing would pin them.</summary>
    public Task<ModelingResult<DataCatalogView>> GetDataCatalogAsync(Guid actorId, Guid id, CancellationToken cancellationToken) =>
        WithDefinition(actorId, id, null, async (definition, ct) =>
        {
            var parsed = WorkflowDocumentParser.Parse(definition.Draft);
            if (!parsed.IsSuccess)
            {
                return ModelingResult.Invalid<DataCatalogView>(ModelingError.InvalidDocument, [parsed.Error!]);
            }

            var (_, pinned, catalog) = await ResolveAsync(definition, parsed.Document!, ct);
            var sensitive = pinned.SensitiveKeys.ToHashSet(StringComparer.Ordinal);
            return ModelingResult.Ok(new DataCatalogView([.. parsed.Document!.Nodes
                .Where(n => catalog.At(n.Id) is not null)
                .DistinctBy(n => n.Id)
                .Select(n => new NodeCatalogView(n.Id, [.. DataCatalog.Entries(catalog.At(n.Id)!)
                    .Select(e => new CatalogEntryView(e.Path, e.Type, e.Definite ? "definite" : "optional", e.Sources)
                    {
                        Sensitive = sensitive.Contains(e.Path[0]), // a nested entry follows its top-level key (sensitive-data.md §2)
                    })]))]));
        }, cancellationToken);

    /// <summary>
    /// What a published version takes and gives as a sub-workflow (workflow-definition.md §6.5): its start form's fields that
    /// accept a value, in the form's order, and its catalog at completion. The *Subprocesso* panel maps against it.
    /// </summary>
    public Task<ModelingResult<VersionContractView>> GetVersionContractAsync(Guid actorId, Guid id, int versionNumber, CancellationToken cancellationToken) =>
        WithDefinition(actorId, id, null, async (_, ct) =>
        {
            var resolver = new ContractResolver(store, forms, automations, ct);
            if (await store.FindVersionAsync(id, versionNumber, ct) is not { } version
                || WorkflowDocumentParser.Parse(version.Document) is not { IsSuccess: true } parsed
                || await resolver.SubworkflowAsync(id, versionNumber) is not { } contract)
            {
                return ModelingResult.Fail<VersionContractView>(ModelingError.NotFound);
            }

            var start = parsed.Document!.Nodes.FirstOrDefault(n => n.Type == NodeType.Start);
            var form = await resolver.FormAsync(start?.Form?.FormId, start?.Form?.Version);
            List<ContractInputView>? inputs = null;
            if (form is not null && contract.StartFields is { } accepted)
            {
                inputs = [.. form.Components
                    .Where(c => c.ProducesValue && c.Key is not null && accepted.GetValueOrDefault(c.Key) is not null)
                    .Select(c => new ContractInputView(c.Key!, accepted[c.Key!]!.ToString(), c.Validate?.Required ?? false))];
            }

            return ModelingResult.Ok(new VersionContractView(
                versionNumber,
                inputs,
                [.. DataCatalog.Entries(contract.Completion).Select(e => new CatalogEntryView(e.Path, e.Type, e.Definite ? "definite" : "optional", e.Sources))]));
        }, cancellationToken);

    private sealed record Pins(Dictionary<string, int> Subprocesses, Dictionary<string, int> Forms, Dictionary<string, int> Automations)
    {
        /// <summary>The union of the pinned forms' sensitive keys, which publishing records (sensitive-data.md §2).</summary>
        public IReadOnlyList<string> SensitiveKeys { get; init; } = [];
    }

    /// <summary>Structural and reference rules, the versions to pin, and the data catalog over those versions.</summary>
    private async Task<(List<ValidationError> Errors, Pins Pinned, DataCatalog Catalog)> ResolveAsync(
        WorkflowDefinition definition, WorkflowDocument document, CancellationToken cancellationToken)
    {
        var pins = new Dictionary<string, int>(StringComparer.Ordinal);
        var formPins = new Dictionary<string, int>(StringComparer.Ordinal);
        var automationPins = new Dictionary<string, int>(StringComparer.Ordinal);
        var errors = WorkflowValidator.Validate(document).ToList();

        var laneGroups = document.Lanes.Where(l => l.Group is { Kind: LaneGroupKind.Group, GroupId: not null }).ToList();
        var known = await groups.GetGroupsAsync([.. laneGroups.Select(l => l.Group.GroupId!.Value).Distinct()], cancellationToken);
        foreach (var lane in laneGroups)
        {
            if (!known.TryGetValue(lane.Group.GroupId!.Value, out var group))
            {
                errors.Add(new ValidationError("WF101", "The lane's group does not exist.", lane.Id));
            }
            else if (group.IsArchived)
            {
                errors.Add(new ValidationError("WF102", $"The lane's group '{group.Name}' is archived.", lane.Id));
            }
        }

        foreach (var node in document.Nodes)
        {
            if (node.Form is { } formReference)
            {
                if (Guid.TryParse(formReference.FormId, out var formId) && await forms.LatestPublishedVersionAsync(formId, cancellationToken) is { } formVersion)
                {
                    formPins[formReference.FormId] = formVersion;
                }
                else
                {
                    errors.Add(new ValidationError("WF103", "The form does not exist or has no published version.", node.Id));
                }
            }

            if (node.Automation is { } automationReference)
            {
                if (Guid.TryParse(automationReference.AutomationId, out var automationId)
                    && await automations.LatestPublishedAsync(automationId, cancellationToken) is { } automation)
                {
                    automationPins[automationReference.AutomationId] = automation.Version;
                    errors.AddRange(AutomationStepRules.Check(node, automationReference, automation));
                }
                else
                {
                    errors.Add(new ValidationError("WF104", "The automation does not exist or has no published version.", node.Id));
                }
            }

            if (node.Workflow is { } reference)
            {
                if (Guid.TryParse(reference.WorkflowId, out var childId) && childId == definition.Id)
                {
                    errors.Add(new ValidationError("WF106", "A workflow cannot call itself.", node.Id));
                }
                else if (Guid.TryParse(reference.WorkflowId, out childId)
                    && await store.FindDefinitionAsync(childId, cancellationToken) is { LatestVersion: { } latest })
                {
                    pins[reference.WorkflowId] = latest;
                }
                else
                {
                    errors.Add(new ValidationError("WF105", "The sub-workflow does not exist or has no published version.", node.Id));
                }
            }
        }

        var resolver = new ContractResolver(store, forms, automations, cancellationToken);
        var contracts = await resolver.ContractsAsync(
            document,
            node => node.Form is { } f && formPins.TryGetValue(f.FormId, out var v) ? v : null,
            node => node.Workflow is { } w && pins.TryGetValue(w.WorkflowId, out var v) ? v : null,
            node => node.Automation is { } a && automationPins.TryGetValue(a.AutomationId, out var v) ? v : null,
            depth: 0);
        errors.AddRange(SensitiveRules.Check(document, contracts));
        return (errors, new Pins(pins, formPins, automationPins) { SensitiveKeys = contracts.SensitiveKeys() }, DataCatalog.Analyze(document, contracts));
    }

    // Helpers

    /// <summary>A capability's name in the API, in camelCase: <c>start</c>, <c>viewSensitive</c> (sensitive-data.md §3).</summary>
    private static string CapabilityName(WorkflowCapability capability)
    {
        var name = capability.ToString();
        return char.ToLowerInvariant(name[0]) + name[1..];
    }

    private Task<ModelingResult<T>> AsModeler<T>(Guid actorId, Func<CancellationToken, Task<ModelingResult<T>>> work, CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
            await authorization.CanModelAsync(actorId, ct) ? await work(ct) : ModelingResult.Fail<T>(ModelingError.Forbidden),
            cancellationToken);

    /// <summary>Authorizes, loads the definition and, when <paramref name="expectedVersion"/> is given, checks and guards its version.</summary>
    private Task<ModelingResult<T>> WithDefinition<T>(
        Guid actorId, Guid id, uint? expectedVersion, Func<WorkflowDefinition, CancellationToken, Task<ModelingResult<T>>> work,
        CancellationToken cancellationToken) =>
        AsModeler(actorId, async ct =>
        {
            var definition = await store.FindDefinitionAsync(id, ct);
            if (definition is null)
            {
                return ModelingResult.Fail<T>(ModelingError.NotFound);
            }

            if (expectedVersion is { } version)
            {
                if (store.VersionOf(definition) != version)
                {
                    return ModelingResult.Fail<T>(ModelingError.VersionMismatch);
                }

                store.ExpectVersion(definition, version);
            }

            return await work(definition, ct);
        }, cancellationToken);

    private async Task<IReadOnlyList<GrantView>> GrantViewsAsync(Guid id, CancellationToken cancellationToken)
    {
        var grants = await store.GetGrantsAsync(id, cancellationToken);
        var names = await groups.GetGroupsAsync([.. grants.Select(g => g.GroupId).Distinct()], cancellationToken);
        return [.. grants.GroupBy(g => g.GroupId).Select(g => new GrantView(
            g.Key,
            names.TryGetValue(g.Key, out var group) ? group.Name : string.Empty,
            [.. g.Select(x => CapabilityName(x.Capability)).Order(StringComparer.Ordinal)]))];
    }

    private static DefinitionSummary Summary(WorkflowDefinition d) =>
        new(d.Id, d.Name, d.Description, d.IsActive, d.LatestVersion, d.DraftUpdatedAt);

    private DefinitionView View(WorkflowDefinition d) =>
        new(d.Id, d.Name, d.Description, d.IsActive, d.LatestVersion, d.DraftUpdatedAt, store.VersionOf(d), Json(d.Draft));

    private static JsonElement Json(string document)
    {
        using var parsed = JsonDocument.Parse(document);
        return parsed.RootElement.Clone();
    }

    private void Audit(string action, Guid actorId, Guid subjectId, DateTimeOffset now, params (string Key, string? Value)[] details) =>
        store.Audit(new AuditRecord(action, actorId, subjectId, details.ToDictionary(d => d.Key, d => d.Value)), now);
}
