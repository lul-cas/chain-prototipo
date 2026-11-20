namespace Chain.Workflows.Definitions;

/// <summary>A publish-validation finding. <paramref name="ElementId"/> identifies the offending lane, node or flow, when there is one.</summary>
public sealed record ValidationError(string Code, string Message, string? ElementId = null);
