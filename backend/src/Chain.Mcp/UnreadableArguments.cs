using System.Text.Json;
using System.Text.Json.Nodes;
using Chain.SharedKernel;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Chain.Mcp;

/// <summary>
/// Tool arguments whose text is not Unicode, such as an unpaired surrogate (<c>\ud800</c>), found before the SDK reads them
/// (mcp.md §3, card #205). The SDK reads arguments by throwing on such text, which answered JSON-RPC <c>-32603</c>. So an incoming
/// message filter takes each such value out, as JSON null, and records its name, and <see cref="ToolArguments"/> reports it with
/// the argument's own problem.
/// </summary>
internal sealed record UnreadableArguments(IReadOnlySet<string> Values, bool Names)
{
    private const string Key = "chain.unreadableArguments";

    public static readonly UnreadableArguments None = new(new HashSet<string>(), false);

    /// <summary>What the filter recorded for this request, or <see cref="None"/>.</summary>
    public static UnreadableArguments Of(IDictionary<string, object?> items) =>
        items.TryGetValue(Key, out var found) && found is UnreadableArguments unreadable ? unreadable : None;

    public static McpMessageHandler Filter(McpMessageHandler next) => async (context, cancellationToken) =>
    {
        if (context.JsonRpcMessage is JsonRpcRequest { Method: RequestMethods.ToolsCall, Params: JsonObject parameters }
            && Take(parameters) is { } unreadable)
        {
            context.Items[Key] = unreadable;
        }

        await next(context, cancellationToken);
    };

    /// <summary>Takes the unreadable values out of the call's arguments; null when every argument can be read.</summary>
    private static UnreadableArguments? Take(JsonObject parameters)
    {
        List<string> names;
        try
        {
            if (parameters["arguments"] is not JsonObject arguments)
            {
                return null;
            }

            try
            {
                names = [.. arguments.Select(argument => argument.Key)]; // reading the names throws on one that is not Unicode
            }
            catch (InvalidOperationException)
            {
                parameters["arguments"] = new JsonObject(); // none of them can be read
                return new UnreadableArguments(new HashSet<string>(), Names: true);
            }

            var values = names.Where(name => !IsUnicode(arguments[name])).ToHashSet(StringComparer.Ordinal);
            foreach (var name in values)
            {
                arguments[name] = null;
            }

            return values.Count > 0 ? new UnreadableArguments(values, Names: false) : null;
        }
        catch (InvalidOperationException)
        {
            return null; // text outside the arguments, such as _meta: the SDK answers as before
        }
    }

    /// <summary>Whether every string and property name in <paramref name="node"/> is Unicode text.</summary>
    private static bool IsUnicode(JsonNode? node)
    {
        try
        {
            return node switch
            {
                JsonObject members => members.All(member => IsUnicode(member.Value)),
                JsonArray items => items.All(IsUnicode),
                JsonValue value => !value.TryGetValue(out JsonElement element) || ClientText.IsUnicode(element),
                _ => true,
            };
        }
        catch (InvalidOperationException)
        {
            return false; // a property name that is not Unicode
        }
    }
}
