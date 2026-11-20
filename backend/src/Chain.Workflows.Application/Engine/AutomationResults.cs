using System.Text.Json.Nodes;

namespace Chain.Workflows.Application.Engine;

/// <summary>A result call's body (automation-contract.md §4.2), already checked against the contract by the API.</summary>
public sealed record AutomationResultInput(
    Guid RequestId, int Activation, bool Succeeded, int? OutputStatus, JsonNode? OutputBody, string? ErrorClass, string? ErrorMessage,
    JsonArray Attempts, string PayloadHash);

public enum AutomationResultDisposition
{
    Applied,
    Ignored,
    Replayed,
    Conflict,
    UnknownRequest,
}

/// <summary>What the result call answers (automation-contract.md §4.3). <see cref="Response"/> is the stored JSON of the 200 cases.</summary>
public sealed record AutomationResultAnswer(AutomationResultDisposition Disposition, string? Response);
