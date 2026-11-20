using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Chain.Api.Cli;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Chain.Infrastructure;

namespace Chain.Api.Tests.Infrastructure;

/// <summary>Shared helpers for API tests: bootstrap, sign-in, problem assertions and raw SQL checks.</summary>
internal static class ApiTestSession
{
    public const string AdminUsername = "admin";
    public const string BootstrapPassword = "initial-password-123";
    public const string AdminPassword = "admin-own-passphrase";

    /// <summary>Bootstraps the first admin, signs in and changes the password, returning a ready admin browser.</summary>
    public static async Task<HttpClient> CreateReadyAdminAsync(this ChainApiFactory factory)
    {
        _ = factory.Server;
        var exitCode = await BootstrapAdminCommand.RunAsync(
            ["bootstrap-admin", "--username", AdminUsername],
            factory.Services,
            new StringReader(BootstrapPassword),
            TextWriter.Null,
            _ => null);
        Assert.Equal(0, exitCode);

        var browser = factory.CreateBrowser();
        Assert.Equal(HttpStatusCode.NoContent, (await browser.LoginAsync(AdminUsername, BootstrapPassword)).StatusCode);
        var change = await browser.PostAsJsonAsync("/api/auth/change-password", new { currentPassword = BootstrapPassword, newPassword = AdminPassword });
        Assert.Equal(HttpStatusCode.NoContent, change.StatusCode);
        return browser;
    }

    /// <summary>Signs in a user created by an admin and replaces the temporary password, returning a ready browser.</summary>
    public static async Task<HttpClient> CreateReadyUserAsync(this ChainApiFactory factory, string username, string temporaryPassword, string newPassword)
    {
        var browser = factory.CreateBrowser();
        Assert.Equal(HttpStatusCode.NoContent, (await browser.LoginAsync(username, temporaryPassword)).StatusCode);
        var change = await browser.PostAsJsonAsync("/api/auth/change-password", new { currentPassword = temporaryPassword, newPassword });
        Assert.Equal(HttpStatusCode.NoContent, change.StatusCode);
        return browser;
    }

    public static Task<HttpResponseMessage> LoginAsync(this HttpClient client, string username, string password) =>
        client.PostAsJsonAsync("/api/auth/login", new { username, password });

    public static async Task AssertProblemAsync(this HttpResponseMessage response, HttpStatusCode status, string code)
    {
        Assert.Equal(status, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(code, problem.GetProperty("code").GetString());
    }

    /// <summary>Asserts a 400 <c>validation_failed</c> whose only error is <paramref name="error"/>.</summary>
    public static async Task AssertValidationFailedAsync(this HttpResponseMessage response, string error)
    {
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("validation_failed", problem.GetProperty("code").GetString());
        Assert.Equal(error, Assert.Single(problem.GetProperty("errors").EnumerateArray()).GetString());
    }

    /// <summary>
    /// A JSON body sent exactly as written. A serializer writes an unpaired surrogate as U+FFFD, so a test that needs the escape
    /// <c>\ud800</c> on the wire writes the JSON text itself (card #129).
    /// </summary>
    public static StringContent RawJson(string json) => new(json, System.Text.Encoding.UTF8, "application/json");

    /// <summary>
    /// A JSON body whose bytes are not UTF-8: each <c>NOT_UTF8</c> in <paramref name="json"/> becomes the byte 0xFF, which UTF-8
    /// never uses (card #153). Such a body is not JSON (RFC 8259 §8.1).
    /// </summary>
    public static ByteArrayContent NotUtf8Json(string json)
    {
        var bytes = json.Split("NOT_UTF8").Select(System.Text.Encoding.UTF8.GetBytes).Aggregate((before, after) => [.. before, 0xFF, .. after]);
        var content = new ByteArrayContent(bytes);
        content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/json");
        return content;
    }

    /// <summary>
    /// Asserts that <paramref name="response"/> is the answer to a body that is not JSON: 400 <c>validation_failed</c>, with the body
    /// the same endpoint gives for <c>{ not json</c> (cards #153 and #180).
    /// </summary>
    public static async Task AssertMalformedJsonAsync(this HttpResponseMessage response, HttpClient client, HttpMethod method, string path)
    {
        using var notJson = new HttpRequestMessage(method, path) { Content = RawJson("{ not json") };
        var malformed = await client.SendAsync(notJson);
        await malformed.AssertProblemAsync(HttpStatusCode.BadRequest, "validation_failed");
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(await malformed.Content.ReadAsStringAsync(), await response.Content.ReadAsStringAsync());
    }

    public static async Task<List<string>> QueryAsync(this ChainApiFactory factory, string sql)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ChainDbContext>();
        await using var connection = db.Database.GetDbConnection();
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        var values = new List<string>();
        await using var reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            values.Add(Convert.ToString(reader.GetValue(0), CultureInfo.InvariantCulture)!);
        }

        return values;
    }

    public static async Task<long> CountAsync(this ChainApiFactory factory, string sql) =>
        long.Parse((await factory.QueryAsync(sql)).Single(), CultureInfo.InvariantCulture);
}
