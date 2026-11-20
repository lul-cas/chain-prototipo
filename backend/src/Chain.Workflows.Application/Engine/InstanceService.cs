using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Chain.Automations;
using Chain.Expressions;
using Chain.Forms;
using Chain.SharedKernel;
using Chain.Workflows.Application.Files;
using Chain.Workflows.Definitions;
using Chain.Workflows.Files;
using Chain.Workflows.Modeling;
using Chain.Workflows.Runtime;

namespace Chain.Workflows.Application.Engine;

/// <summary>
/// The workflow engine (workflow-engine.md): start, tasks, decisions, assignment, close, visibility, inbox, timeline (E1);
/// forms, automatic gateways, faults (E2); sub-workflows (E3).
/// </summary>
public sealed class InstanceService(
    IInstanceStore store, IActorDirectory directory, IFormVersionSource forms, IFileStore files, IAutomationDirectory automations,
    InstanceAccess access, EvaluationZone zone, TimeProvider time, FileSettings fileSettings, IRequestChannel channel)
{
    /// <summary>More consecutive automatic steps than this in one command fault the instance (workflow-engine.md §13.2).</summary>
    public const int MaxAutomaticSteps = 100;

    /// <summary>How often the watchdog runs (automation.md §6.7, AU-8), and how many requests one pass handles.</summary>
    public static readonly TimeSpan WatchdogInterval = TimeSpan.FromSeconds(15);

    public const int WatchdogBatch = 100;

    /// <summary>How long an <c>Idempotency-Key</c> replays its first result (ADR-0008 §4, workflow-engine.md §15.4).</summary>
    public static readonly TimeSpan IdempotencyWindow = TimeSpan.FromHours(24);

    /// <summary>Children nest at most this deep (workflow-engine.md §14.2).</summary>
    public const int MaxDepth = 10;

    private static readonly JsonSerializerOptions ResultJson = new(JsonSerializerDefaults.Web);

    // Queries

    public Task<IReadOnlyList<StartableWorkflow>> ListStartableAsync(Guid actorId, CancellationToken cancellationToken) =>
        store.InTransactionAsync<IReadOnlyList<StartableWorkflow>>(async ct =>
        {
            if (await directory.GetActorAsync(actorId, ct) is not { IsActive: true } actor)
            {
                return [];
            }

            var startable = await store.DefinitionsGrantedAsync(actor.ActiveGroupIds, WorkflowCapability.Start, ct);
            return [.. (await store.ListActiveDefinitionsAsync(startable, ct))
                .Where(d => d.LatestVersion is not null)
                .Select(d => new StartableWorkflow(d.Id, d.Name, d.Description, d.LatestVersion!.Value))];
        }, cancellationToken);

    /// <summary>
    /// The start form pinned by the latest version of a workflow the caller can start (workflow-engine.md §13.1).
    /// Workflows the caller can't start, or that aren't startable, return <see cref="EngineError.NotFound"/>, like the startable list.
    /// </summary>
    public Task<EngineResult<StartFormView>> GetStartFormAsync(Guid actorId, Guid definitionId, CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
        {
            var actor = await directory.GetActorAsync(actorId, ct);
            var definition = await store.FindDefinitionAsync(definitionId, ct);
            if (actor is not { IsActive: true } || definition is not { IsActive: true, LatestVersion: { } versionNumber }
                || !await store.HasCapabilityAsync(definitionId, actor.ActiveGroupIds, WorkflowCapability.Start, ct))
            {
                return EngineResult.Fail<StartFormView>(EngineError.NotFound);
            }

            var start = (await NavigatorAsync(definitionId, versionNumber, ct)).StartNode;
            TaskFormView? form = null;
            if (start.Form is { Version: { } version } reference && Guid.TryParse(reference.FormId, out var formId)
                && await forms.GetDocumentAsync(formId, version, ct) is { } document)
            {
                form = new TaskFormView(formId, version, Json(document));
            }

            return EngineResult.Ok(new StartFormView(definitionId, versionNumber, form));
        }, cancellationToken);

    public Task<EngineResult<InstanceView>> GetAsync(Guid actorId, Guid instanceId, CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
        {
            var actor = await directory.GetActorAsync(actorId, ct);
            var instance = await store.FindInstanceAsync(instanceId, ct);
            if (actor is null || instance is null || !await CanSeeAsync(actor, instance, ct))
            {
                return EngineResult.Fail<InstanceView>(EngineError.NotFound);
            }

            return EngineResult.Ok(await ViewAsync(instance, actor, ct));
        }, cancellationToken);

    /// <summary>The request's pinned version as a diagram, and the step it is at, for anyone who can see it (workflow-engine.md §9).</summary>
    public Task<EngineResult<DiagramView>> GetDiagramAsync(Guid actorId, Guid instanceId, CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
        {
            var actor = await directory.GetActorAsync(actorId, ct);
            var instance = await store.FindInstanceAsync(instanceId, ct);
            if (actor is null || instance is null || !await CanSeeAsync(actor, instance, ct)
                || await store.FindVersionAsync(instance.DefinitionId, instance.VersionNumber, ct) is not { } version)
            {
                return EngineResult.Fail<DiagramView>(EngineError.NotFound);
            }

            return EngineResult.Ok(new DiagramView(instance.DefinitionId, instance.VersionNumber, instance.CurrentNodeId, InstanceDiagram.Of(version.Document)));
        }, cancellationToken);

    public Task<IReadOnlyList<InstanceSummary>> ListAsync(Guid actorId, bool mineOnly, InstanceStatus? status, CancellationToken cancellationToken) =>
        store.InTransactionAsync<IReadOnlyList<InstanceSummary>>(async ct =>
        {
            if (await directory.GetActorAsync(actorId, ct) is not { } actor)
            {
                return [];
            }

            var viewable = (await store.DefinitionsGrantedAsync(actor.ActiveGroupIds, WorkflowCapability.View, ct))
                .Union(await store.DefinitionsGrantedAsync(actor.ActiveGroupIds, WorkflowCapability.Close, ct)).ToHashSet();
            var instances = await store.ListInstancesAsync(actor, viewable, mineOnly, status, ct);
            var requesters = await directory.GetActorsAsync([.. instances.Select(i => i.RequesterId).Distinct()], ct);
            return [.. instances.Select(i => new InstanceSummary(
                i.Id, i.DefinitionId, i.DefinitionName, i.VersionNumber, StatusName(i.Status), requesters[i.RequesterId], i.StartedAt, i.EndedAt))];
        }, cancellationToken);

    public Task<InboxView> GetInboxAsync(Guid actorId, CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
        {
            if (await directory.GetActorAsync(actorId, ct) is not { IsActive: true } actor)
            {
                return new InboxView([], [], []);
            }

            var entries = await store.GetInboxAsync(actor, ct);
            var actors = await directory.GetActorsAsync(
                [.. entries.SelectMany(e => new[] { e.Instance.RequesterId, e.Task.AssigneeId ?? Guid.Empty }).Where(id => id != Guid.Empty).Distinct()], ct);
            var groups = await directory.GetGroupsAsync([.. entries.Select(e => e.Task.GroupId).OfType<Guid>().Distinct()], ct);
            var items = entries.Select(e =>
            {
                var task = TaskViewOf(e.Task, actors, groups);
                return (e.Task, Item: new InboxItem(task.Id, task.InstanceId, task.NodeId, task.Label, task.Kind, task.Question, task.Group, task.Assignee,
                    task.CreatedAt, e.Instance.DefinitionName, actors[e.Instance.RequesterId]));
            }).ToList();
            return new InboxView(
                [.. items.Where(i => i.Task.AssigneeId == actorId).Select(i => i.Item)],
                [.. items.Where(i => i.Task.AssigneeId is null).Select(i => i.Item)],
                [.. items.Where(i => i.Task.AssigneeId is { } a && a != actorId).Select(i => i.Item)]);
        }, cancellationToken);

    // Commands

    public Task<EngineResult<InstanceView>> StartAsync(
        Guid actorId, Guid definitionId, JsonElement? data, Idempotency idempotency, CancellationToken cancellationToken) =>
        IdempotentAsync(actorId, idempotency, async ct =>
        {
            var actor = await directory.GetActorAsync(actorId, ct);
            var definition = await store.FindDefinitionAsync(definitionId, ct);
            if (actor is not { IsActive: true } || definition is null)
            {
                return EngineResult.Fail<InstanceView>(EngineError.NotFound);
            }

            if (!await store.HasCapabilityAsync(definitionId, actor.ActiveGroupIds, WorkflowCapability.Start, ct))
            {
                return EngineResult.Fail<InstanceView>(EngineError.Forbidden);
            }

            if (!definition.IsActive || definition.LatestVersion is not { } versionNumber)
            {
                return EngineResult.Fail<InstanceView>(EngineError.WorkflowNotStartable);
            }

            var navigator = await NavigatorAsync(definitionId, versionNumber, ct);
            var now = time.GetUtcNow();
            var submission = await ProcessAsync(navigator.StartNode, data, "{}", instanceId: null, actor.Id, now, ct);
            if (submission.Errors is { Count: > 0 } errors)
            {
                return EngineResult.InvalidSubmission<InstanceView>(errors);
            }

            var instance = Instance.Start(definitionId, definition.Name, versionNumber, actorId, navigator.StartNode.Id, now);
            store.Add(instance);
            Record(instance, "instance.started", actorId, null, null, now,
                ("definitionName", definition.Name), ("versionNumber", versionNumber));
            Store(instance, null, navigator.StartNode, submission, actorId, now);
            await AdvanceAsync(instance, navigator, navigator.Start(), now, ct);
            await store.SaveChangesAsync(ct);
            return EngineResult.Ok(await ViewAsync(instance, actor, ct));
        }, cancellationToken);

    public Task<EngineResult<TaskView>> StartWorkingAsync(Guid actorId, Guid taskId, Idempotency idempotency, CancellationToken cancellationToken) =>
        WithTaskAsync(actorId, taskId, idempotency, kind: null, async (actor, instance, task, now, ct) =>
        {
            if (task.AssigneeId is { } assignee && assignee != actorId)
            {
                return EngineResult.Fail<TaskView>(EngineError.TaskAssigned);
            }

            await LinkAsync(actor, instance, task, now, ct);
            await store.SaveChangesAsync(ct);
            return EngineResult.Ok(await TaskViewAsync(task, ct));
        }, cancellationToken);

    public Task<EngineResult<TaskView>> TakeOverAsync(Guid actorId, Guid taskId, Idempotency idempotency, CancellationToken cancellationToken) =>
        WithTaskAsync(actorId, taskId, idempotency, kind: null, async (actor, instance, task, now, ct) =>
        {
            if (task.AssigneeId is { } previous && previous != actorId)
            {
                task.AssignTo(actorId);
                await AddParticipantAsync(instance, actorId, now, ct);
                Record(instance, "task.taken_over", actorId, task.GroupId, task.Id, now, ("from", previous));
            }
            else
            {
                await LinkAsync(actor, instance, task, now, ct);
            }

            await store.SaveChangesAsync(ct);
            return EngineResult.Ok(await TaskViewAsync(task, ct));
        }, cancellationToken);

    public Task<EngineResult<InstanceView>> CompleteAsync(
        Guid actorId, Guid taskId, string? comment, JsonElement? data, Idempotency idempotency, CancellationToken cancellationToken) =>
        WithTaskAsync(actorId, taskId, idempotency, TaskKindAtNode.Task, async (actor, instance, task, now, ct) =>
        {
            if (comment?.Trim().Length > Instance.MaxJustificationLength)
            {
                return EngineResult.Fail<InstanceView>(EngineError.ValidationFailed, "comment_too_long");
            }

            if (!ClientText.IsStorable(comment))
            {
                return EngineResult.Fail<InstanceView>(EngineError.ValidationFailed, "invalid_comment");
            }

            if (task.AssigneeId is { } assignee && assignee != actorId)
            {
                return EngineResult.Fail<InstanceView>(EngineError.TaskAssigned);
            }

            var navigator = await NavigatorAsync(instance.DefinitionId, instance.VersionNumber, ct);
            var node = navigator.NodeById(task.NodeId);
            var submission = await ProcessAsync(node, data, instance.Data, instance.Id, actorId, now, ct);
            if (submission.Errors is { Count: > 0 } errors)
            {
                return EngineResult.InvalidSubmission<InstanceView>(errors); // nothing changes; the task stays open
            }

            await LinkOrRejectAsync(actor, instance, task, now, ct);
            Store(instance, task.Id, node, submission, actorId, now);
            task.Complete(actorId, now);
            Record(instance, "task.completed", actorId, task.GroupId, task.Id, now, ("comment", Normalize(comment)));
            await AdvanceAsync(instance, navigator, navigator.After(task.NodeId), now, ct);
            await NotifyParentAsync(instance, actorId, now, ct);
            await store.SaveChangesAsync(ct);
            return EngineResult.Ok(await ViewAsync(instance, actor, ct));
        }, cancellationToken);

    public Task<EngineResult<InstanceView>> DecideAsync(
        Guid actorId, Guid taskId, bool outcome, string? justification, Idempotency idempotency, CancellationToken cancellationToken) =>
        WithTaskAsync(actorId, taskId, idempotency, TaskKindAtNode.Decision, async (actor, instance, task, now, ct) =>
        {
            if (justification?.Trim().Length > Instance.MaxJustificationLength)
            {
                return EngineResult.Fail<InstanceView>(EngineError.ValidationFailed, "justification_too_long");
            }

            if (!ClientText.IsStorable(justification))
            {
                return EngineResult.Fail<InstanceView>(EngineError.ValidationFailed, "invalid_justification");
            }

            if (await LinkOrRejectAsync(actor, instance, task, now, ct) is { } rejected)
            {
                return EngineResult.Fail<InstanceView>(rejected);
            }

            task.Decide(actorId, outcome, now);
            Record(instance, "gateway.decided", actorId, task.GroupId, task.Id, now, ("outcome", outcome), ("justification", Normalize(justification)));
            var navigator = await NavigatorAsync(instance.DefinitionId, instance.VersionNumber, ct);
            await AdvanceAsync(instance, navigator, navigator.After(task.NodeId, outcome ? Branch.True : Branch.False), now, ct);
            await NotifyParentAsync(instance, actorId, now, ct);
            await store.SaveChangesAsync(ct);
            return EngineResult.Ok(await ViewAsync(instance, actor, ct));
        }, cancellationToken);

    public Task<EngineResult<InstanceView>> CloseAsync(
        Guid actorId, Guid instanceId, string? justification, Idempotency idempotency, CancellationToken cancellationToken)
    {
        var reason = Normalize(justification);
        if (reason is null || reason.Length > Instance.MaxJustificationLength)
        {
            return Task.FromResult(EngineResult.Fail<InstanceView>(EngineError.ValidationFailed, "justification_required"));
        }

        if (!ClientText.IsStorable(reason))
        {
            return Task.FromResult(EngineResult.Fail<InstanceView>(EngineError.ValidationFailed, "invalid_justification"));
        }

        return IdempotentAsync(actorId, idempotency, async ct =>
        {
            var actor = await directory.GetActorAsync(actorId, ct);
            var instance = await store.LockChainAsync(instanceId, ct); // serialize commands per request (§3, §14.2)
            if (actor is not { IsActive: true } || instance is null || !await CanSeeAsync(actor, instance, ct))
            {
                return EngineResult.Fail<InstanceView>(EngineError.NotFound);
            }

            var faulted = instance.Status == InstanceStatus.Faulted;
            if (!instance.IsRunning && !faulted)
            {
                return EngineResult.Fail<InstanceView>(EngineError.InstanceNotRunning);
            }

            var mayClose = instance.RequesterId == actorId
                || (faulted && actor.IsAdmin) // §13.3: admins resolve faulted requests
                || await store.HasCapabilityAsync(instance.DefinitionId, actor.ActiveGroupIds, WorkflowCapability.Close, ct);
            if (!mayClose)
            {
                return EngineResult.Fail<InstanceView>(EngineError.Forbidden);
            }

            var now = time.GetUtcNow();
            await CancelAsync(instance, actorId, now, ct, ("justification", reason));

            // Descendants go with it, top-down (§14.2); a cancelled request never faults its own parent from below.
            for (var current = instance; current.ChildInstanceId is { } childId;)
            {
                if (await store.LockInstanceAsync(childId, ct) is not { Status: InstanceStatus.Running or InstanceStatus.Faulted } child)
                {
                    break;
                }

                await CancelAsync(child, actorId, now, ct, ("cause", "parent_cancelled"), ("parentId", current.Id));
                current = child;
            }

            await NotifyParentAsync(instance, actorId, now, ct);
            await store.SaveChangesAsync(ct);
            return EngineResult.Ok(await ViewAsync(instance, actor, ct));
        }, cancellationToken);
    }

    public Task<EngineResult<InstanceView>> CommentAsync(
        Guid actorId, Guid instanceId, string? text, IReadOnlyList<Guid>? fileIds, Idempotency idempotency, CancellationToken cancellationToken)
    {
        var body = Normalize(text);
        var ids = fileIds ?? [];
        if (body is null && ids.Count == 0)
        {
            return Task.FromResult(EngineResult.Fail<InstanceView>(EngineError.ValidationFailed, "comment_empty"));
        }

        if (body is { Length: > Instance.MaxJustificationLength })
        {
            return Task.FromResult(EngineResult.Fail<InstanceView>(EngineError.ValidationFailed, "comment_too_long"));
        }

        if (!ClientText.IsStorable(body))
        {
            return Task.FromResult(EngineResult.Fail<InstanceView>(EngineError.ValidationFailed, "invalid_comment"));
        }

        if (ids.Count > fileSettings.MaxFiles)
        {
            return Task.FromResult(EngineResult.Fail<InstanceView>(EngineError.ValidationFailed, "too_many_files"));
        }

        if (ids.Distinct().Count() != ids.Count)
        {
            return Task.FromResult(EngineResult.Fail<InstanceView>(EngineError.ValidationFailed, "duplicate_file"));
        }

        return IdempotentAsync(actorId, idempotency, async ct =>
        {
            var actor = await directory.GetActorAsync(actorId, ct);
            var instance = await store.LockChainAsync(instanceId, ct);
            if (actor is not { IsActive: true } || instance is null || !await CanSeeAsync(actor, instance, ct))
            {
                return EngineResult.Fail<InstanceView>(EngineError.NotFound);
            }

            if (instance.Status is not (InstanceStatus.Running or InstanceStatus.Faulted))
            {
                return EngineResult.Fail<InstanceView>(EngineError.InstanceNotRunning);
            }

            var open = await store.GetOpenTasksAsync(instance.Id, ct);
            var eligible = open.Where(task => actor.IsEligibleFor(task, instance)).ToList();
            var holdsComment = await store.HasCapabilityAsync(instance.DefinitionId, actor.ActiveGroupIds, WorkflowCapability.Comment, ct);
            if (instance.RequesterId != actorId && eligible.Count == 0 && !holdsComment)
            {
                return EngineResult.Fail<InstanceView>(EngineError.Forbidden);
            }

            var locked = await files.LockAsync(ids, ct);
            if (locked.Count != ids.Count || locked.Any(file => file.Status != StoredFileStatus.Pending || file.UploadedBy != actorId))
            {
                return EngineResult.Fail<InstanceView>(EngineError.FileInvalid);
            }

            var now = time.GetUtcNow();
            foreach (var task in eligible)
            {
                if (task.AssigneeId is null)
                {
                    await LinkAsync(actor, instance, task, now, ct);
                }
            }

            var actedAs = eligible.Count > 0 ? eligible[0].GroupId : await store.CommentGroupAsync(instance.DefinitionId, actor.ActiveGroupIds, ct);
            var details = new Dictionary<string, object?> { ["fileIds"] = ids };
            if (body is not null)
            {
                details["text"] = body;
            }

            var comment = InstanceEvent.Create(instance, "comment.added", actorId, actedAs, null, details, now, channel.Current?.Name());
            store.Add(comment);
            foreach (var id in ids)
            {
                var file = locked.Single(item => item.Id == id);
                file.Attach(instance.Id, AttachmentTarget.Comment, comment.Id, now);
                Record(instance, "attachment.added", actorId, actedAs, null, now,
                    ("fileId", file.Id), ("name", file.OriginalName), ("size", file.SizeBytes), ("contentType", file.ContentType), ("commentId", comment.Id));
            }

            await store.SaveChangesAsync(ct);
            return EngineResult.Ok(await ViewAsync(instance, actor, ct));
        }, cancellationToken);
    }

    // Execution

    /// <summary>
    /// Moves the token until it waits or ends (workflow-engine.md §3, §13.2): automatic gateways are evaluated on the spot;
    /// an evaluation error or the step limit faults the instance with an incident. Returns the incident when one was opened.
    /// </summary>
    private async Task<InstanceIncident?> AdvanceAsync(Instance instance, FlowNavigator navigator, Arrival arrival, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var steps = 0;
        while (arrival is Arrival.Automatic or Arrival.Subprocess)
        {
            var node = arrival is Arrival.Automatic automatic ? automatic.Node : ((Arrival.Subprocess)arrival).Node;
            if (++steps > MaxAutomaticSteps)
            {
                return Fault(instance, node, "step_limit", $"More than {MaxAutomaticSteps} automatic steps without reaching a wait state.", now);
            }

            instance.MoveTo(node.Id);
            if (arrival is Arrival.Subprocess)
            {
                var (child, failure) = await StartChildAsync(instance, node, now, cancellationToken);
                if (child is null)
                {
                    return failure;
                }

                if (child.Status != InstanceStatus.Completed)
                {
                    instance.WaitFor(child.Id);
                    return child.Status == InstanceStatus.Faulted ? FaultForChild(instance, node, child, now) : null;
                }

                if (ReturnFrom(instance, node, child, now) is { } outputFailure)
                {
                    return outputFailure;
                }

                arrival = navigator.After(node.Id);
                continue;
            }

            bool outcome;
            try
            {
                var condition = ExpressionParser.ParseCondition(node.Condition!.Value);
                if (!condition.IsSuccess)
                {
                    return Fault(instance, node, "invalid_condition", condition.Error!.Message, now);
                }

                using var data = JsonDocument.Parse(instance.Data);
                outcome = Evaluator.Evaluate(condition.Condition!, new EvaluationContext(data.RootElement, now, zone.Offset));
            }
            catch (ExpressionException ex)
            {
                return Fault(instance, node, ex.Code, ex.Message, now);
            }

            Record(instance, "gateway.evaluated", null, null, null, now, ("nodeId", node.Id), ("label", node.Label), ("outcome", outcome));
            arrival = navigator.After(node.Id, outcome ? Branch.True : Branch.False);
        }

        switch (arrival)
        {
            case Arrival.Wait wait:
                instance.MoveTo(wait.Node.Id);
                var task = InstanceTask.Create(instance.Id, wait, now);
                store.Add(task);
                Record(instance, "task.created", null, wait.GroupId, task.Id, now,
                    ("nodeId", wait.Node.Id), ("label", task.Label), ("kind", KindName(task.Kind)));
                break;
            case Arrival.Finished finished:
                instance.MoveTo(finished.Node.Id);
                instance.Complete(now);
                Record(instance, "instance.completed", null, null, null, now, ("nodeId", finished.Node.Id));
                break;
            case Arrival.Automation automation:
                instance.MoveTo(automation.Node.Id);
                return await DispatchAsync(instance, automation.Node, now, cancellationToken);
        }

        return null;
    }

    // Automation steps (automation.md §6)

    /// <summary>The principal of the result call (automation-contract.md §4.1): not a user or a bot; it names itself in the audit.</summary>
    public const string AutomationPrincipal = "system:automation";

    /// <summary>
    /// The result command (§6.3): under the instance chain lock it de-duplicates by request id (the same body replays the stored
    /// response, a different one is a conflict), ignores results for requests that are no longer pending or for another activation,
    /// and otherwise applies the outcome. Every applied or ignored result is stored with its response and audited.
    /// </summary>
    public async Task<AutomationResultAnswer> ApplyAutomationResultAsync(AutomationResultInput result, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(result);
        if (await store.FindExecutionInstanceAsync(result.RequestId, cancellationToken) is not { } instanceId)
        {
            return new AutomationResultAnswer(AutomationResultDisposition.UnknownRequest, null);
        }

        return await store.InTransactionAsync(async ct =>
        {
            var instance = await store.LockChainAsync(instanceId, ct) ?? throw new InvalidOperationException($"Instance {instanceId} is missing.");
            if (await store.FindResultAsync(result.RequestId, ct) is { } stored)
            {
                // jsonb reorders and spaces the stored response, so it is written again exactly as it was first answered.
                var first = JsonNode.Parse(stored.Response)!;
                return stored.PayloadHash == result.PayloadHash
                    ? new AutomationResultAnswer(AutomationResultDisposition.Replayed, ResultResponse((string?)first["reason"]))
                    : new AutomationResultAnswer(AutomationResultDisposition.Conflict, null);
            }

            var request = await store.FindWorkRequestAsync(result.RequestId, ct) ?? throw new InvalidOperationException($"Request {result.RequestId} is missing.");
            var now = time.GetUtcNow();
            var reason = !request.IsPending ? $"not_pending:{request.Status}" : request.Activation != result.Activation ? "stale_activation" : null;
            if (reason is null)
            {
                await ApplyAsync(instance, request, result, now, ct);
            }

            var response = ResultResponse(reason);
            store.Add(AutomationResultRecord.Create(result.RequestId, result.PayloadHash, response, now));
            var details = new Dictionary<string, string?>
            {
                ["principal"] = AutomationPrincipal,
                ["requestId"] = result.RequestId.ToString(),
                ["outcome"] = result.Succeeded ? "succeeded" : "failed",
            };
            if (reason is not null)
            {
                details["reason"] = reason;
            }

            store.Audit(new AuditRecord(reason is null ? "automation.result_applied" : "automation.result_ignored", null, result.RequestId, details), now);
            await store.SaveChangesAsync(ct);
            return new AutomationResultAnswer(reason is null ? AutomationResultDisposition.Applied : AutomationResultDisposition.Ignored, response);
        }, cancellationToken);
    }

    /// <summary>The 200 body of the result call (automation-contract.md §4.3): applied, or ignored with its reason.</summary>
    private static string ResultResponse(string? ignoredReason) => ignoredReason is null
        ? new JsonObject { ["applied"] = true }.ToJsonString()
        : new JsonObject { ["applied"] = false, ["reason"] = ignoredReason }.ToJsonString();

    /// <summary>
    /// Applies the outcome to the waiting step: a failure faults it (<c>automation_failed</c>); a success merges the mapped outputs and
    /// moves the token on, unless the output breaks the contract or a mapping fails (<c>automation_output_invalid</c>, nothing merged).
    /// </summary>
    private async Task ApplyAsync(Instance instance, AutomationWorkRequest request, AutomationResultInput result, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var navigator = await NavigatorAsync(instance.DefinitionId, instance.VersionNumber, cancellationToken);
        var node = navigator.NodeById(request.NodeId);
        var reference = node.Automation ?? throw new InvalidOperationException($"Step {node.Id} has no automation.");
        if (!result.Succeeded)
        {
            Close(request, "automation_failed", $"{result.ErrorClass}: {result.ErrorMessage}", result.ErrorClass);
        }
        else
        {
            var automation = await automations.VersionAsync(Guid.Parse(reference.AutomationId), reference.Version!.Value, cancellationToken)
                ?? throw new InvalidOperationException($"Pinned automation {reference.AutomationId} v{reference.Version} is missing.");
            var extraction = OutputContract.Extract(automation.Document.Outputs, result.OutputStatus!.Value, result.OutputBody);
            JsonObject? values = null;
            var problem = extraction.Problems;
            if (problem is null)
            {
                try
                {
                    values = Map(reference.Outputs, extraction.Output!.ToJsonString(), now);
                }
                catch (ExpressionException ex)
                {
                    problem = $"{ex.Code}: {ex.Message}";
                }
            }

            if (problem is not null)
            {
                Close(request, "automation_output_invalid", problem, "output_invalid");
            }
            else
            {
                instance.MergeData(values!);
                request.Complete(now);
                Record(instance, "automation.succeeded", null, null, null, now,
                    ("nodeId", node.Id), ("label", node.Label), ("requestId", request.Id), ("attempts", result.Attempts));
                await AdvanceAsync(instance, navigator, navigator.After(node.Id), now, cancellationToken);
            }
        }

        await NotifyParentAsync(instance, null, now, cancellationToken);

        void Close(AutomationWorkRequest failed, string code, string message, string? errorClass)
        {
            failed.Fail(now);
            Record(instance, "automation.failed", null, null, null, now,
                ("nodeId", node.Id), ("label", node.Label), ("requestId", failed.Id), ("errorClass", errorClass), ("attempts", result.Attempts));
            Fault(instance, node, code, message, now);
        }
    }

    /// <summary>
    /// One pass of the watchdog (§6.7): times out up to 100 pending execute requests whose deadline has passed, each in its own
    /// command under the instance chain lock, then completes cancel requests whose 24 hours are over. Concurrent passes are harmless,
    /// because each command re-reads the request under the lock.
    /// </summary>
    public async Task TimeOutAutomationsAsync(CancellationToken cancellationToken)
    {
        foreach (var (requestId, instanceId) in await store.DueExecutionsAsync(time.GetUtcNow(), WatchdogBatch, cancellationToken))
        {
            await store.InTransactionAsync(async ct =>
            {
                var instance = await store.LockChainAsync(instanceId, ct);
                var request = await store.FindWorkRequestAsync(requestId, ct);
                var now = time.GetUtcNow();
                if (instance is null || request is not { IsPending: true }) // a result or a close got there first
                {
                    return false;
                }

                var step = await StepAsync(instance, request.NodeId, ct);
                store.Add(request.TimeOut(now));
                Record(instance, "automation.timed_out", null, null, null, now, ("nodeId", step.Id), ("label", step.Label), ("requestId", request.Id));
                Fault(instance, step, "automation_timed_out",
                    $"No result arrived before the deadline, {request.DeadlineAt.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture)}.", now);
                await NotifyParentAsync(instance, null, now, ct);
                await store.SaveChangesAsync(ct);
                return true;
            }, cancellationToken);
        }

        await store.InTransactionAsync(async ct =>
        {
            var now = time.GetUtcNow();
            foreach (var cancellation in await store.ExpiredCancellationsAsync(now, WatchdogBatch, ct))
            {
                cancellation.Expire(now);
            }

            await store.SaveChangesAsync(ct);
            return true;
        }, cancellationToken);
    }

    /// <summary>
    /// Writes the step's work request in this command (§6.1): the instance then waits at the step, with no task, for the result.
    /// Inputs that break the contract, or a destination that no longer exists, fault the step instead and write nothing.
    /// </summary>
    private async Task<InstanceIncident?> DispatchAsync(Instance instance, Node node, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var reference = node.Automation ?? throw new InvalidOperationException($"Step {node.Id} has no automation.");
        var automationId = Guid.Parse(reference.AutomationId);
        var version = reference.Version ?? throw new InvalidOperationException($"Step {node.Id} is not pinned.");
        var automation = await automations.VersionAsync(automationId, version, cancellationToken)
            ?? throw new InvalidOperationException($"Pinned automation {automationId} v{version} is missing.");

        JsonObject inputs;
        try
        {
            inputs = Map(reference.Inputs, instance.Data, now);
        }
        catch (ExpressionException ex)
        {
            return Fault(instance, node, "automation_input_invalid", $"{ex.Code}: {ex.Message}", now);
        }

        if (automation.Destination is not { } destination)
        {
            return Fault(instance, node, "automation_unavailable", $"The destination '{automation.Document.Request.Destination}' no longer exists.", now);
        }

        // A back-flow or a retry is a new activation (ADR-0011 §4), and a retry after a timeout keeps the key (§8.3).
        var previous = await store.LatestExecutionAsync(instance.Id, node.Id, cancellationToken);
        var requestId = Guid.CreateVersion7(now);
        var activation = (previous?.Activation ?? 0) + 1;
        var key = AutomationWorkRequest.KeyAfter(previous, requestId);
        var activity = Activity.Current is { IdFormat: ActivityIdFormat.W3C } current ? current : null;
        var built = WorkRequestBuilder.Build(automation.Document, destination, inputs, new DispatchContext(
            requestId, instance.Id, node.Id, activation, automationId, version, automation.Name, key, now,
            activity?.TraceId.ToString() ?? ActivityTraceId.CreateRandom().ToString(), activity?.Id));
        if (built.InputError is { } problems)
        {
            return Fault(instance, node, "automation_input_invalid", problems, now);
        }

        var payload = built.Payload!;
        store.Add(AutomationWorkRequest.ForExecution(requestId, instance.Id, node.Id, activation, payload.ToJsonString(), key, now, built.DeadlineAt));
        Record(instance, "automation.requested", null, null, null, now,
            ("nodeId", node.Id), ("label", node.Label), ("requestId", requestId), ("automationId", automationId), ("automationVersion", version),
            ("activation", activation), ("deadlineAt", payload["deadlineAt"]!.GetValue<string>()));
        return null;
    }

    /// <summary>
    /// Opens an incident at a step; a running instance becomes faulted (an already faulted one just gains the incident). The event
    /// names the step by its label, so the timeline can (workflow-engine.md §8, card #219).
    /// </summary>
    private InstanceIncident Fault(Instance instance, Node step, string code, string message, DateTimeOffset now)
    {
        if (instance.IsRunning)
        {
            instance.Fault(step.Id);
        }

        var incident = InstanceIncident.Open(instance.Id, step.Id, code, message, now);
        store.Add(incident);
        Record(instance, "instance.faulted", null, null, null, now, ("nodeId", step.Id), ("label", step.Label), ("code", code));
        return incident;
    }

    // Sub-workflows (workflow-engine.md §14)

    /// <summary>Faults the parent at its sub-workflow step, <paramref name="step"/>, where it waits for the faulted child.</summary>
    private InstanceIncident FaultForChild(Instance parent, Node step, Instance child, DateTimeOffset now) =>
        Fault(parent, step, "subprocess_faulted", $"The sub-workflow request {child.Id} ({child.DefinitionName}) is faulted; fix it first.", now);

    /// <summary>Starts and runs the child of a sub-workflow step; returns the child, or the parent's incident when it could not start.</summary>
    private async Task<(Instance? Child, InstanceIncident? Failure)> StartChildAsync(Instance parent, Node node, DateTimeOffset now, CancellationToken cancellationToken)
    {
        if (parent.Depth >= MaxDepth)
        {
            return (null, Fault(parent, node, "depth_limit", $"Sub-workflows nest at most {MaxDepth} levels.", now));
        }

        var reference = node.Workflow ?? throw new InvalidOperationException($"Step {node.Id} has no workflow.");
        var definitionId = Guid.Parse(reference.WorkflowId);
        var versionNumber = reference.Version ?? throw new InvalidOperationException($"Step {node.Id} is not pinned.");
        var definition = await store.FindDefinitionAsync(definitionId, cancellationToken)
            ?? throw new InvalidOperationException($"Pinned workflow {definitionId} is missing."); // S-3: inactive definitions still run
        var navigator = await NavigatorAsync(definitionId, versionNumber, cancellationToken);

        JsonObject inputs;
        try
        {
            inputs = Map(reference.Inputs, parent.Data, now);
        }
        catch (ExpressionException ex)
        {
            return (null, Fault(parent, node, "subprocess_input_invalid", $"{ex.Code}: {ex.Message}", now));
        }

        Processed? submission = null;
        if (navigator.StartNode.Form is not null)
        {
            // The child doesn't exist yet, so files from the parent stay file_invalid; publishing refuses such inputs (WF206).
            submission = await ProcessAsync(navigator.StartNode, JsonSerializer.SerializeToElement(inputs), "{}", instanceId: null, parent.RequesterId, now, cancellationToken);
            if (submission.Errors.Count > 0)
            {
                return (null, Fault(parent, node, "subprocess_input_invalid",
                    "The child's start form rejected the inputs: " + string.Join(", ", submission.Errors.Select(e => $"{e.Key}: {e.Code}")), now));
            }
        }

        var child = Instance.StartChild(parent, node.Id, definitionId, definition.Name, versionNumber, navigator.StartNode.Id, now);
        store.Add(child);
        Record(parent, "subprocess.started", null, null, null, now, ("nodeId", node.Id), ("childId", child.Id), ("definitionName", definition.Name));
        Record(child, "instance.started", null, null, null, now,
            ("definitionName", definition.Name), ("versionNumber", versionNumber), ("parentId", parent.Id), ("parentNodeId", node.Id));
        if (submission is null)
        {
            child.MergeData(inputs);
        }
        else
        {
            Store(child, null, navigator.StartNode, submission, parent.RequesterId, now);
        }

        await AdvanceAsync(child, navigator, navigator.Start(), now, cancellationToken);
        return (child, null);
    }

    /// <summary>Evaluates <c>{ key: valueTree }</c> mappings over <paramref name="data"/>; missing values are left out (S-2).</summary>
    private JsonObject Map(IReadOnlyDictionary<string, JsonElement>? mappings, string data, DateTimeOffset now)
    {
        var result = new JsonObject();
        using var document = JsonDocument.Parse(data);
        var context = new EvaluationContext(document.RootElement, now, zone.Offset);
        foreach (var (key, tree) in mappings ?? new Dictionary<string, JsonElement>())
        {
            var parsed = ExpressionParser.ParseValue(tree);
            var value = parsed.IsSuccess
                ? Evaluator.Evaluate(parsed.Value!, context)
                : throw new ExpressionException("invalid_mapping", parsed.Error!.Message);
            if (value is not ExprValue.MissingValue)
            {
                result[key] = value.ToJsonNode();
            }
        }

        return result;
    }

    /// <summary>Merges the completed child's outputs into the parent; returns the parent's incident if they fail.</summary>
    private InstanceIncident? ReturnFrom(Instance parent, Node node, Instance child, DateTimeOffset now)
    {
        JsonObject outputs;
        try
        {
            outputs = Map(node.Workflow!.Outputs, child.Data, now);
        }
        catch (ExpressionException ex)
        {
            return Fault(parent, node, "subprocess_output_invalid", $"{ex.Code}: {ex.Message}", now);
        }

        parent.ReleaseChild();
        parent.MergeData(outputs);
        Record(parent, "subprocess.completed", null, null, null, now, ("nodeId", node.Id), ("childId", child.Id));
        return null;
    }

    /// <summary>
    /// After a command changed <paramref name="child"/>, brings the waiting parent in line (§14.2) and continues upwards:
    /// completion returns outputs and moves on, a fault or cancellation faults the parent, a resumed child resumes it.
    /// </summary>
    private async Task NotifyParentAsync(Instance child, Guid? actorId, DateTimeOffset now, CancellationToken cancellationToken)
    {
        if (child.ParentInstanceId is not { } parentId || await store.FindInstanceAsync(parentId, cancellationToken) is not { } parent
            || parent.ChildInstanceId != child.Id)
        {
            return;
        }

        var navigator = await NavigatorAsync(parent.DefinitionId, parent.VersionNumber, cancellationToken);
        var node = navigator.NodeById(parent.CurrentNodeId);
        var open = (await store.GetIncidentsAsync(parent.Id, cancellationToken)).Where(i => i.IsOpen).ToList();
        switch (child.Status)
        {
            case InstanceStatus.Running when parent.Status == InstanceStatus.Faulted:
                Resume(parent, open, "child_resumed", actorId, now);
                break;
            case InstanceStatus.Faulted when parent.IsRunning:
                FaultForChild(parent, node, child, now);
                break;
            case InstanceStatus.Completed:
                if (parent.Status == InstanceStatus.Faulted)
                {
                    Resume(parent, open, "child_completed", actorId, now);
                }

                if (ReturnFrom(parent, node, child, now) is null)
                {
                    await AdvanceAsync(parent, navigator, navigator.After(node.Id), now, cancellationToken);
                }

                break;
            case InstanceStatus.Cancelled:
                foreach (var incident in open)
                {
                    incident.Resolve("child_cancelled", actorId, now);
                }

                parent.ReleaseChild();
                Fault(parent, node, "subprocess_cancelled", $"The sub-workflow request {child.Id} ({child.DefinitionName}) was cancelled; retry to start a new one.", now);
                break;
            default:
                return;
        }

        await NotifyParentAsync(parent, actorId, now, cancellationToken);
    }

    private void Resume(Instance instance, IEnumerable<InstanceIncident> open, string resolution, Guid? actorId, DateTimeOffset now)
    {
        foreach (var incident in open)
        {
            incident.Resolve(resolution, actorId, now);
        }

        instance.Resume();
        Record(instance, "instance.resumed", null, null, null, now, ("cause", resolution));
    }

    /// <summary>Cancels the instance, its open tasks and incidents.</summary>
    private async Task CancelAsync(Instance instance, Guid actorId, DateTimeOffset now, CancellationToken cancellationToken, params (string Key, object? Value)[] details)
    {
        foreach (var task in await store.GetOpenTasksAsync(instance.Id, cancellationToken))
        {
            task.Cancel(now);
            Record(instance, "task.cancelled", actorId, null, task.Id, now);
        }

        foreach (var incident in (await store.GetIncidentsAsync(instance.Id, cancellationToken)).Where(i => i.IsOpen))
        {
            incident.Resolve("cancelled", actorId, now);
        }

        if (await store.FindPendingExecutionAsync(instance.Id, cancellationToken) is { } request)
        {
            store.Add(request.CancelExecution(now)); // Elixir drops the job if it hasn't started; a late result is ignored (§6.5)
            Record(instance, "automation.cancelled", actorId, null, null, now,
                ("nodeId", request.NodeId), ("label", (await StepAsync(instance, request.NodeId, cancellationToken)).Label), ("requestId", request.Id));
        }

        instance.Cancel(now);
        Record(instance, "instance.cancelled", actorId, null, null, now, details);
    }

    /// <summary>Raised inside a retry so the whole transaction rolls back when the step fails again.</summary>
    private sealed class RetryFailedException(string code) : Exception(code)
    {
        public string Code { get; } = code;
    }

    /// <summary>Admins re-run the failed step of a faulted instance against its current data (workflow-engine.md §13.3).</summary>
    public async Task<EngineResult<InstanceView>> RetryAsync(Guid actorId, Guid instanceId, Idempotency idempotency, CancellationToken cancellationToken)
    {
        try
        {
            return await IdempotentAsync(actorId, idempotency, async ct =>
            {
                var actor = await directory.GetActorAsync(actorId, ct);
                var instance = await store.LockChainAsync(instanceId, ct);
                if (actor is not { IsActive: true } || instance is null || !await CanSeeAsync(actor, instance, ct))
                {
                    return EngineResult.Fail<InstanceView>(EngineError.NotFound);
                }

                if (!actor.IsAdmin)
                {
                    return EngineResult.Fail<InstanceView>(EngineError.Forbidden);
                }

                if (instance.Status != InstanceStatus.Faulted)
                {
                    return EngineResult.Fail<InstanceView>(EngineError.InstanceNotFaulted);
                }

                var child = instance.ChildInstanceId is { } childId ? await store.LockInstanceAsync(childId, ct) : null;
                if (child is { Status: not InstanceStatus.Completed })
                {
                    return EngineResult.Fail<InstanceView>(EngineError.RetryFailed, "subprocess_faulted"); // fix the child first (§14.2)
                }

                var now = time.GetUtcNow();
                var navigator = await NavigatorAsync(instance.DefinitionId, instance.VersionNumber, ct);
                var open = (await store.GetIncidentsAsync(instanceId, ct)).Where(i => i.IsOpen).ToList();
                instance.Resume();
                var again = child is null
                    ? await AdvanceAsync(instance, navigator, navigator.At(instance.CurrentNodeId), now, ct) // a cancelled child is replaced by a new one
                    : ReturnFrom(instance, navigator.NodeById(instance.CurrentNodeId), child, now)
                      ?? await AdvanceAsync(instance, navigator, navigator.After(instance.CurrentNodeId), now, ct);
                if (again is not null)
                {
                    throw new RetryFailedException(again.Code); // roll back: the instance stays faulted with its incident
                }

                foreach (var incident in open)
                {
                    incident.Resolve("retried", actorId, now);
                }

                Record(instance, "instance.resumed", actorId, null, null, now);
                await NotifyParentAsync(instance, actorId, now, ct);
                await store.SaveChangesAsync(ct);
                return EngineResult.Ok(await ViewAsync(instance, actor, ct));
            }, cancellationToken);
        }
        catch (RetryFailedException ex)
        {
            return EngineResult.Fail<InstanceView>(EngineError.RetryFailed, ex.Code);
        }
    }

    /// <summary>
    /// Admins correct the data of a faulted request, or of a completed child whose parent faulted on its outputs
    /// (workflow-engine.md §16). Nothing else changes: retry then re-runs the failed step over the corrected data.
    /// </summary>
    public Task<EngineResult<InstanceView>> CorrectAsync(
        Guid actorId, Guid instanceId, uint expectedVersion, JsonElement? changes, string? justification, Idempotency idempotency,
        CancellationToken cancellationToken)
    {
        var reason = Normalize(justification);
        if (changes is not { ValueKind: JsonValueKind.Object } patch || !patch.EnumerateObject().Any())
        {
            return Task.FromResult(EngineResult.Fail<InstanceView>(EngineError.ValidationFailed, "changes_required"));
        }

        var keys = patch.EnumerateObject().Select(p => p.Name).ToList();
        if (keys.Distinct(StringComparer.Ordinal).Count() != keys.Count)
        {
            return Task.FromResult(EngineResult.Fail<InstanceView>(EngineError.ValidationFailed, "duplicate_key"));
        }

        if (reason is null)
        {
            return Task.FromResult(EngineResult.Fail<InstanceView>(EngineError.ValidationFailed, "justification_required"));
        }

        if (reason.Length > InstanceSubmission.MaxJustificationLength)
        {
            return Task.FromResult(EngineResult.Fail<InstanceView>(EngineError.ValidationFailed, "justification_too_long"));
        }

        if (!ClientText.IsStorable(reason))
        {
            return Task.FromResult(EngineResult.Fail<InstanceView>(EngineError.ValidationFailed, "invalid_justification"));
        }

        if (System.Text.Encoding.UTF8.GetByteCount(patch.GetRawText()) > 256 * 1024)
        {
            return Task.FromResult(EngineResult.InvalidCorrection<InstanceView>([new FieldErrorView(string.Empty, "payload_too_large")]));
        }

        return IdempotentAsync(actorId, idempotency, async ct =>
        {
            var actor = await directory.GetActorAsync(actorId, ct);
            var instance = await store.LockChainAsync(instanceId, ct);
            if (actor is not { IsActive: true } || instance is null || !await CanSeeAsync(actor, instance, ct))
            {
                return EngineResult.Fail<InstanceView>(EngineError.NotFound);
            }

            if (!actor.IsAdmin)
            {
                return EngineResult.Fail<InstanceView>(EngineError.Forbidden);
            }

            if (await CorrectedIncidentsAsync(instance, ct) is not { } incidents)
            {
                return EngineResult.Fail<InstanceView>(EngineError.InstanceNotFaulted);
            }

            if (store.VersionOf(instance) != expectedVersion)
            {
                return EngineResult.Fail<InstanceView>(EngineError.VersionMismatch);
            }

            var now = time.GetUtcNow();
            using var data = JsonDocument.Parse(instance.Data);
            var (errors, accepted) = (await CorrectionCheckAsync(instance, now, ct)).Check(patch, data.RootElement);
            if (errors.Count > 0)
            {
                return EngineResult.InvalidCorrection<InstanceView>(errors);
            }

            var applied = instance.CorrectData(accepted);
            store.Add(InstanceSubmission.Correction(instance, applied, reason, incidents, actorId, now));
            Record(instance, "data.corrected", actorId, null, null, now,
                ("changes", InstanceSubmission.ToJson(applied)), ("justification", reason), ("incidentIds", incidents));
            await store.SaveChangesAsync(ct);
            return EngineResult.Ok(await ViewAsync(instance, actor, ct));
        }, cancellationToken);
    }

    /// <summary>
    /// The open incidents a correction addresses, or null when the instance can't be corrected (workflow-engine.md §16.2, §16.5):
    /// its own when it is faulted; its parent's when it is a completed child that the parent faulted on with
    /// <c>subprocess_output_invalid</c> (Q-N8).
    /// </summary>
    private async Task<IReadOnlyList<Guid>?> CorrectedIncidentsAsync(Instance instance, CancellationToken cancellationToken)
    {
        if (instance.Status == InstanceStatus.Faulted)
        {
            return [.. (await store.GetIncidentsAsync(instance.Id, cancellationToken)).Where(i => i.IsOpen).Select(i => i.Id)];
        }

        if (instance is not { Status: InstanceStatus.Completed, ParentInstanceId: { } parentId }
            || await store.FindInstanceAsync(parentId, cancellationToken) is not { Status: InstanceStatus.Faulted } parent
            || parent.ChildInstanceId != instance.Id)
        {
            return null;
        }

        var open = (await store.GetIncidentsAsync(parent.Id, cancellationToken))
            .Where(i => i.IsOpen && i.Code == "subprocess_output_invalid").Select(i => i.Id).ToList();
        return open.Count > 0 ? open : null;
    }

    /// <summary>The correction check over the instance's pinned version: its catalog and the forms of its steps (§16.3).</summary>
    private async Task<DataCorrection> CorrectionCheckAsync(Instance instance, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var document = (await NavigatorAsync(instance.DefinitionId, instance.VersionNumber, cancellationToken)).Document;
        var resolver = new ContractResolver(store.FindVersionAsync, forms.GetDocumentAsync, automations.GetVersionDocumentAsync, cancellationToken);
        var contracts = await resolver.ContractsAsync(document, n => n.Form?.Version, n => n.Workflow?.Version, n => n.Automation?.Version, depth: 0);
        var stepForms = new Dictionary<string, FormDocument>(StringComparer.Ordinal);
        foreach (var node in document.Nodes)
        {
            if (await resolver.FormAsync(node.Form?.FormId, node.Form?.Version) is { } form)
            {
                stepForms[node.Id] = form;
            }
        }

        return new DataCorrection(DataCatalog.Analyze(document, contracts), stepForms, await UntypedInputsAsync(instance, document, cancellationToken), now, zone.Offset);
    }

    /// <summary>Q-N10: the keys a child without a start form received as its parent's inputs (TC-5); a correction may set any value.</summary>
    private async Task<IReadOnlySet<string>> UntypedInputsAsync(Instance instance, WorkflowDocument document, CancellationToken cancellationToken)
    {
        if (instance.ParentInstanceId is not { } parentId || document.Nodes.FirstOrDefault(n => n.Type == NodeType.Start)?.Form is not null
            || await store.FindInstanceAsync(parentId, cancellationToken) is not { } parent)
        {
            return new HashSet<string>(StringComparer.Ordinal);
        }

        var call = (await NavigatorAsync(parent.DefinitionId, parent.VersionNumber, cancellationToken)).NodeById(instance.ParentNodeId!);
        return new HashSet<string>(call.Workflow?.Inputs?.Keys ?? [], StringComparer.Ordinal);
    }

    /// <summary>A task with its pinned form and prefill, for anyone who can see the instance (workflow-engine.md §13.1).</summary>
    public Task<EngineResult<TaskDetail>> GetTaskAsync(Guid actorId, Guid taskId, CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
        {
            var actor = await directory.GetActorAsync(actorId, ct);
            var task = await store.FindTaskAsync(taskId, ct);
            var instance = task is null ? null : await store.FindInstanceAsync(task.InstanceId, ct);
            if (actor is null || task is null || instance is null || !await CanSeeAsync(actor, instance, ct))
            {
                return EngineResult.Fail<TaskDetail>(EngineError.NotFound);
            }

            var node = (await NavigatorAsync(instance.DefinitionId, instance.VersionNumber, ct)).NodeById(task.NodeId);
            TaskFormView? form = null;
            var prefill = new JsonObject();
            var masked = new List<string>();
            var shown = new List<string>();
            if (node.Form is { Version: { } version } reference && Guid.TryParse(reference.FormId, out var formId)
                && await forms.GetDocumentAsync(formId, version, ct) is { } document)
            {
                form = new TaskFormView(formId, version, Json(document));
                var data = JsonNode.Parse(instance.Data)!.AsObject();
                var sensitive = await SensitiveScopeAsync(actor, instance, ct);
                // The task rule: the eligible actors of an open task see its form's sensitive fields (sensitive-data.md §4).
                var taskRule = task.Status == TaskState.Open && actor.IsEligibleFor(task, instance);
                foreach (var key in FormDocumentParser.Parse(document).Document!.Components.Where(c => c.ProducesValue && c.Key is not null).Select(c => c.Key!))
                {
                    if (data[key] is not { } value)
                    {
                        continue;
                    }

                    if (!taskRule && sensitive.Hides(key))
                    {
                        masked.Add(key);
                    }
                    else
                    {
                        prefill[key] = value.DeepClone();
                        if (sensitive.Keys.Contains(key))
                        {
                            shown.Add(key);
                        }
                    }
                }
            }

            masked.Sort(StringComparer.Ordinal);
            shown.Sort(StringComparer.Ordinal);
            await RevealedAsync(actor, instance, shown, ct);
            return EngineResult.Ok(new TaskDetail(await TaskViewAsync(task, ct), form, JsonSerializer.SerializeToElement(prefill)) { MaskedKeys = masked });
        }, cancellationToken);

    // Form submissions (workflow-engine.md §13.1)

    private sealed record Processed(Guid? FormId, int Version, JsonObject Values, IReadOnlyList<FieldErrorView> Errors)
    {
        public IReadOnlyList<Guid> FileIds { get; init; } = [];
    }

    /// <summary>
    /// Validates <paramref name="data"/> against the node's pinned form over the instance's current data. A file already attached
    /// to <paramref name="instanceId"/> through a submission may be sent again (forms.md F4, card #69); a start, which has no
    /// instance yet, takes new files only.
    /// </summary>
    private async Task<Processed> ProcessAsync(
        Node node, JsonElement? data, string instanceData, Guid? instanceId, Guid actorId, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var hasData = data is { ValueKind: not (JsonValueKind.Null or JsonValueKind.Undefined) } d
            && !(d.ValueKind == JsonValueKind.Object && !d.EnumerateObject().Any());
        if (node.Form is not { Version: { } version } reference || !Guid.TryParse(reference.FormId, out var formId))
        {
            return new Processed(null, 0, [], hasData ? [new FieldErrorView(string.Empty, "unexpected_data")] : []);
        }

        var document = await forms.GetDocumentAsync(formId, version, cancellationToken)
            ?? throw new InvalidOperationException($"Pinned form {formId} v{version} is missing.");
        if (data is { } raw && System.Text.Encoding.UTF8.GetByteCount(raw.GetRawText()) > 256 * 1024)
        {
            return new Processed(formId, version, [], [new FieldErrorView(string.Empty, "payload_too_large")]);
        }

        using var current = JsonDocument.Parse(instanceData);
        var submitted = data is { ValueKind: JsonValueKind.Object } value ? value : SubmissionProcessor.EmptyObject;
        if (data is { } other && other.ValueKind is not (JsonValueKind.Object or JsonValueKind.Null or JsonValueKind.Undefined))
        {
            return new Processed(formId, version, [], [new FieldErrorView(string.Empty, "type_mismatch")]);
        }

        var referenced = FileRules.CollectIds(submitted);
        var locked = await files.LockAsync(referenced, cancellationToken);
        var known = locked.ToDictionary(
            file => file.Id,
            file => new FileBinding(file.UploadedBy, file.Status == StoredFileStatus.Pending, file.OriginalName, file.SizeBytes, file.ContentType)
            {
                AttachedToThisInstance = instanceId is { } here && file.IsAttachedToSubmissionOf(here),
            });
        var result = SubmissionProcessor.Process(
            FormDocumentParser.Parse(document).Document!, submitted, current.RootElement, now, zone.Offset, actorId, known, fileSettings.MaxFiles);
        return new Processed(formId, version, result.Values, [.. result.Errors.Select(e => new FieldErrorView(e.Key, e.Code))])
        {
            FileIds = result.Errors.Count == 0 ? result.FileIds : [],
        };
    }

    /// <summary>Merges accepted values into the instance and records the submission.</summary>
    private void Store(Instance instance, Guid? taskId, Node node, Processed submission, Guid actorId, DateTimeOffset now)
    {
        if (submission.FormId is not { } formId)
        {
            return;
        }

        instance.MergeData(submission.Values);
        var row = InstanceSubmission.Create(instance.Id, taskId, node.Id, formId, submission.Version, submission.Values, actorId, now);
        store.Add(row);
        foreach (var id in submission.FileIds)
        {
            var file = files.Tracked(id);
            file.Attach(instance.Id, AttachmentTarget.Submission, row.Id, now);
            Record(instance, "attachment.added", actorId, null, taskId, now,
                ("fileId", file.Id), ("name", file.OriginalName), ("size", file.SizeBytes), ("contentType", file.ContentType), ("submissionId", row.Id));
        }

        Record(instance, "form.submitted", actorId, null, taskId, now, ("nodeId", node.Id), ("formId", formId), ("formVersion", submission.Version));
    }

    /// <summary>A step of the instance's pinned definition, whose label events record (workflow-engine.md §8; cards #139, #219).</summary>
    private async Task<Node> StepAsync(Instance instance, string nodeId, CancellationToken cancellationToken) =>
        (await NavigatorAsync(instance.DefinitionId, instance.VersionNumber, cancellationToken)).NodeById(nodeId);

    private async Task<FlowNavigator> NavigatorAsync(Guid definitionId, int versionNumber, CancellationToken cancellationToken)
    {
        var version = await store.FindVersionAsync(definitionId, versionNumber, cancellationToken)
            ?? throw new InvalidOperationException($"Version {versionNumber} of {definitionId} is missing.");
        var parsed = WorkflowDocumentParser.Parse(version.Document);
        return new FlowNavigator(parsed.Document ?? throw new InvalidOperationException($"Published version is not parseable: {parsed.Error}"));
    }

    // Authorization (workflow-engine.md §5–§6)

    private Task<bool> CanSeeAsync(ActorInfo actor, Instance instance, CancellationToken cancellationToken) =>
        access.CanSeeAsync(actor, instance, cancellationToken);

    /// <summary>Loads and checks the task: visible → open → right kind → eligible; then runs <paramref name="work"/>.</summary>
    private Task<EngineResult<T>> WithTaskAsync<T>(
        Guid actorId, Guid taskId, Idempotency idempotency, TaskKindAtNode? kind,
        Func<ActorInfo, Instance, InstanceTask, DateTimeOffset, CancellationToken, Task<EngineResult<T>>> work,
        CancellationToken cancellationToken) =>
        IdempotentAsync(actorId, idempotency, async ct =>
        {
            var actor = await directory.GetActorAsync(actorId, ct);
            var instanceId = await store.FindTaskInstanceIdAsync(taskId, ct);
            var instance = instanceId is { } id ? await store.LockChainAsync(id, ct) : null; // serialize commands per request (§3, §14.2)
            var task = instance is null ? null : await store.FindTaskAsync(taskId, ct);
            if (actor is not { IsActive: true } || task is null || instance is null || !await CanSeeAsync(actor, instance, ct))
            {
                return EngineResult.Fail<T>(EngineError.NotFound);
            }

            if (!task.IsOpen || !instance.IsRunning)
            {
                return EngineResult.Fail<T>(EngineError.TaskNotOpen);
            }

            if (kind is { } expected && task.Kind != expected)
            {
                return EngineResult.Fail<T>(EngineError.WrongTaskKind);
            }

            if (!actor.IsEligibleFor(task, instance))
            {
                return EngineResult.Fail<T>(EngineError.Forbidden);
            }

            return await work(actor, instance, task, time.GetUtcNow(), ct);
        }, cancellationToken);

    /// <summary>First action links an unassigned task; a task assigned to someone else is rejected (§5.1).</summary>
    private async Task<EngineError?> LinkOrRejectAsync(ActorInfo actor, Instance instance, InstanceTask task, DateTimeOffset now, CancellationToken cancellationToken)
    {
        if (task.AssigneeId is { } assignee)
        {
            return assignee == actor.Id ? null : EngineError.TaskAssigned;
        }

        await LinkAsync(actor, instance, task, now, cancellationToken);
        return null;
    }

    private async Task LinkAsync(ActorInfo actor, Instance instance, InstanceTask task, DateTimeOffset now, CancellationToken cancellationToken)
    {
        if (task.AssigneeId == actor.Id)
        {
            return;
        }

        task.AssignTo(actor.Id);
        await AddParticipantAsync(instance, actor.Id, now, cancellationToken);
        Record(instance, "task.assigned", actor.Id, task.GroupId, task.Id, now);
    }

    private async Task AddParticipantAsync(Instance instance, Guid actorId, DateTimeOffset now, CancellationToken cancellationToken)
    {
        if (!await store.IsParticipantAsync(instance.Id, actorId, cancellationToken))
        {
            store.Add(InstanceParticipant.Create(instance.Id, actorId, now));
        }
    }

    // Idempotency (ADR-0008 §4)

    private Task<EngineResult<T>> IdempotentAsync<T>(
        Guid actorId, Idempotency idempotency, Func<CancellationToken, Task<EngineResult<T>>> work, CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
        {
            var now = time.GetUtcNow();
            var reserved = await store.TryReserveIdempotencyAsync(
                new IdempotencyRecord(actorId, idempotency.Key, idempotency.RequestHash, null), now, now - IdempotencyWindow, ct);
            if (!reserved)
            {
                var existing = await store.FindIdempotencyAsync(actorId, idempotency.Key, ct)
                    ?? throw new InvalidOperationException("Idempotency key vanished after a conflict.");
                return existing.RequestHash != idempotency.RequestHash || existing.ResultJson is null
                    ? EngineResult.Fail<T>(EngineError.IdempotencyKeyReused)
                    : JsonSerializer.Deserialize<EngineResult<T>>(existing.ResultJson, ResultJson)!;
            }

            var result = await work(ct);
            await store.SaveChangesAsync(ct);
            await store.CompleteIdempotencyAsync(actorId, idempotency.Key, JsonSerializer.Serialize(result, ResultJson), ct);
            return result;
        }, cancellationToken);

    // Views

    /// <summary>
    /// The request as <paramref name="actor"/> may see it: sensitive keys they may not see are left out of the data, listed in
    /// <see cref="InstanceView.MaskedKeys"/>, and masked in <c>data.corrected</c> events (sensitive-data.md §4, §5; card #53).
    /// </summary>
    private async Task<InstanceView> ViewAsync(Instance instance, ActorInfo actor, CancellationToken cancellationToken)
    {
        var sensitive = await SensitiveScopeAsync(actor, instance, cancellationToken);
        var (data, masked) = sensitive.Mask(instance.Data);
        var openTasks = await store.GetOpenTasksAsync(instance.Id, cancellationToken);
        var participants = await store.GetParticipantIdsAsync(instance.Id, cancellationToken);
        var events = await store.GetEventsAsync(instance.Id, cancellationToken);
        var incidents = await store.GetIncidentsAsync(instance.Id, cancellationToken);
        var startedAt = events.Where(e => e.Type == "subprocess.started")
            .ToDictionary(e => Json(e.Details).GetProperty("childId").GetGuid(), e => e.Sequence);
        var children = (await store.GetChildrenAsync(instance.Id, cancellationToken)).OrderBy(c => startedAt.GetValueOrDefault(c.Id)).ToList();
        var actorIds = participants
            .Concat(events.Select(e => e.ActorId).OfType<Guid>())
            .Concat(openTasks.Select(t => t.AssigneeId).OfType<Guid>())
            .Append(instance.RequesterId).Distinct().ToList();
        var actors = await directory.GetActorsAsync(actorIds, cancellationToken);
        var groups = await directory.GetGroupsAsync(
            [.. events.Select(e => e.ActedAsGroupId).Concat(openTasks.Select(t => t.GroupId)).OfType<Guid>().Distinct()], cancellationToken);
        await RevealedAsync(actor, instance, sensitive.Shown(instance.Data, events.Select(e => (e.Type, e.Details))), cancellationToken);

        return new InstanceView(
            instance.Id, instance.DefinitionId, instance.DefinitionName, instance.VersionNumber, StatusName(instance.Status), instance.CurrentNodeId,
            actors[instance.RequesterId], instance.StartedAt, instance.EndedAt,
            [.. openTasks.Select(t => TaskViewOf(t, actors, groups))],
            [.. participants.Select(p => actors[p])],
            [.. events.Select(e => new EventView(
                e.Type, e.OccurredAt,
                e.ActorId is { } a ? actors.GetValueOrDefault(a) : null,
                e.ActedAsGroupId is { } g ? groups.GetValueOrDefault(g) : null,
                e.TaskId, e.Type == "data.corrected" ? sensitive.MaskCorrection(e.Details) : Json(e.Details), e.Channel))],
            data,
            [.. incidents.Select(i => new IncidentView(i.Id, i.NodeId, i.Code, sensitive.SeesAll ? i.Message : null, i.CreatedAt, i.ResolvedAt, i.Resolution))],
            instance.ParentInstanceId is { } parentId ? new ParentView(parentId, instance.ParentNodeId!) : null,
            [.. children.Select(c => new ChildView(c.Id, c.ParentNodeId!, c.DefinitionName, StatusName(c.Status)))],
            store.VersionOf(instance))
        {
            MaskedKeys = masked,
        };
    }

    /// <summary>
    /// Records <c>sensitive.revealed</c> when a response shows <paramref name="keys"/> (sensitive-data.md §6): who, which request,
    /// which keys and the request's channel, never the values.
    /// </summary>
    private async Task RevealedAsync(ActorInfo actor, Instance instance, IReadOnlyList<string> keys, CancellationToken cancellationToken)
    {
        if (keys.Count == 0)
        {
            return;
        }

        var details = new Dictionary<string, string?> { ["keys"] = string.Join(',', keys), ["entryPoint"] = channel.Current?.Name() };
        store.Audit(new AuditRecord("sensitive.revealed", actor.Id, instance.Id, details), time.GetUtcNow());
        await store.SaveChangesAsync(cancellationToken);
    }

    /// <summary>
    /// The request's sensitive keys, and whether <paramref name="actor"/> sees them all: an admin or a holder of
    /// <c>viewSensitive</c> does (sensitive-data.md §4). It never widens who sees the request.
    /// </summary>
    private async Task<SensitiveScope> SensitiveScopeAsync(ActorInfo actor, Instance instance, CancellationToken cancellationToken)
    {
        var version = await store.FindVersionAsync(instance.DefinitionId, instance.VersionNumber, cancellationToken);
        if (version is not { SensitiveKeys.Length: > 0 })
        {
            return SensitiveScope.Nothing;
        }

        var seesAll = actor.IsAdmin
            || await store.HasCapabilityAsync(instance.DefinitionId, actor.ActiveGroupIds, WorkflowCapability.ViewSensitive, cancellationToken);
        return new SensitiveScope(version.SensitiveKeys.ToHashSet(StringComparer.Ordinal), seesAll);
    }

    private async Task<TaskView> TaskViewAsync(InstanceTask task, CancellationToken cancellationToken)
    {
        var actors = await directory.GetActorsAsync(task.AssigneeId is { } a ? [a] : [], cancellationToken);
        var groups = await directory.GetGroupsAsync(task.GroupId is { } g ? [g] : [], cancellationToken);
        return TaskViewOf(task, actors, groups);
    }

    private static TaskView TaskViewOf(InstanceTask task, IReadOnlyDictionary<Guid, ActorRef> actors, IReadOnlyDictionary<Guid, GroupInfo> groups) => new(
        task.Id, task.InstanceId, task.NodeId, task.Label, KindName(task.Kind), task.Question,
        task.GroupId is { } g ? groups.GetValueOrDefault(g) : null,
        task.AssigneeId is { } a ? actors.GetValueOrDefault(a) : null,
        task.CreatedAt);

    private void Record(Instance instance, string type, Guid? actorId, Guid? actedAsGroupId, Guid? taskId, DateTimeOffset now, params (string Key, object? Value)[] details) =>
        store.Add(InstanceEvent.Create(instance, type, actorId, actedAsGroupId, taskId,
            details.Where(d => d.Value is not null).ToDictionary(d => d.Key, d => d.Value), now, channel.Current?.Name()));

    private static string StatusName(InstanceStatus status) => status.ToString().ToLower(CultureInfo.InvariantCulture);

    private static string KindName(TaskKindAtNode kind) => kind == TaskKindAtNode.Decision ? "decision" : "task";

    private static string? Normalize(string? text) => string.IsNullOrWhiteSpace(text) ? null : text.Trim();

    private static JsonElement Json(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }
}
