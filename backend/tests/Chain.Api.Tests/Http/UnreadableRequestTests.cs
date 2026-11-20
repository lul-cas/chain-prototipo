using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Chain.Api.Tests.Infrastructure;
using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using Microsoft.Extensions.DependencyInjection;

namespace Chain.Api.Tests.Http;

/// <summary>
/// Requests the API cannot read (identity.md I1, card #180): a body that is not JSON, or not UTF-8, at every endpoint that reads
/// one; a value that cannot be bound; and a path with the NUL character, which the server refuses before routing.
/// </summary>
[Collection(PostgresTestGroup.Name)]
public sealed class UnreadableRequestTests(PostgresFixture postgres) : IAsyncLifetime, IDisposable
{
    private const string NotJson = "The request body is not valid JSON of the expected shape.";
    private const string Unbound = "The request is missing a required value, or has one that cannot be read.";

    private readonly ChainApiFactory _factory = new(postgres.ConnectionString);

    public async Task InitializeAsync() => await _factory.ResetDatabaseAsync();

    public Task DisposeAsync() => Task.CompletedTask;

    public void Dispose() => _factory.Dispose();

    // Regression #180: a body that is not JSON got a bare 400 with an empty body, though every error is a problem with a code
    // (identity.md I1; workflow-engine.md §15.5). A byte that is not UTF-8 in a property the endpoint ignores, or in a property
    // name, was not even refused: the request ran (201 for a new user). Each endpoint that reads a JSON body is found from its
    // metadata, so one added later is covered too.

    [Fact]
    public async Task Every_endpoint_that_reads_json_answers_a_body_that_is_not_json_with_validation_failed()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        var endpoints = JsonEndpoints();
        Assert.True(endpoints.Count >= 25, $"Only {endpoints.Count} endpoints read JSON; the enumeration missed some.");

        var wrong = new List<string>();
        foreach (var (method, path) in endpoints)
        {
            foreach (var (label, body) in new (string, HttpContent)[]
            {
                ("malformed", ApiTestSession.RawJson("{ not json")),
                ("not UTF-8 in an ignored value", ApiTestSession.NotUtf8Json("""{"chain_unknown":"xNOT_UTF8"}""")),
                ("not UTF-8 in a property name", ApiTestSession.NotUtf8Json("""{"chain_unknownNOT_UTF8":1}""")),
            })
            {
                using var request = new HttpRequestMessage(method, path) { Content = body };
                var response = await admin.SendAsync(request);
                if (await DescribeUnlessProblemAsync(response, NotJson) is { } answer)
                {
                    wrong.Add($"{method} {path} ({label}): {answer}");
                }
            }
        }

        Assert.True(wrong.Count == 0, string.Join(Environment.NewLine, wrong));
        Assert.Equal(["0"], await _factory.QueryAsync("SELECT count(*) FROM chain.users WHERE username <> 'admin'"));
    }

    [Fact]
    public async Task A_valid_body_with_a_byte_that_is_not_UTF8_in_a_property_the_endpoint_ignores_changes_nothing()
    {
        using var admin = await _factory.CreateReadyAdminAsync();

        var response = await admin.PostAsync("/api/admin/users", ApiTestSession.NotUtf8Json("""{"username":"ana.souza","displayName":"Ana Souza","isAdmin":false,"note":"xNOT_UTF8"}"""));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode); // it was 201: the user was created
        await response.AssertMalformedJsonAsync(admin, HttpMethod.Post, "/api/admin/users");
        Assert.Equal(["0"], await _factory.QueryAsync("SELECT count(*) FROM chain.users WHERE username = 'ana.souza'"));
    }

    [Fact]
    public async Task A_body_of_the_wrong_shape_a_missing_body_and_an_unreadable_query_value_are_validation_failed()
    {
        using var admin = await _factory.CreateReadyAdminAsync();

        Assert.Null(await DescribeUnlessProblemAsync(await admin.PostAsync("/api/admin/users", ApiTestSession.RawJson("""{"username":5}""")), NotJson));
        Assert.Null(await DescribeUnlessProblemAsync(await admin.PostAsync("/api/admin/users", ApiTestSession.RawJson("[]")), NotJson));
        Assert.Null(await DescribeUnlessProblemAsync(await admin.PostAsync("/api/admin/users", ApiTestSession.RawJson("null")), Unbound));
        Assert.Null(await DescribeUnlessProblemAsync(await admin.PostAsync("/api/admin/users", null), Unbound));
        Assert.Null(await DescribeUnlessProblemAsync(await admin.DeleteAsync("/api/admin/automation/destinations/erp?force=maybe"), Unbound));
        Assert.Null(await DescribeUnlessProblemAsync(await admin.GetAsync("/api/admin/users?limit=many"), Unbound));
    }

    // Regression #207: a body that is not JSON by its content type got a bare 415, though every error is a problem with a code
    // (identity.md I1). Routing refuses text/plain, and binding refuses a body without a content type: both get the problem.

    [Fact]
    public async Task A_body_without_a_json_content_type_gets_415_unsupported_media_type()
    {
        using var admin = await _factory.CreateReadyAdminAsync();

        foreach (var content in new HttpContent[] { new StringContent("{}", System.Text.Encoding.UTF8, "text/plain"), new ByteArrayContent("{}"u8.ToArray()) })
        {
            var response = await admin.PostAsync("/api/admin/users", content);

            Assert.Equal(HttpStatusCode.UnsupportedMediaType, response.StatusCode);
            var problem = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
            Assert.Equal("unsupported_media_type", problem.GetProperty("code").GetString());
            Assert.Equal("Send the body as JSON, with Content-Type: application/json.", problem.GetProperty("detail").GetString());
        }
    }

    // Regression #207: JSON bodies were taken up to the upload limit, about 26 MB, and they are read into memory to check their
    // bytes (card #180). A JSON body is now at most 8 MiB (identity.md I1). Files keep their own limit.

    [Fact]
    public async Task A_json_body_over_8_MiB_gets_413_and_one_of_8_MiB_is_read()
    {
        using var admin = await _factory.CreateReadyAdminAsync();
        const string User = """{"username":"ana.souza","displayName":"Ana Souza","isAdmin":false}""";
        static StringContent Padded(int bytes) => ApiTestSession.RawJson(User + new string(' ', bytes - User.Length)); // spaces after the object

        var over = await admin.PostAsync("/api/admin/users", Padded((8 * 1024 * 1024) + 1));

        await over.AssertProblemAsync(HttpStatusCode.RequestEntityTooLarge, "payload_too_large");
        Assert.Equal(["0"], await _factory.QueryAsync("SELECT count(*) FROM chain.users WHERE username = 'ana.souza'"));
        Assert.Equal(HttpStatusCode.Created, (await admin.PostAsync("/api/admin/users", Padded(8 * 1024 * 1024))).StatusCode);
    }

    // Card #207: a body sent in chunks declares no length, so the server cuts it off at the limit while it is read.

    [Fact]
    public async Task A_chunked_json_body_over_8_MiB_gets_413_from_the_server()
    {
        using var factory = new ChainApiFactory(postgres.ConnectionString);
        factory.UseKestrel(0);
        factory.StartServer();
        using var client = factory.CreateClient(); // with Kestrel, the server's own address
        client.DefaultRequestHeaders.Add("Origin", ChainApiFactory.FrontendOrigin);
        var body = System.Text.Encoding.UTF8.GetBytes("""{"username":"ana","password":""" + "\"" + new string('x', 8 * 1024 * 1024) + "\"}");
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/auth/login") { Content = new StreamContent(new MemoryStream(body)) };
        request.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/json");
        request.Headers.TransferEncodingChunked = true;

        var response = await client.SendAsync(request);

        await response.AssertProblemAsync(HttpStatusCode.RequestEntityTooLarge, "payload_too_large");
    }

    // Card #180: a name in the path goes straight into a query, and PostgreSQL refuses the NUL character there (22021). Such a
    // path never reaches the API. The test host refuses it in the client; Kestrel answers 400 before routing, where the API
    // would answer an anonymous caller 401 (or 403 without an Origin), so no endpoint, and no query, ever sees the name.

    [Fact]
    public async Task A_name_with_the_NUL_character_in_the_path_gets_400_from_the_server()
    {
        using var factory = new ChainApiFactory(postgres.ConnectionString);
        factory.UseKestrel(0);
        factory.StartServer();
        using var client = factory.CreateClient(); // with Kestrel, the server's own address

        foreach (var path in new[] { "/api/admin/automation/destinations/erp", "/api/admin/automation/secrets/erp_key" })
        {
            await (await client.GetAsync(path)).AssertProblemAsync(HttpStatusCode.Unauthorized, "unauthenticated"); // the API answers

            foreach (var method in new[] { HttpMethod.Get, HttpMethod.Put, HttpMethod.Patch, HttpMethod.Delete })
            {
                using var request = new HttpRequestMessage(method, path + "%00") { Content = method == HttpMethod.Get ? null : JsonContent.Create(new { }) };
                var response = await client.SendAsync(request);
                Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
                Assert.Empty(await response.Content.ReadAsByteArrayAsync()); // the server's answer: the API wrote nothing
            }
        }
    }

    // Helpers

    /// <summary>The method and a matching path of every endpoint under <c>/api</c> that reads a JSON body.</summary>
    private List<(HttpMethod Method, string Path)> JsonEndpoints() =>
        [.. _factory.Services.GetServices<EndpointDataSource>()
            .SelectMany(source => source.Endpoints)
            .OfType<RouteEndpoint>()
            .Where(endpoint => endpoint.RoutePattern.RawText?.StartsWith("/api/", StringComparison.Ordinal) == true
                && endpoint.Metadata.GetMetadata<IAcceptsMetadata>()?.ContentTypes.Contains("application/json") == true)
            .SelectMany(endpoint => endpoint.Metadata.GetMetadata<HttpMethodMetadata>()!.HttpMethods
                .Select(method => (new HttpMethod(method), PathOf(endpoint.RoutePattern))))];

    /// <summary>A path the pattern matches: a new id for a <c>guid</c>, 1 for an <c>int</c>, <c>x</c> for any other value.</summary>
    private static string PathOf(RoutePattern pattern) =>
        "/" + string.Join('/', pattern.PathSegments.Select(segment => string.Concat(segment.Parts.Select(part => part switch
        {
            RoutePatternLiteralPart literal => literal.Content,
            RoutePatternParameterPart parameter when parameter.ParameterPolicies.Any(p => p.Content == "guid") => Guid.NewGuid().ToString(),
            RoutePatternParameterPart parameter when parameter.ParameterPolicies.Any(p => p.Content == "int") => "1",
            RoutePatternParameterPart => "x",
            _ => throw new InvalidOperationException($"Unexpected route part in {pattern.RawText}."),
        }))));

    /// <summary>
    /// Null when <paramref name="response"/> is 400 <c>validation_failed</c> with <paramref name="detail"/>; otherwise what it was.
    /// </summary>
    private static async Task<string?> DescribeUnlessProblemAsync(HttpResponseMessage response, string detail)
    {
        var text = await response.Content.ReadAsStringAsync();
        var answer = $"{(int)response.StatusCode} {response.Content.Headers.ContentType} [{text}]";
        if (response.StatusCode != HttpStatusCode.BadRequest || response.Content.Headers.ContentType?.MediaType != "application/problem+json")
        {
            return answer;
        }

        var problem = JsonDocument.Parse(text).RootElement;
        return problem.TryGetProperty("code", out var code) && code.GetString() == "validation_failed"
            && problem.TryGetProperty("detail", out var actual) && actual.GetString() == detail
            ? null
            : answer;
    }
}
