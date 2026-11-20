using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using Chain.Api.Auth;
using Chain.Api.Http;
using Chain.Forms;
using Chain.Workflows.Application.Engine;
using Chain.Workflows.Application.Files;
using Chain.Workflows.Files;

namespace Chain.Api.Files;

internal static class FileEndpoints
{
    private const int MaxIdempotencyKeyLength = 200;

    public static IEndpointRouteBuilder MapFileEndpoints(this IEndpointRouteBuilder routes)
    {
        var api = routes.MapGroup("/api").RequireAuthorization();
        api.MapPost("/files", UploadAsync);
        // The configured size limit, which clients check before sending (ADR-0014 §4.3 and §5, card #195).
        api.MapGet("/files/limits", (FileSettings settings) => Results.Ok(new { maxBytes = settings.MaxBytes }));
        api.MapGet("/files/{id:guid}", DownloadAsync);
        return routes;
    }

    private static async Task<IResult> UploadAsync(HttpContext http, FileService files, FileSettings settings)
    {
        var key = http.Request.Headers["Idempotency-Key"].ToString().Trim();
        if (key.Length == 0)
        {
            return Problems.Create(StatusCodes.Status400BadRequest, "idempotency_key_required", "The Idempotency-Key header is required.");
        }

        if (key.Length > MaxIdempotencyKeyLength)
        {
            return Problems.ValidationFailed("idempotency_key_too_long");
        }

        if (!http.Request.HasFormContentType)
        {
            return Problems.ValidationFailed("exactly_one_file");
        }

        IFormCollection form;
        try
        {
            form = await http.Request.ReadFormAsync(http.RequestAborted);
        }
        catch (InvalidDataException)
        {
            return TooLarge();
        }

        if (form.Files.Count != 1)
        {
            return Problems.ValidationFailed("exactly_one_file");
        }

        var upload = form.Files[0];
        var name = FileRules.SanitizeName(upload.FileName);
        if (name is null)
        {
            return Problems.ValidationFailed("file_name_invalid");
        }

        await using var input = upload.OpenReadStream();
        await using var spool = await FileSpool.ToSeekableAsync(input, settings.MaxBytes, http.RequestAborted);
        if (spool.TooLarge)
        {
            return TooLarge();
        }

        var detected = FileRules.Detect(spool.Content, name);
        if (!detected.IsAllowed)
        {
            return Problems.Create(StatusCodes.Status415UnsupportedMediaType, "file_type_not_allowed", "The file type is not allowed.");
        }

        var fingerprint = $"POST {http.Request.Path}\n{spool.Sha256}\n{name}";
        var hash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(fingerprint)));
        var result = await files.StoreAsync(
            http.User.ToCaller().UserId, name, detected.ContentType!, spool.Size, spool.Sha256, spool.Content, new Idempotency(key, hash), http.RequestAborted);
        return result.Error switch
        {
            null => TypedResults.Created($"/api/files/{result.Value!.Id}", result.Value),
            EngineError.NotFound => Problems.Create(StatusCodes.Status404NotFound, "not_found", "The resource does not exist."),
            EngineError.IdempotencyKeyReused => Problems.Create(StatusCodes.Status422UnprocessableEntity, "idempotency_key_reused", "The Idempotency-Key was already used for a different request."),
            _ => throw new InvalidOperationException($"Unexpected file result {result.Error}."),
        };
    }

    private static async Task<IResult> DownloadAsync(Guid id, HttpContext http, FileService files)
    {
        var authorized = await files.AuthorizeAsync(http.User.ToCaller().UserId, id, http.RequestAborted);
        if (authorized.Error is not null || authorized.Value is not { } file)
        {
            return Problems.Create(StatusCodes.Status404NotFound, "not_found", "The resource does not exist.");
        }

        return new DownloadResult(file, files);
    }

    private sealed class DownloadResult(StoredFile file, FileService files) : IResult
    {
        public async Task ExecuteAsync(HttpContext httpContext)
        {
            var inline = file.ContentType is "image/png" or "image/jpeg" or "image/gif" or "image/webp";
            var disposition = new ContentDispositionHeaderValue(inline ? "inline" : "attachment") { FileNameStar = file.OriginalName };
            var response = httpContext.Response;
            response.StatusCode = StatusCodes.Status200OK;
            response.ContentType = file.ContentType;
            response.ContentLength = file.SizeBytes;
            response.Headers.ContentDisposition = disposition.ToString();
            response.Headers.XContentTypeOptions = "nosniff";
            response.Headers.ContentSecurityPolicy = "sandbox; default-src 'none'";
            response.Headers.CacheControl = "private, no-store";
            await files.CopyAsync(file.Id, response.Body, httpContext.RequestAborted);
        }
    }

    private static IResult TooLarge() =>
        Problems.Create(StatusCodes.Status413PayloadTooLarge, "file_too_large", "The file is larger than the limit.");
}
