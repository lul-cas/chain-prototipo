using System.Diagnostics;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Chain.SharedKernel;
using Chain.Workflows.Application.Engine;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Chain.Mcp;

/// <summary>What a tool's handler gets for one call: the calling bot, the engine, and the call's cancellation.</summary>
internal sealed record ToolCall(string Tool, Guid Actor, InstanceService Engine, CancellationToken CancellationToken)
{
    /// <summary>
    /// The idempotency context of a write tool (mcp.md §4): the client's key, and a hash of the tool and its other arguments, which
    /// joins the bot's key space of the HTTP API (ADR-0008 §4).
    /// </summary>
    public Idempotency Idempotency(string key, object arguments)
    {
        var fingerprint = $"mcp {Tool}\n{JsonSerializer.Serialize(arguments)}";
        return new Idempotency(key, Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(fingerprint))));
    }
}

/// <summary>
/// One MCP tool: its protocol definition and a handler that makes one application-service call (ADR-0015 §6.1). The call is counted
/// against the bot's rate limit before anything else happens (mcp.md §5).
/// </summary>
internal sealed partial class ChainTool(Tool definition, IReadOnlyList<string> arguments, Func<ToolCall, ToolArguments, Task<CallToolResult>> handler)
    : McpServerTool
{
    public override Tool ProtocolTool => definition;

    public override IReadOnlyList<object> Metadata => [];

    public override async ValueTask<CallToolResult> InvokeAsync(RequestContext<CallToolRequestParams> request, CancellationToken cancellationToken)
    {
        var services = request.Services ?? throw new InvalidOperationException("The MCP request has no services.");
        var actor = Guid.Parse(request.User?.FindFirstValue(ClaimTypes.NameIdentifier)
            ?? throw new InvalidOperationException("The MCP request has no authenticated bot."));
        var calledAt = services.GetRequiredService<TimeProvider>().GetUtcNow();
        var started = Stopwatch.GetTimestamp();
        CallToolResult? result = null;
        try
        {
            result = await CallAsync(request, services, actor, cancellationToken);
            return result;
        }
        finally
        {
            await LogAsync(request, services, actor, calledAt, Stopwatch.GetElapsedTime(started), result);
        }
    }

    private async Task<CallToolResult> CallAsync(
        RequestContext<CallToolRequestParams> request, IServiceProvider services, Guid actor, CancellationToken cancellationToken)
    {
        if (await services.GetRequiredService<IMcpRateLimiter>().TryAcquireAsync(actor, cancellationToken) is { Allowed: false } refused)
        {
            return ToolResults.Error("rate_limited", $"Too many tool calls. Retry in {refused.RetryAfterSeconds} seconds.",
                retryAfterSeconds: refused.RetryAfterSeconds);
        }

        var call = new ToolCall(definition.Name, actor, services.GetRequiredService<InstanceService>(), cancellationToken);
        try
        {
            return await handler(call, new ToolArguments(request.Params?.Arguments, arguments, UnreadableArguments.Of(request.Items)));
        }
        catch (Exception exception) when (exception is ConcurrencyConflictException or UniqueConstraintViolationException)
        {
            // The HTTP API answers 409 concurrency_conflict here (ADR-0008 §2): another request changed the same record first.
            return ToolResults.Error("concurrency_conflict", "The record was changed by another request. Read it again and retry.");
        }
    }

    /// <summary>
    /// Writes the call log's row (mcp.md §6.1): never the arguments, only their hash. A failure to write it is logged and leaves the
    /// call's answer as it is.
    /// </summary>
    private async Task LogAsync(
        RequestContext<CallToolRequestParams> request, IServiceProvider services, Guid actor, DateTimeOffset calledAt, TimeSpan duration,
        CallToolResult? result)
    {
        try
        {
            var arguments = request.Params?.Arguments;
            var client = request.Params?.Meta?["io.modelcontextprotocol/clientInfo"] as JsonObject;
            var call = new McpCall(
                actor, definition.Name, Outcome(result), (int)Math.Min(duration.TotalMilliseconds, int.MaxValue), Activity.Current?.TraceId.ToString(),
                KeyOf(arguments), Declared(client, "name"), Declared(client, "version"),
                ContentHash.Compute(JsonSerializer.Serialize(arguments ?? new Dictionary<string, JsonElement>())), calledAt);
            await services.GetRequiredService<IMcpCallLog>().RecordAsync(call, CancellationToken.None);
        }
        catch (Exception exception)
        {
            LogNotRecorded(services.GetRequiredService<ILogger<ChainTool>>(), definition.Name, exception);
        }
    }

    /// <summary><c>ok</c>, the tool error's code, or <c>error</c> for a failure without one.</summary>
    private static string Outcome(CallToolResult? result) =>
        result is null ? "error"
        : result.IsError != true ? "ok"
        : result.StructuredContent is { ValueKind: JsonValueKind.Object } error && error.TryGetProperty("code", out var code) && code.GetString() is { } text
            ? text
            : "error";

    /// <summary>The <c>idempotencyKey</c> argument, trimmed, when it is storable text of at most 200 characters.</summary>
    private static string? KeyOf(IDictionary<string, JsonElement>? arguments) =>
        arguments is not null && arguments.TryGetValue("idempotencyKey", out var value) && value.ValueKind == JsonValueKind.String
        && value.GetString()?.Trim() is { Length: > 0 and <= ToolArguments.MaxIdempotencyKeyLength } key && ClientText.IsStorable(key)
            ? key
            : null;

    /// <summary>A value of the self-declared <c>clientInfo</c>, cut to 200 characters; null when it is absent or not storable text.</summary>
    private static string? Declared(JsonObject? client, string property)
    {
        if (client?[property] is not JsonValue value || !value.TryGetValue(out string? text))
        {
            return null;
        }

        var cut = text.Length <= 200 ? text : text[..(char.IsHighSurrogate(text[199]) ? 199 : 200)];
        return ClientText.IsStorable(cut) ? cut : null;
    }

    [LoggerMessage(Level = LogLevel.Error, Message = "The MCP call to {Tool} was not written to the call log")]
    private static partial void LogNotRecorded(ILogger logger, string tool, Exception exception);
}
