using System.Text.Json;
using Chain.Automations;
using Chain.Workflows.Definitions;

namespace Chain.Workflows.Application;

/// <summary>WF107, WF108 and WF110: an automation step against the version it is pinned to (automation.md §5.5).</summary>
internal static class AutomationStepRules
{
    public static IEnumerable<ValidationError> Check(Node step, AutomationReference reference, PublishedAutomation automation)
    {
        // Admins may have deleted or rebound the secrets and destination since the automation was published. WF107 repeats AU102,
        // and WF108 repeats AU101, AU103 and AU104. The path prefix and host (AU105, AU106) are left to execution (§8.1).
        foreach (var issue in AutomationRules.CheckReferences(automation.Document, automation.Destination, automation.Secrets))
        {
            var code = issue.Code switch
            {
                "AU102" => "WF107",
                "AU101" or "AU103" or "AU104" => "WF108",
                _ => null,
            };

            if (code is not null)
            {
                yield return new ValidationError(code, $"Automation version {automation.Version}: {issue.Message}", step.Id);
            }
        }

        var mapped = reference.Inputs ?? new Dictionary<string, JsonElement>();
        var declared = automation.Document.Inputs.Select(input => input.Key).ToHashSet(StringComparer.Ordinal);
        foreach (var key in mapped.Keys.Where(key => !declared.Contains(key)))
        {
            yield return new ValidationError("WF110", $"Automation version {automation.Version} has no input '{key}'.", step.Id);
        }

        foreach (var input in automation.Document.Inputs.Where(input => input.Required && !mapped.ContainsKey(input.Key)))
        {
            yield return new ValidationError("WF110", $"Automation version {automation.Version} requires the input '{input.Key}', which is not mapped.", step.Id);
        }
    }
}
