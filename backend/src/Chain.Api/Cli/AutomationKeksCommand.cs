using System.Globalization;
using Chain.Automations;
using Chain.Automations.Application;

namespace Chain.Api.Cli;

/// <summary>
/// <c>dotnet Chain.Api.dll automation-keks status|rewrap</c> (ADR-0017 §5.2, card #77): the KEK rotation's command, run in a
/// one-off container of the API image with the API's configuration, as <c>bootstrap-admin</c> is. It prints key ids, check
/// values, secret names, versions and counts, and never key material, wrapped keys or values. Exit codes: 0 when every secret
/// is on the active key and opens with it, 1 when some failed or remain on another key, 2 for a usage or configuration error.
/// </summary>
public static class AutomationKeksCommand
{
    public const string Name = "automation-keks";

    public static async Task<int> RunAsync(string[] args, IServiceProvider services, TextWriter output, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(args);
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(output);

        if (args is not [Name, var verb] || verb is not ("status" or "rewrap"))
        {
            await output.WriteLineAsync($"Usage: {Name} status | {Name} rewrap");
            return 2;
        }

        await using var scope = services.CreateAsyncScope();
        var service = scope.ServiceProvider.GetRequiredService<KekRotationService>();
        return verb == "status" ? await StatusAsync(service, output, cancellationToken) : await RewrapAsync(service, output, cancellationToken);
    }

    /// <summary>Read-only: exit code 0 when every secret unwraps with a configured key, 1 otherwise.</summary>
    private static async Task<int> StatusAsync(KekRotationService service, TextWriter output, CancellationToken cancellationToken)
    {
        var status = await service.StatusAsync(cancellationToken);
        await WriteKeysAsync(status.Keys, output);
        var configured = status.Keys.Select(key => key.Id).ToHashSet(StringComparer.Ordinal);
        await output.WriteLineAsync("Secrets per key: " + (status.SecretsPerKey.Count == 0
            ? "none"
            : string.Join(", ", status.SecretsPerKey.Select(pair => $"{pair.Key}: {Count(pair.Value)}{(configured.Contains(pair.Key) ? string.Empty : " (not configured)")}"))));
        foreach (var problem in status.Problems)
        {
            await output.WriteLineAsync($"Does not open: {problem.Name} v{Count(problem.Version)} on {problem.KeyId}: {Reason(problem.Reason)}.");
        }

        return status.Problems.Count == 0 ? 0 : 1;
    }

    private static async Task<int> RewrapAsync(KekRotationService service, TextWriter output, CancellationToken cancellationToken)
    {
        var report = await service.RewrapAsync(
            moved => output.WriteLine($"{moved.Name} v{Count(moved.Version)}: {moved.FromKeyId} -> {moved.ToKeyId} ({Count(moved.Position)}/{Count(moved.Count)})"),
            cancellationToken);
        if (report is null)
        {
            await output.WriteLineAsync("No active KEK: set Chain__Automation__ActiveKek before re-wrapping.");
            return 2;
        }

        foreach (var problem in report.Failed)
        {
            await output.WriteLineAsync($"Not moved: {problem.Name} v{Count(problem.Version)} on {problem.KeyId}: {Reason(problem.Reason)}.");
        }

        foreach (var name in report.Gone)
        {
            await output.WriteLineAsync($"Deleted during the run: {name}.");
        }

        var left = report.Left.Count == 0 ? "none" : string.Join(", ", report.Left.Select(pair => $"{pair.Key}: {Count(pair.Value)}"));
        await output.WriteLineAsync(
            $"Moved: {Count(report.Moved)}. Already on {report.ActiveKeyId}: {Count(report.Current)}. Failed: {Count(report.Failed.Count)}. Secrets per key: {left}. Run: {report.RunId}.");
        return report.Complete ? 0 : 1;
    }

    private static async Task WriteKeysAsync(IReadOnlyList<KekInfo> keys, TextWriter output)
    {
        await output.WriteLineAsync("Keys: " + (keys.Count == 0
            ? "none"
            : string.Join(", ", keys.Select(key => $"{key.Id} (check {key.CheckValue}{(key.Active ? ", active" : string.Empty)})"))));
    }

    private static string Reason(KeyCheck reason) =>
        reason == KeyCheck.KeyNotConfigured ? "its key is not configured" : "it does not open with its key";

    private static string Count(int value) => value.ToString(CultureInfo.InvariantCulture);
}
