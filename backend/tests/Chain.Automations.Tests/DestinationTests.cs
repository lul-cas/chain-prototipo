namespace Chain.Automations.Tests;

/// <summary>Destination rules of automation.md §3.1 (ADR-0012 Part 2).</summary>
public sealed class DestinationTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 16, 12, 0, 0, TimeSpan.Zero);

    private static DestinationSettings Settings(
        string host = "api.example.com", string? scheme = null, int? port = null, string? pathPrefix = null, bool @internal = false,
        bool secretsOverHttp = false, long? maxRequest = null, long? maxResponse = null, string? description = null) =>
        new(description, scheme, host, port, pathPrefix, @internal, secretsOverHttp, maxRequest, maxResponse);

    private static IReadOnlyList<string> Errors(DestinationSettings settings, string name = "erp") =>
        Destination.Create(name, settings, Guid.CreateVersion7(Now), Now).Errors;

    [Fact]
    public void A_valid_destination_takes_its_defaults()
    {
        var created = Destination.Create("erp", Settings(), Guid.CreateVersion7(Now), Now);

        Assert.Empty(created.Errors);
        var destination = created.Value!;
        Assert.Equal(("https", 1_048_576L, 1_048_576L), (destination.Scheme, destination.MaxRequestBytes, destination.MaxResponseBytes));
        Assert.False(destination.Internal);
    }

    [Theory]
    [InlineData("erp")]
    [InlineData("erp_api.v2-x")]
    [InlineData("0erp")]
    public void Accepts_names(string name) => Assert.Empty(Errors(Settings(), name));

    [Theory]
    [InlineData("")]
    [InlineData("Erp")]
    [InlineData("-erp")]
    [InlineData("_erp")]
    [InlineData("erp api")]
    [InlineData("erpé")]
    [InlineData("erp\n")] // .NET's $ matches before a final newline; names are anchored with \z
    public void Rejects_names(string name) => Assert.Contains("invalid_name", Errors(Settings(), name));

    [Fact]
    public void Rejects_names_longer_than_64_characters() => Assert.Contains("invalid_name", Errors(Settings(), new string('a', 65)));

    [Theory]
    [InlineData("api.example.com")]
    [InlineData("erp")]
    [InlineData("mock-erp")]
    [InlineData("*.example.com")]
    [InlineData("*.svc.cluster.local")]
    [InlineData("xn--bcher-kva.example")]
    public void Accepts_hosts(string host) => Assert.Empty(Errors(Settings(host)));

    [Theory]
    [InlineData("API.example.com")] // lowercase only
    [InlineData("10.0.0.1")] // IP literals
    [InlineData("1.2.3.4")]
    [InlineData("host.123")]
    [InlineData("[::1]")]
    [InlineData("::1")]
    [InlineData("user@example.com")] // user info
    [InlineData("example.com:8080")] // ports belong in `port`
    [InlineData("example.com/path")] // paths belong in `pathPrefix`
    [InlineData("example.com.")]
    [InlineData("-bad.example.com")]
    [InlineData("bad-.example.com")]
    [InlineData("a..b")]
    [InlineData("")]
    [InlineData("exa mple.com")]
    [InlineData("bücher.example")] // an IDN must be in its ASCII form
    [InlineData("*")]
    [InlineData("*.com")] // a wildcard must not cover a whole top-level domain
    [InlineData("*.*.example.com")]
    [InlineData("api.*.example.com")]
    public void Rejects_hosts(string host) => Assert.Contains("invalid_host", Errors(Settings(host)));

    [Fact]
    public void Rejects_labels_and_names_that_are_too_long()
    {
        Assert.Contains("invalid_host", Errors(Settings(new string('a', 64) + ".example.com")));
        Assert.Contains("invalid_host", Errors(Settings(string.Join('.', Enumerable.Repeat(new string('a', 60), 5)))));
    }

    [Fact]
    public void Http_needs_an_internal_destination()
    {
        Assert.Contains("http_requires_internal", Errors(Settings(scheme: "http")));
        Assert.Empty(Errors(Settings(scheme: "http", @internal: true)));
        Assert.Contains("invalid_scheme", Errors(Settings(scheme: "ftp")));
    }

    [Fact]
    public void Secrets_over_http_is_a_confirmation_for_http_only()
    {
        Assert.Contains("secrets_over_http_requires_http", Errors(Settings(secretsOverHttp: true)));
        Assert.Empty(Errors(Settings(scheme: "http", @internal: true, secretsOverHttp: true)));
    }

    [Theory]
    [InlineData(0, false)]
    [InlineData(1, true)]
    [InlineData(443, true)]
    [InlineData(65535, true)]
    [InlineData(65536, false)]
    public void Ports_are_1_to_65535(int port, bool valid) => Assert.Equal(valid, !Errors(Settings(port: port)).Contains("invalid_port"));

    [Theory]
    [InlineData("/api", true)]
    [InlineData("/api/v1/", true)]
    [InlineData("/", true)]
    [InlineData("api", false)]
    [InlineData("/a/../b", false)]
    [InlineData("/a?x=1", false)]
    [InlineData("/a#top", false)]
    [InlineData("/a%2Fb", false)]
    [InlineData("/a%2fb", false)]
    [InlineData("/a b", false)]
    public void Path_prefixes(string prefix, bool valid) => Assert.Equal(valid, !Errors(Settings(pathPrefix: prefix)).Contains("invalid_path_prefix"));

    [Theory]
    [InlineData(1023, false)]
    [InlineData(1024, true)]
    [InlineData(10_485_760, true)]
    [InlineData(10_485_761, false)]
    public void Size_limits_are_1_KiB_to_10_MiB(long bytes, bool valid)
    {
        Assert.Equal(valid, !Errors(Settings(maxRequest: bytes)).Contains("invalid_max_request_bytes"));
        Assert.Equal(valid, !Errors(Settings(maxResponse: bytes)).Contains("invalid_max_response_bytes"));
    }

    [Fact]
    public void Descriptions_are_at_most_500_characters()
    {
        Assert.Empty(Errors(Settings(description: new string('d', 500))));
        Assert.Contains("description_too_long", Errors(Settings(description: new string('d', 501))));
    }

    [Fact]
    public void Updating_keeps_the_name_and_applies_the_same_rules()
    {
        var destination = Destination.Create("erp", Settings(), Guid.CreateVersion7(Now), Now).Value!;

        Assert.Contains("http_requires_internal", destination.Update(Settings(scheme: "http"), Now.AddMinutes(1)));
        Assert.Equal("https", destination.Scheme); // a rejected update changes nothing

        Assert.Empty(destination.Update(Settings("erp.internal", "http", 8080, "/v1", @internal: true), Now.AddMinutes(2)));
        Assert.Equal(("erp", "http", "erp.internal", 8080, "/v1", true), (destination.Name, destination.Scheme, destination.Host, destination.Port, destination.PathPrefix, destination.Internal));
        Assert.Equal(Now.AddMinutes(2), destination.UpdatedAt);
    }
}
