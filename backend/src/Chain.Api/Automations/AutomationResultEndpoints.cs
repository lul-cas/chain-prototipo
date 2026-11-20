using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.Unicode;
using Chain.Api.Auth;
using Chain.Api.Http;
using Chain.SharedKernel;
using Chain.Workflows.Application.Engine;
using Microsoft.AspNetCore.Http.Features;

namespace Chain.Api.Automations;

/// <summary>The result body of automation-contract.md §4.2: every field present, nothing else.</summary>
internal sealed record ResultBody
{
    public required int ContractVersion { get; init; }
    public required Guid RequestId { get; init; }
    public required int Activation { get; init; }
    public required string Outcome { get; init; }
    public required ResultOutput? Output { get; init; }
    public required ResultError? Error { get; init; }
    public required JsonArray Attempts { get; init; }
}

internal sealed record ResultOutput
{
    public required int Status { get; init; }
    public required JsonNode? Body { get; init; }
}

internal sealed record ResultError
{
    public required string Class { get; init; }
    public required string Message { get; init; }
    public int? Status { get; init; }
}

/// <summary>
/// <c>POST /internal/automation/results</c> (automation-contract.md §4): Elixir reports the outcome of a work request. Only the
/// internal listener serves it, and only the result token authenticates it (<see cref="AutomationResultAuthenticationHandler"/>).
/// </summary>
internal static partial class AutomationResultEndpoints
{
    public const string Path = "/internal/automation/results";
    public const int MaxBodyBytes = 16 * 1024 * 1024;

    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        RespectNullableAnnotations = true,
    };

    /// <summary>A target's answer is nested at most this deep; Elixir refuses a deeper one (automation-contract.md §4.2, card #191).</summary>
    private const int MaxAnswerDepth = 32;

    /// <summary>
    /// A property twice in any object, at any depth, makes the body invalid: which value counts would be ambiguous. The answer sits
    /// two levels down, in the result's <c>output</c>, so the result is read that much deeper than the answer, and no deeper.
    /// </summary>
    private static readonly JsonDocumentOptions Document = new() { AllowDuplicateProperties = false, MaxDepth = MaxAnswerDepth + 2 };

    public static IEndpointRouteBuilder MapAutomationResultEndpoints(this IEndpointRouteBuilder routes)
    {
        routes.MapPost(Path, async (HttpContext http, InstanceService engine, ILogger<ResultBody> logger) =>
        {
            if (await ReadAsync(http) is not { } bytes)
            {
                return Problems.Create(StatusCodes.Status413PayloadTooLarge, "payload_too_large", "The result body is larger than 16 MiB.");
            }

            // Bytes that are not UTF-8 are not JSON (RFC 8259 §8.1): refused, not read with U+FFFD in their place (card #207).
            if (!Utf8.IsValid(bytes) || Parse(Encoding.UTF8.GetString(bytes)) is not { } input)
            {
                return Problems.Create(StatusCodes.Status400BadRequest, "invalid_result", "The body is not a result of contractVersion 1 (automation-contract.md §4.2).");
            }

            var answer = await engine.ApplyAutomationResultAsync(input, http.RequestAborted);
            switch (answer.Disposition)
            {
                case AutomationResultDisposition.Conflict:
                    LogConflict(logger, input.RequestId);
                    return Problems.Create(StatusCodes.Status409Conflict, "result_conflict", "A different result for this request was already received.");
                case AutomationResultDisposition.UnknownRequest:
                    return Problems.Create(StatusCodes.Status404NotFound, "unknown_request", "No automation request has this id.");
                default:
                    return Results.Text(answer.Response, "application/json", Encoding.UTF8);
            }
        }).RequireAuthorization(AutomationResultAuthenticationHandler.Policy);

        return routes;
    }

    /// <summary>The body's bytes, or null when it is larger than <see cref="MaxBodyBytes"/>.</summary>
    private static async Task<byte[]?> ReadAsync(HttpContext http)
    {
        if (http.Request.ContentLength > MaxBodyBytes)
        {
            return null;
        }

        if (http.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit)
        {
            limit.MaxRequestBodySize = MaxBodyBytes + 1L; // above the server-wide limit, which is sized for file uploads
        }

        using var buffer = new MemoryStream();
        var chunk = new byte[81920];
        try
        {
            int read;
            while ((read = await http.Request.Body.ReadAsync(chunk, http.RequestAborted)) > 0)
            {
                if (buffer.Length + read > MaxBodyBytes)
                {
                    return null;
                }

                buffer.Write(chunk, 0, read);
            }
        }
        catch (BadHttpRequestException exception) when (exception.StatusCode == StatusCodes.Status413PayloadTooLarge)
        {
            return null;
        }

        return buffer.ToArray();
    }

    /// <summary>The result, if the body is one: the contract's fields only, version 1, and an output or an error matching the outcome.</summary>
    private static AutomationResultInput? Parse(string raw)
    {
        ResultBody? body;
        string hash;
        using (var document = Read(raw))
        {
            if (document is null)
            {
                return null;
            }

            try
            {
                body = document.Deserialize<ResultBody>(Options);
            }
            catch (JsonException)
            {
                return null;
            }

            // A string with an unpaired surrogate has no canonical form, because System.Text.Json writes it only by throwing. Such a
            // body is hashed as received, so only the same text replays (automation-contract.md §4.3, card #154).
            hash = ContentHash.ForCanonical(ClientText.IsUnicode(document.RootElement) ? ContentHash.Canonicalize(raw) : raw);
        }

        if (body is not { ContractVersion: 1, Activation: >= 1 } || !body.Attempts.All(attempt => attempt is JsonObject))
        {
            return null;
        }

        return body switch
        {
            { Outcome: "succeeded", Output: { } output, Error: null } =>
                new AutomationResultInput(body.RequestId, body.Activation, true, output.Status, output.Body, null, null, body.Attempts, hash),
            { Outcome: "failed", Output: null, Error: { } error } =>
                new AutomationResultInput(body.RequestId, body.Activation, false, null, null, error.Class, error.Message, body.Attempts, hash),
            _ => null,
        };
    }

    /// <summary>
    /// The body as a document, or null when it is not JSON, or has a property twice in one object. The duplicate check reads every
    /// property name, and System.Text.Json reads a name that is not Unicode text only by throwing, so such a name is refused too
    /// (automation-contract.md §4.3, card #154).
    /// </summary>
    private static JsonDocument? Read(string raw)
    {
        try
        {
            return JsonDocument.Parse(raw, Document);
        }
        catch (JsonException)
        {
            return null;
        }
        catch (InvalidOperationException)
        {
            return null;
        }
    }

    [LoggerMessage(Level = LogLevel.Error, Message = "A different result for automation request {RequestId} was already received (result_conflict)")]
    private static partial void LogConflict(ILogger logger, Guid requestId);
}
