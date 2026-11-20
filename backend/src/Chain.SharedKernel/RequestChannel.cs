namespace Chain.SharedKernel;

/// <summary>The way a caller's request came in (ADR-0015 §8; workflow-engine.md §8): the web app, the HTTP API with a bot's token, or MCP.</summary>
public enum RequestChannel
{
    Ui,
    Api,
    Mcp,
}

/// <summary>
/// The channel of the current request, for timeline events and audit records (workflow-engine.md §8; card #83). It is null outside
/// a caller's request: background work such as the watchdog, and the automation result call. The host decides it from the way the
/// caller authenticated, never from anything the client sends.
/// </summary>
public interface IRequestChannel
{
    RequestChannel? Current { get; }
}

public static class RequestChannels
{
    /// <summary>The channel as it is stored and shown: <c>ui</c>, <c>api</c> or <c>mcp</c>.</summary>
    public static string Name(this RequestChannel channel) => channel switch
    {
        RequestChannel.Ui => "ui",
        RequestChannel.Api => "api",
        RequestChannel.Mcp => "mcp",
        _ => throw new ArgumentOutOfRangeException(nameof(channel), channel, "Unknown channel."),
    };
}
