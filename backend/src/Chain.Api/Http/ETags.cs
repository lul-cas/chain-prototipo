using System.Globalization;

namespace Chain.Api.Http;

/// <summary>Version tags for optimistic concurrency over HTTP (ADR-0008 §3).</summary>
internal static class ETags
{
    public static string Format(uint version) => $"\"{version.ToString(CultureInfo.InvariantCulture)}\"";

    public static bool TryParse(string header, out uint version)
    {
        var tag = header.Trim();
        if (tag.StartsWith("W/", StringComparison.Ordinal))
        {
            tag = tag[2..];
        }

        return uint.TryParse(tag.Trim('"'), NumberStyles.None, CultureInfo.InvariantCulture, out version);
    }

    /// <summary>Reads <c>If-Match</c>: null result with a problem when missing (428) or unparsable (412).</summary>
    public static uint? ReadIfMatch(HttpContext http, out IResult? problem)
    {
        problem = null;
        var ifMatch = http.Request.Headers.IfMatch.ToString();
        if (string.IsNullOrWhiteSpace(ifMatch))
        {
            problem = Problems.Create(StatusCodes.Status428PreconditionRequired, "precondition_required", "The If-Match header with the current version is required.");
            return null;
        }

        if (!TryParse(ifMatch, out var version))
        {
            problem = VersionMismatch();
            return null;
        }

        return version;
    }

    public static IResult VersionMismatch() =>
        Problems.Create(StatusCodes.Status412PreconditionFailed, "version_mismatch", "The resource was changed since it was loaded.");
}
