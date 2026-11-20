using Chain.Automations;

namespace Chain.Api.Automations;

/// <summary>
/// Stops the API outside the Development environment when it is given docker-compose.yml's development KEK or result token,
/// which are published (automation.md §4.1, card #164). The message names the settings, never a value.
/// </summary>
internal static class DevelopmentValuesGuard
{
    public static void Refuse(IConfiguration configuration, IHostEnvironment environment)
    {
        if (environment.IsDevelopment())
        {
            return;
        }

        var ring = KeyRing.Parse(configuration["Chain:Automation:Keks"], configuration["Chain:Automation:ActiveKek"]);
        if (DevelopmentValues.Find(ring, configuration["Chain:Automation:ResultTokenSha256"]) is { Count: > 0 } found)
        {
            throw new InvalidOperationException(
                $"Refusing to start in the '{environment.EnvironmentName}' environment: {string.Join("; ", found)}. "
                + "These development values of docker-compose.yml are published; configure your own (automation.md §4.1).");
        }
    }
}
