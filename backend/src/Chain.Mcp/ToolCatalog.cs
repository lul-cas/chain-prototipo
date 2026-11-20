using System.Text.Json;
using System.Text.Json.Nodes;
using ModelContextProtocol.Protocol;

namespace Chain.Mcp;

/// <summary>
/// The tools of the first release, in their listed order (ADR-0015 §6.1; mcp.md §2). Each one is a thin translation to one call of
/// <see cref="Chain.Workflows.Application.Engine.InstanceService"/>, the service behind the HTTP API. Excluded operations (§6.2)
/// are simply not here.
/// </summary>
internal static class ToolCatalog
{
    public static readonly string[] Statuses = ["running", "completed", "cancelled", "faulted"];

    private static readonly string[] Scopes = ["mine", "visible"];

    public static IReadOnlyList<ChainTool> All { get; } =
    [
        Tool(
            "list_startable_workflows", "List startable workflows",
            "Lists the workflows you can start a request for. Pass a workflow's id to get_start_form and start_request.",
            Effect.Read, [],
            async (call, args) => args.Invalid
                ?? ToolResults.Ok(new { workflows = await call.Engine.ListStartableAsync(call.Actor, call.CancellationToken) })),

        Tool(
            "get_start_form", "Get a start form",
            "Returns the start form of a workflow's latest version: its fields with their keys, types, rules and options. " +
            "form is null when the workflow takes no start data. Read it before start_request.",
            Effect.Read, [Required("workflowId", Uuid("The workflow's id, from list_startable_workflows."))],
            async (call, args) =>
            {
                var workflowId = args.Id("workflowId", "invalid_workflow_id");
                return args.Invalid ?? ToolResults.From(await call.Engine.GetStartFormAsync(call.Actor, workflowId, call.CancellationToken));
            }),

        Tool(
            "start_request", "Start a request",
            "Starts a request of a workflow with its start data, and returns the request with its status and open tasks. " +
            "It returns at once: people and other steps carry the work on later, so follow it with get_request.",
            Effect.Write,
            [
                Required("workflowId", Uuid("The workflow's id, from list_startable_workflows.")),
                Optional("data", Data("The start data, keyed by the start form's field keys. Omit it when the workflow has no start form. " + Clearing)),
                Required("idempotencyKey", IdempotencyKey),
            ],
            async (call, args) =>
            {
                var workflowId = args.Id("workflowId", "invalid_workflow_id");
                var data = args.Data("data");
                var key = args.IdempotencyKey();
                return args.Invalid ?? ToolResults.From(await call.Engine.StartAsync(
                    call.Actor, workflowId, data, call.Idempotency(key, new { workflowId, data }), call.CancellationToken));
            }),

        Tool(
            "list_my_requests", "List my requests",
            "Lists requests: the ones you started (scope mine, the default) or every request you can see (scope visible), " +
            "optionally only those in one status.",
            Effect.Read,
            [
                Optional("scope", Choice("mine: requests you started. visible: every request you can see.", Scopes)),
                Optional("status", Choice("Only requests in this status.", Statuses)),
            ],
            async (call, args) =>
            {
                var scope = args.Choice("scope", Scopes, "invalid_scope") ?? "mine";
                var status = args.Status("status", "invalid_status");
                return args.Invalid ?? ToolResults.Ok(new
                {
                    requests = await call.Engine.ListAsync(call.Actor, mineOnly: scope == "mine", status, call.CancellationToken),
                });
            }),

        Tool(
            "get_request", "Get a request",
            "Returns a request: its status, data, open tasks, timeline, incidents, and the requests it started or was started by.",
            Effect.Read, [Required("requestId", Uuid("The request's id."))],
            async (call, args) =>
            {
                var requestId = args.Id("requestId", "invalid_request_id");
                return args.Invalid ?? ToolResults.From(await call.Engine.GetAsync(call.Actor, requestId, call.CancellationToken));
            }),

        Tool(
            "list_my_tasks", "List my tasks",
            "Lists the open tasks you can work on: assigned to you, unassigned in your groups, and assigned to others in your groups.",
            Effect.Read, [],
            async (call, args) => args.Invalid ?? ToolResults.Ok(await call.Engine.GetInboxAsync(call.Actor, call.CancellationToken))),

        Tool(
            "get_task", "Get a task",
            "Returns a task with its form and the prefill taken from the request's current data. Read it before complete_task or decide_task.",
            Effect.Read, [Required("taskId", Uuid(TaskIdDescription))],
            async (call, args) =>
            {
                var taskId = args.Id("taskId", "invalid_task_id");
                return args.Invalid ?? ToolResults.From(await call.Engine.GetTaskAsync(call.Actor, taskId, call.CancellationToken));
            }),

        Tool(
            "start_working_on_task", "Start working on a task",
            "Assigns an unassigned task in your groups to you, so that others see you are working on it.",
            Effect.Write, [Required("taskId", Uuid(TaskIdDescription)), Required("idempotencyKey", IdempotencyKey)],
            async (call, args) =>
            {
                var taskId = args.Id("taskId", "invalid_task_id");
                var key = args.IdempotencyKey();
                return args.Invalid ?? ToolResults.From(await call.Engine.StartWorkingAsync(
                    call.Actor, taskId, call.Idempotency(key, new { taskId }), call.CancellationToken));
            }),

        Tool(
            "take_over_task", "Take over a task",
            "Assigns to you a task that someone else in your group is working on. The request's timeline records the take-over.",
            Effect.Reassign, [Required("taskId", Uuid(TaskIdDescription)), Required("idempotencyKey", IdempotencyKey)],
            async (call, args) =>
            {
                var taskId = args.Id("taskId", "invalid_task_id");
                var key = args.IdempotencyKey();
                return args.Invalid ?? ToolResults.From(await call.Engine.TakeOverAsync(
                    call.Actor, taskId, call.Idempotency(key, new { taskId }), call.CancellationToken));
            }),

        Tool(
            "complete_task", "Complete a task",
            "Completes a task with the data its form asks for and an optional comment, and the request moves on. " +
            "Returns the request. Decisions are answered with decide_task instead.",
            Effect.Transition,
            [
                Required("taskId", Uuid(TaskIdDescription)),
                Optional("data", Data("The data the task's form asks for, keyed by field key. Omit it when the task has no form. " + Clearing)),
                Optional("comment", Text("An optional comment for the request's timeline.")),
                Required("idempotencyKey", IdempotencyKey),
            ],
            async (call, args) =>
            {
                var taskId = args.Id("taskId", "invalid_task_id");
                var data = args.Data("data");
                var comment = args.Text("comment", "invalid_comment");
                var key = args.IdempotencyKey();
                return args.Invalid ?? ToolResults.From(await call.Engine.CompleteAsync(
                    call.Actor, taskId, comment, data, call.Idempotency(key, new { taskId, comment, data }), call.CancellationToken));
            }),

        Tool(
            "decide_task", "Decide",
            "Answers a decision, a yes or no question, with an optional justification, and the request moves on. Returns the request.",
            Effect.Transition,
            [
                Required("taskId", Uuid(TaskIdDescription)),
                Required("outcome", new JsonObject { ["type"] = "boolean", ["description"] = "true for yes, false for no." }),
                Optional("justification", Text("An optional justification for the request's timeline.")),
                Required("idempotencyKey", IdempotencyKey),
            ],
            async (call, args) =>
            {
                var taskId = args.Id("taskId", "invalid_task_id");
                var outcome = args.Boolean("outcome", "outcome_required");
                var justification = args.Text("justification", "invalid_justification");
                var key = args.IdempotencyKey();
                return args.Invalid ?? ToolResults.From(await call.Engine.DecideAsync(
                    call.Actor, taskId, outcome, justification, call.Idempotency(key, new { taskId, outcome, justification }), call.CancellationToken));
            }),

        Tool(
            "add_comment", "Add a comment",
            "Adds a text comment to a request's timeline.",
            Effect.Write,
            [Required("requestId", Uuid("The request's id.")), Required("text", Text("The comment.")), Required("idempotencyKey", IdempotencyKey)],
            async (call, args) =>
            {
                var requestId = args.Id("requestId", "invalid_request_id");
                var text = args.Text("text", "invalid_text");
                var key = args.IdempotencyKey();
                return args.Invalid ?? ToolResults.From(await call.Engine.CommentAsync(
                    call.Actor, requestId, text, fileIds: null, call.Idempotency(key, new { requestId, text }), call.CancellationToken));
            }),
    ];

    private const string TaskIdDescription = "The task's id, from list_my_tasks or get_request.";

    /// <summary>What data clears and what it keeps (forms.md F2, "Empty values" and "Groups and lists"; mcp.md §2, "Data").</summary>
    private const string Clearing =
        "An empty value (null, \"\", false for a checkbox, [] for a checklist) clears its field. A key left out changes nothing, " +
        "except a group's: a group is replaced by what you send, or by {} when left out.";

    private static JsonObject IdempotencyKey => new()
    {
        ["type"] = "string",
        ["minLength"] = 1,
        ["maxLength"] = ToolArguments.MaxIdempotencyKeyLength,
        ["description"] = "A key you choose for this action, such as a new UUID. Retrying with the same key and arguments returns the " +
            "first result without acting twice. Use a new key for each new action.",
    };

    /// <summary>The position of a tool in <see cref="All"/>, for a deterministic <c>tools/list</c> order.</summary>
    public static int Order(string name)
    {
        for (var i = 0; i < All.Count; i++)
        {
            if (All[i].ProtocolTool.Name == name)
            {
                return i;
            }
        }

        return int.MaxValue;
    }

    /// <summary>What a tool does to Chain, which sets its annotations. Annotations are hints for clients, never security (ADR-0015 §6.2).</summary>
    private enum Effect
    {
        /// <summary>Reads only.</summary>
        Read,

        /// <summary>Adds: a request, an assignment of unassigned work, a comment.</summary>
        Write,

        /// <summary>Takes work assigned to someone else.</summary>
        Reassign,

        /// <summary>Moves a request on; it cannot be undone.</summary>
        Transition,
    }

    private static ChainTool Tool(
        string name, string title, string description, Effect effect, (string Name, JsonObject Schema, bool Required)[] properties,
        Func<ToolCall, ToolArguments, Task<CallToolResult>> handler)
    {
        var schema = new JsonObject { ["type"] = "object" };
        if (properties.Length > 0)
        {
            schema["properties"] = new JsonObject(properties.Select(p => KeyValuePair.Create(p.Name, (JsonNode?)p.Schema)));
            var required = properties.Where(p => p.Required).Select(p => (JsonNode?)p.Name).ToArray();
            if (required.Length > 0)
            {
                schema["required"] = new JsonArray(required);
            }
        }

        schema["additionalProperties"] = false;
        var definition = new Tool
        {
            Name = name,
            Title = title,
            Description = description,
            InputSchema = JsonSerializer.SerializeToElement(schema),
            Annotations = new ToolAnnotations
            {
                Title = title,
                ReadOnlyHint = effect == Effect.Read,
                DestructiveHint = effect == Effect.Read ? null : effect is Effect.Reassign or Effect.Transition,
                IdempotentHint = effect == Effect.Read ? null : true,
                OpenWorldHint = false,
            },
        };
        return new ChainTool(definition, [.. properties.Select(p => p.Name)], handler);
    }

    private static (string, JsonObject, bool) Required(string name, JsonObject schema) => (name, schema, true);

    private static (string, JsonObject, bool) Optional(string name, JsonObject schema) => (name, schema, false);

    private static JsonObject Uuid(string description) => new() { ["type"] = "string", ["format"] = "uuid", ["description"] = description };

    private static JsonObject Text(string description) => new() { ["type"] = "string", ["description"] = description };

    private static JsonObject Data(string description) => new() { ["type"] = "object", ["description"] = description };

    private static JsonObject Choice(string description, string[] values) => new()
    {
        ["type"] = "string",
        ["enum"] = new JsonArray([.. values.Select(value => JsonValue.Create(value))]),
        ["description"] = description,
    };
}
