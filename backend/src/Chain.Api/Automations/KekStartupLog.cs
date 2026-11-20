using Chain.Automations;

namespace Chain.Api.Automations;

/// <summary>
/// At startup the API logs its KEKs' ids with their check values, and its active id (ADR-0017 §5.2), so an operator can match
/// them with the automation service's. Never key material.
/// </summary>
internal static partial class KekStartupLog
{
    public static void Write(ILogger logger, KeyRing ring)
    {
        var keys = string.Join(", ", ring.Ids.Order(StringComparer.Ordinal).Select(id => $"{id} (check {ring.Find(id)!.CheckValue})"));
        LogKeks(logger, keys.Length == 0 ? "none" : keys, ring.Active?.Id ?? "none");
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Automation KEKs: {Keys}. Active: {Active}.")]
    private static partial void LogKeks(ILogger logger, string keys, string active);
}
