using System.Text.Json;
using System.Text.Unicode;
using Chain.Mcp;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Http.Metadata;
using ModelContextProtocol;
using ModelContextProtocol.Protocol;

namespace Chain.Api.Http;

/// <summary>
/// Requests that cannot be read (card #180). Both checks run after authorization, so a caller who may not use an endpoint learns
/// nothing about its body, and inside the MCP body limit.
/// </summary>
internal static class UnreadableRequests
{
    public const string NotJson = "The request body is not valid JSON of the expected shape.";
    public const string Unbound = "The request is missing a required value, or has one that cannot be read.";

    /// <summary>
    /// The largest JSON body under <c>/api</c>: more than twice the largest workflow document the limits allow (identity.md I1,
    /// card #207).
    /// </summary>
    public const long MaxJsonBodyBytes = 8 * 1024 * 1024;

    /// <summary>The SDK's own answer to an MCP body that is not JSON, word for word (mcp.md §3).</summary>
    private const string NotJsonRpc = "Bad Request: The POST body did not contain a valid JSON-RPC message.";

    /// <summary>
    /// Every request under <c>/api</c> that an endpoint cannot read gets 400 <c>validation_failed</c> with a detail (identity.md I1).
    /// Route handlers throw <see cref="BadHttpRequestException"/> when binding fails (<c>ThrowOnBadRequest</c>, set in Program.cs),
    /// where they used to answer a bare 400. And a JSON body whose bytes are not UTF-8 is not JSON (RFC 8259 §8.1) wherever those
    /// bytes are: the serializer skips a property the endpoint does not read without looking at its bytes, so the whole body is
    /// checked before binding.
    /// </summary>
    public static IApplicationBuilder UseUnreadableRequestProblems(this IApplicationBuilder app) => app.Use(async (context, next) =>
    {
        if (!context.Request.Path.StartsWithSegments("/api"))
        {
            await next(context);
            return;
        }

        var readsJson = ReadsJsonBody(context);
        if (readsJson && !LimitJsonBody(context))
        {
            await JsonTooLargeAsync(context);
            return;
        }

        try
        {
            if (readsJson && context.Request.HasJsonContentType() && !await BufferUtf8BodyAsync(context))
            {
                await Problems.WriteUnreadableAsync(context, NotJson);
                return;
            }

            await next(context);
        }
        catch (BadHttpRequestException exception) when (exception.StatusCode == StatusCodes.Status400BadRequest && !context.Response.HasStarted)
        {
            await Problems.WriteUnreadableAsync(context, exception.InnerException is JsonException ? NotJson : Unbound);
            return;
        }
        catch (BadHttpRequestException exception) when (exception.StatusCode == StatusCodes.Status413PayloadTooLarge && readsJson && !context.Response.HasStarted)
        {
            await JsonTooLargeAsync(context); // a body in chunks, cut off by the server at the limit
            return;
        }
        catch (BadHttpRequestException exception) when (exception.StatusCode == StatusCodes.Status415UnsupportedMediaType && !context.Response.HasStarted)
        {
            context.Response.StatusCode = exception.StatusCode; // binding refused it; routing sets the same status without throwing
        }

        // A body that is not JSON by its content type, refused by routing or by binding, gets a problem too (card #207).
        if (context.Response.StatusCode == StatusCodes.Status415UnsupportedMediaType && !context.Response.HasStarted)
        {
            await Problems.WriteAsync(context, StatusCodes.Status415UnsupportedMediaType, "unsupported_media_type", "The request body must be JSON.",
                "Send the body as JSON, with Content-Type: application/json.");
        }
    });

    /// <summary>
    /// Bounds a JSON body to <see cref="MaxJsonBodyBytes"/> (identity.md I1, card #207): false when its declared length is already
    /// larger; otherwise the server cuts it off at the limit while it is read. File uploads read no JSON and keep their own limit.
    /// </summary>
    private static bool LimitJsonBody(HttpContext context)
    {
        if (context.Request.ContentLength > MaxJsonBodyBytes)
        {
            return false;
        }

        if (context.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit)
        {
            limit.MaxRequestBodySize = MaxJsonBodyBytes;
        }

        return true;
    }

    private static Task JsonTooLargeAsync(HttpContext context) =>
        Problems.WriteAsync(context, StatusCodes.Status413PayloadTooLarge, "payload_too_large", "The request body is larger than 8 MiB.");

    /// <summary>
    /// The MCP SDK reads a body that is not UTF-8 as far as it can: such bytes become U+FFFD in arguments, and a tool name with them
    /// throws (a 500). So <c>POST /mcp</c> checks the bytes first, and answers as the SDK answers malformed JSON (mcp.md §3).
    /// </summary>
    public static IApplicationBuilder UseMcpUtf8Check(this IApplicationBuilder app) => app.Use(async (context, next) =>
    {
        if (context.Request.Path.StartsWithSegments(McpRegistration.Path) && HttpMethods.IsPost(context.Request.Method)
            && !await BufferUtf8BodyAsync(context))
        {
            var error = new JsonRpcError { Error = new JsonRpcErrorDetail { Code = (int)McpErrorCode.InvalidRequest, Message = NotJsonRpc } };
            await Results.Json(error, McpJsonUtilities.DefaultOptions, statusCode: StatusCodes.Status400BadRequest).ExecuteAsync(context);
            return;
        }

        await next(context);
    });

    /// <summary>Whether the endpoint binds a JSON body; route handlers declare it as <see cref="IAcceptsMetadata"/>.</summary>
    private static bool ReadsJsonBody(HttpContext context) =>
        context.GetEndpoint()?.Metadata.GetMetadata<IAcceptsMetadata>()?.ContentTypes.Contains("application/json") == true;

    /// <summary>
    /// Reads the whole body into memory, where the endpoint reads it again, and tells whether its bytes are UTF-8. The server's body
    /// limits apply while it is read.
    /// </summary>
    private static async Task<bool> BufferUtf8BodyAsync(HttpContext context)
    {
        var body = new MemoryStream();
        context.Response.RegisterForDispose(body);
        await context.Request.Body.CopyToAsync(body, context.RequestAborted);
        body.Position = 0;
        context.Request.Body = body;
        return Utf8.IsValid(body.GetBuffer().AsSpan(0, (int)body.Length));
    }
}
