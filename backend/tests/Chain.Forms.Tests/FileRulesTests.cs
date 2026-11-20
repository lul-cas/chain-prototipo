using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;

namespace Chain.Forms.Tests;

public sealed class FileRulesTests
{
    [Fact]
    public void Sanitize_strips_controls_and_separators_and_normalizes_to_nfc()
    {
        Assert.Equal("abc.pdf", FileRules.SanitizeName("a/b\\c.pdf"));
        Assert.Equal("ab.pdf", FileRules.SanitizeName("a\u0000b.pdf"));
        Assert.Equal("é.pdf", FileRules.SanitizeName("e\u0301.pdf"));
        Assert.Null(FileRules.SanitizeName(""));
        Assert.Null(FileRules.SanitizeName(new string('a', 256) + ".pdf"));
    }

    [Theory]
    [MemberData(nameof(AllowedSamples))]
    public void Allowed_types_match_their_extension(string name, byte[] bytes, string contentType)
    {
        using var stream = new MemoryStream(bytes);

        var detected = FileRules.Detect(stream, name);

        Assert.True(detected.IsAllowed);
        Assert.Equal(contentType, detected.ContentType);
        Assert.Equal(0, stream.Position);
    }

    [Theory]
    [InlineData("page.html", "<html><script>bad</script></html>")]
    [InlineData("note.txt", "<svg onload='x'></svg>")]
    [InlineData("data.txt", "<?xml version=\"1.0\"?><a/>")]
    [InlineData("run.exe", "MZ")]
    [InlineData("photo.png", "%PDF-1.7")]
    public void Rejected_content_or_a_disagreeing_extension_is_not_allowed(string name, string text)
    {
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes(text));

        Assert.False(FileRules.Detect(stream, name).IsAllowed);
    }

    [Fact]
    public void A_plain_zip_is_rejected_and_office_packages_are_allowed()
    {
        using var zip = new MemoryStream(Package(archive =>
        {
            using var writer = new StreamWriter(archive.CreateEntry("readme.txt").Open());
            writer.Write("hello");
        }));
        using var docx = new MemoryStream(Package(archive =>
        {
            using var writer = new StreamWriter(archive.CreateEntry("[Content_Types].xml").Open());
            writer.Write("<Types><Override ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>");
        }));
        using var odt = new MemoryStream(Package(archive =>
        {
            using var writer = new StreamWriter(archive.CreateEntry("mimetype").Open());
            writer.Write("application/vnd.oasis.opendocument.text");
        }));

        Assert.False(FileRules.Detect(zip, "bundle.zip").IsAllowed);
        Assert.Equal("application/vnd.openxmlformats-officedocument.wordprocessingml.document", FileRules.Detect(docx, "note.docx").ContentType);
        Assert.Equal("application/vnd.oasis.opendocument.text", FileRules.Detect(odt, "note.odt").ContentType);
        Assert.False(FileRules.Detect(docx, "note.zip").IsAllowed);
    }

    [Fact]
    public async Task Spool_makes_a_non_seekable_stream_seekable_and_stops_past_the_limit()
    {
        var payload = RandomBytes(64 * 1024);
        await using var spooled = await FileSpool.ToSeekableAsync(new OneShotStream(payload), FileRules.MaxBytes, CancellationToken.None);

        Assert.False(spooled.TooLarge);
        Assert.True(spooled.Content.CanSeek);
        Assert.Equal(payload.Length, spooled.Size);
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(payload)), spooled.Sha256);
        Assert.Equal(0, spooled.Content.Position);

        await using var tooBig = await FileSpool.ToSeekableAsync(new OneShotStream(new byte[32]), 16, CancellationToken.None);
        Assert.True(tooBig.TooLarge);
    }

    public static IEnumerable<object[]> AllowedSamples()
    {
        yield return ["a.pdf", "%PDF-1.7\n"u8.ToArray(), "application/pdf"];
        yield return ["a.png", new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00 }, "image/png"];
        yield return ["a.jpg", new byte[] { 0xFF, 0xD8, 0xFF, 0xD9 }, "image/jpeg"];
        yield return ["a.jpeg", new byte[] { 0xFF, 0xD8, 0xFF, 0xD9 }, "image/jpeg"];
        yield return ["a.gif", "GIF89a"u8.ToArray(), "image/gif"];
        yield return ["a.webp", "RIFF\0\0\0\0WEBP"u8.ToArray(), "image/webp"];
        yield return ["a.txt", "olá\n"u8.ToArray(), "text/plain"];
        yield return ["a.csv", "a,b\n1,2\n"u8.ToArray(), "text/csv"];
    }

    private static byte[] Package(Action<ZipArchive> fill)
    {
        using var memory = new MemoryStream();
        using (var archive = new ZipArchive(memory, ZipArchiveMode.Create, leaveOpen: true))
        {
            fill(archive);
        }

        return memory.ToArray();
    }

    private static byte[] RandomBytes(int count)
    {
        var bytes = new byte[count];
        RandomNumberGenerator.Fill(bytes);
        return bytes;
    }

    private sealed class OneShotStream(byte[] data) : Stream
    {
        private int _offset;

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush()
        {
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            var n = Math.Min(count, data.Length - _offset);
            Buffer.BlockCopy(data, _offset, buffer, offset, n);
            _offset += n;
            return n;
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
