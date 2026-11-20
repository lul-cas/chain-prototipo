using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Chain.Forms;

/// <summary>A file a submission references, as the server knows it (forms.md F4).</summary>
public sealed record FileBinding(Guid UploadedBy, bool IsPending, string Name, long Size, string ContentType)
{
    /// <summary>
    /// Already attached to the instance being submitted to, through one of its submissions: it may be sent again unchanged,
    /// whoever uploaded it, and is not attached again (owner decision A, card #69).
    /// </summary>
    public bool AttachedToThisInstance { get; init; }
}

public readonly record struct FileDetection(string? ContentType)
{
    public bool IsAllowed => ContentType is not null;
}

public static class FileRules
{
    public const long MaxBytes = 25L * 1024 * 1024;
    public const int MaxFiles = 10;
    public const int MaxNameLength = 255;

    private static readonly (string ContentType, string[] Extensions)[] Types =
    [
        ("application/pdf", [".pdf"]),
        ("image/png", [".png"]),
        ("image/jpeg", [".jpg", ".jpeg"]),
        ("image/gif", [".gif"]),
        ("image/webp", [".webp"]),
        ("text/plain", [".txt"]),
        ("text/csv", [".csv"]),
        ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", [".docx"]),
        ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", [".xlsx"]),
        ("application/vnd.openxmlformats-officedocument.presentationml.presentation", [".pptx"]),
        ("application/vnd.oasis.opendocument.text", [".odt"]),
        ("application/vnd.oasis.opendocument.spreadsheet", [".ods"]),
        ("application/vnd.oasis.opendocument.presentation", [".odp"]),
    ];

    public static bool IsAllowedContentType(string contentType) =>
        Types.Any(type => type.ContentType == contentType);

    public static string? SanitizeName(string? name)
    {
        if (string.IsNullOrEmpty(name))
        {
            return null;
        }

        string normalized;
        try
        {
            normalized = name.Normalize(NormalizationForm.FormC);
        }
        catch (ArgumentException)
        {
            return null;
        }

        var builder = new StringBuilder(normalized.Length);
        foreach (var character in normalized)
        {
            if (!char.IsControl(character) && character is not ('/' or '\\'))
            {
                builder.Append(character);
            }
        }

        return builder.Length is 0 or > MaxNameLength ? null : builder.ToString();
    }

    public static FileDetection Detect(Stream content, string sanitizedName)
    {
        ArgumentNullException.ThrowIfNull(content);
        if (!content.CanSeek)
        {
            throw new ArgumentException("The content stream must be seekable.", nameof(content));
        }

        var extension = ExtensionOf(sanitizedName);
        try
        {
            var detected = Signature(content) ?? Office(content);
            if (detected is null && !StartsWithMarkup(content) && IsUtf8Text(content))
            {
                detected = extension switch
                {
                    ".txt" => "text/plain",
                    ".csv" => "text/csv",
                    _ => null,
                };
            }

            if (detected is null || !Types.Any(type => type.ContentType == detected && type.Extensions.Contains(extension, StringComparer.Ordinal)))
            {
                return default;
            }

            return new FileDetection(detected);
        }
        finally
        {
            content.Position = 0;
        }
    }

    public static List<Guid> CollectIds(JsonElement element)
    {
        var ids = new List<Guid>();
        Walk(element, ids);
        return ids;
    }

    private static void Walk(JsonElement element, List<Guid> ids)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                foreach (var property in element.EnumerateObject())
                {
                    if (property.NameEquals("fileId") && property.Value.ValueKind == JsonValueKind.String && Guid.TryParse(property.Value.GetString(), out var id))
                    {
                        ids.Add(id);
                    }
                    else
                    {
                        Walk(property.Value, ids);
                    }
                }

                break;
            case JsonValueKind.Array:
                foreach (var item in element.EnumerateArray())
                {
                    Walk(item, ids);
                }

                break;
        }
    }

    private static string ExtensionOf(string name)
    {
        var dot = name.LastIndexOf('.');
        return dot <= 0 || dot == name.Length - 1 ? string.Empty : name[dot..].ToLowerInvariant();
    }

    private static string? Signature(Stream content)
    {
        content.Position = 0;
        Span<byte> header = stackalloc byte[16];
        var read = content.Read(header);
        if (read >= 4 && header[0] == (byte)'%' && header[1] == (byte)'P' && header[2] == (byte)'D' && header[3] == (byte)'F')
        {
            return "application/pdf";
        }

        if (read >= 8 && header[0] == 0x89 && header[1] == 0x50 && header[2] == 0x4E && header[3] == 0x47
            && header[4] == 0x0D && header[5] == 0x0A && header[6] == 0x1A && header[7] == 0x0A)
        {
            return "image/png";
        }

        if (read >= 3 && header[0] == 0xFF && header[1] == 0xD8 && header[2] == 0xFF)
        {
            return "image/jpeg";
        }

        if (read >= 6 && header[0] == (byte)'G' && header[1] == (byte)'I' && header[2] == (byte)'F' && header[3] == (byte)'8'
            && (header[4] == (byte)'7' || header[4] == (byte)'9') && header[5] == (byte)'a')
        {
            return "image/gif";
        }

        if (read >= 12 && header[0] == (byte)'R' && header[1] == (byte)'I' && header[2] == (byte)'F' && header[3] == (byte)'F'
            && header[8] == (byte)'W' && header[9] == (byte)'E' && header[10] == (byte)'B' && header[11] == (byte)'P')
        {
            return "image/webp";
        }

        return null;
    }

    private static string? Office(Stream content)
    {
        content.Position = 0;
        Span<byte> header = stackalloc byte[4];
        if (content.Read(header) < 2 || header[0] != (byte)'P' || header[1] != (byte)'K')
        {
            return null;
        }

        content.Position = 0;
        try
        {
            using var zip = new ZipArchive(content, ZipArchiveMode.Read, leaveOpen: true);
            if (zip.GetEntry("mimetype") is { } mimetype)
            {
                var value = ReadText(mimetype, 200)?.Trim();
                return value is "application/vnd.oasis.opendocument.text"
                    or "application/vnd.oasis.opendocument.spreadsheet"
                    or "application/vnd.oasis.opendocument.presentation"
                    ? value
                    : null;
            }

            var xml = zip.GetEntry("[Content_Types].xml") is { } types ? ReadText(types, 1024 * 1024) : null;
            if (xml is null)
            {
                return null;
            }

            if (xml.Contains("wordprocessingml", StringComparison.Ordinal))
            {
                return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            }

            if (xml.Contains("spreadsheetml", StringComparison.Ordinal))
            {
                return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
            }

            if (xml.Contains("presentationml", StringComparison.Ordinal))
            {
                return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
            }

            return null;
        }
        catch (InvalidDataException)
        {
            return null;
        }
    }

    private static string? ReadText(ZipArchiveEntry entry, int maxChars)
    {
        using var stream = entry.Open();
        using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
        var buffer = new char[Math.Min(maxChars, 8192)];
        var builder = new StringBuilder();
        while (builder.Length < maxChars)
        {
            var read = reader.Read(buffer, 0, Math.Min(buffer.Length, maxChars - builder.Length));
            if (read == 0)
            {
                return builder.ToString();
            }

            builder.Append(buffer, 0, read);
        }

        return reader.Peek() >= 0 ? null : builder.ToString();
    }

    private static bool StartsWithMarkup(Stream content)
    {
        content.Position = 0;
        var buffer = new byte[512];
        var read = content.Read(buffer, 0, buffer.Length);
        var text = Encoding.UTF8.GetString(buffer, 0, read).TrimStart('\uFEFF').TrimStart();
        return text.StartsWith('<');
    }

    private static bool IsUtf8Text(Stream content)
    {
        content.Position = 0;
        var decoder = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true).GetDecoder();
        var buffer = new byte[81920];
        var chars = new char[81920];
        while (true)
        {
            var read = content.Read(buffer, 0, buffer.Length);
            if (read == 0)
            {
                break;
            }

            if (buffer.AsSpan(0, read).Contains((byte)0))
            {
                return false;
            }

            try
            {
                decoder.GetChars(buffer, 0, read, chars, 0, flush: false);
            }
            catch (DecoderFallbackException)
            {
                return false;
            }
        }

        try
        {
            decoder.GetChars([], 0, 0, chars, 0, flush: true);
            return true;
        }
        catch (DecoderFallbackException)
        {
            return false;
        }
    }
}

public sealed class FileSpool : IAsyncDisposable
{
    private readonly Stream? _content;

    private FileSpool(Stream? content, long size, string sha256)
    {
        _content = content;
        Size = size;
        Sha256 = sha256;
    }

    public bool TooLarge => _content is null;

    public Stream Content => _content ?? throw new InvalidOperationException("The upload is too large.");

    public long Size { get; }

    public string Sha256 { get; }

    public static async Task<FileSpool> ToSeekableAsync(Stream source, long maxBytes, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(source);
        var path = Path.Combine(Path.GetTempPath(), "chain-upload-" + Guid.NewGuid().ToString("N"));
        var file = new FileStream(path, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 81920, FileOptions.Asynchronous | FileOptions.DeleteOnClose);
        try
        {
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            var buffer = new byte[81920];
            long total = 0;
            while (true)
            {
                var read = await source.ReadAsync(buffer, cancellationToken);
                if (read == 0)
                {
                    break;
                }

                total += read;
                if (total > maxBytes)
                {
                    await file.DisposeAsync();
                    return new FileSpool(null, 0, string.Empty);
                }

                hash.AppendData(buffer.AsSpan(0, read));
                await file.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            }

            await file.FlushAsync(cancellationToken);
            file.Position = 0;
            return new FileSpool(file, total, Convert.ToHexStringLower(hash.GetHashAndReset()));
        }
        catch
        {
            await file.DisposeAsync();
            throw;
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_content is not null)
        {
            await _content.DisposeAsync();
        }
    }
}
