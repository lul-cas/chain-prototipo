using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Chain.Api.Tests.Infrastructure;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;

namespace Chain.Api.Tests.Mcp;

/// <summary>A bot that may use MCP, with one API token.</summary>
internal sealed record McpBot(Guid Id, string Token);

/// <summary>Helpers for MCP tests: bots with tokens, and the SDK client connected to the in-process server.</summary>
internal static class McpTestClient
{
    public const string Endpoint = "https://localhost/mcp";

    /// <summary>Creates a bot with a token, adds it to <paramref name="groups"/> and, unless told otherwise, enables MCP for it.</summary>
    public static async Task<McpBot> CreateBotAsync(HttpClient admin, string name, bool enableMcp = true, params Guid[] groups)
    {
        var created = await admin.PostAsJsonAsync("/api/admin/bots", new { name, displayName = name });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        foreach (var group in groups)
        {
            Assert.Equal(HttpStatusCode.NoContent, (await admin.PutAsync($"/api/admin/groups/{group}/members/{id}", null)).StatusCode);
        }

        if (enableMcp)
        {
            Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsync($"/api/admin/bots/{id}/mcp/enable", null)).StatusCode);
        }

        var token = await admin.PostAsJsonAsync($"/api/admin/bots/{id}/tokens", new { label = "mcp" });
        Assert.Equal(HttpStatusCode.Created, token.StatusCode);
        return new McpBot(id, (await token.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("value").GetString()!);
    }

    /// <summary>An HTTP client for raw requests to <c>/mcp</c>, with the bearer token when one is given.</summary>
    public static HttpClient Http(this ChainApiFactory factory, string? token = null)
    {
        var client = factory.CreateClient(new() { BaseAddress = new Uri("https://localhost") });
        if (token is not null)
        {
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        }

        return client;
    }

    /// <summary>The official SDK client (ModelContextProtocol 2.2.0) over Streamable HTTP to the in-process server.</summary>
    public static async Task<McpClient> ConnectAsync(this ChainApiFactory factory, string token, string? origin = null)
    {
        var http = factory.Http(token);
        if (origin is not null)
        {
            http.DefaultRequestHeaders.Add("Origin", origin);
        }

        var transport = new HttpClientTransport(
            new HttpClientTransportOptions { Endpoint = new Uri(Endpoint), TransportMode = HttpTransportMode.StreamableHttp },
            http,
            ownsHttpClient: true);
        return await McpClient.CreateAsync(transport);
    }

    public static Task<CallToolResult> CallAsync(this McpClient client, string tool, object? arguments = null) =>
        client.CallToolAsync(tool, arguments is null ? null : JsonSerializer.SerializeToElement(arguments).Deserialize<Dictionary<string, object?>>()).AsTask();

    /// <summary>The structured result of a successful call.</summary>
    public static JsonElement Ok(this CallToolResult result)
    {
        Assert.True(result.IsError is null or false, result.StructuredContent?.GetRawText() ?? "no structured content");
        return result.StructuredContent!.Value;
    }

    /// <summary>The structured error of a failed call, after checking its <c>code</c>.</summary>
    public static JsonElement Error(this CallToolResult result, string code)
    {
        Assert.True(result.IsError, result.StructuredContent?.GetRawText() ?? "no structured content");
        var error = result.StructuredContent!.Value;
        Assert.Equal(code, error.GetProperty("code").GetString());
        return error;
    }

    /// <summary>
    /// A raw <c>tools/call</c> as the SDK client sends it, with its headers and <c>_meta</c>. Each <c>NOT_UTF8</c> in the tool name or
    /// <paramref name="arguments"/> becomes the byte 0xFF (<see cref="ApiTestSession.NotUtf8Json"/>); the <c>Mcp-Name</c> header
    /// names the tool without it.
    /// </summary>
    public static HttpRequestMessage ToolCall(string tool, string arguments)
    {
        const string Meta = """{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"test","version":"1"},"io.modelcontextprotocol/clientCapabilities":{}}""";
        var body = $$$"""{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"{{{tool}}}","arguments":{{{arguments}}},"_meta":{{{Meta}}}}}""";
        var request = new HttpRequestMessage(HttpMethod.Post, "/mcp") { Content = ApiTestSession.NotUtf8Json(body) };
        request.Headers.Accept.ParseAdd("application/json, text/event-stream");
        request.Headers.Add("MCP-Protocol-Version", "2026-07-28");
        request.Headers.Add("Mcp-Method", "tools/call");
        request.Headers.Add("Mcp-Name", tool.Replace("NOT_UTF8", string.Empty, StringComparison.Ordinal));
        return request;
    }

    /// <summary>
    /// Sends a raw <see cref="ToolCall"/> and returns its tool result, after checking that the answer is not a JSON-RPC error. The SDK
    /// client writes an unpaired surrogate as U+FFFD, so a test that needs <c>\ud800</c> on the wire writes the JSON text itself.
    /// </summary>
    public static async Task<JsonElement> RawCallAsync(this HttpClient http, string tool, string arguments)
    {
        var response = await http.SendAsync(ToolCall(tool, arguments));
        var text = await response.Content.ReadAsStringAsync();
        var data = text.Split('\n').Select(line => line.Trim()).FirstOrDefault(line => line.StartsWith("data:", StringComparison.Ordinal));
        var message = JsonDocument.Parse(data is null ? text : data["data:".Length..]).RootElement;
        Assert.False(message.TryGetProperty("error", out var error), $"JSON-RPC error {error}");
        return message.GetProperty("result").Clone();
    }

    /// <summary>The structured error of a tool result from <see cref="RawCallAsync"/>, after checking its <c>code</c>.</summary>
    public static JsonElement RawError(this JsonElement result, string code)
    {
        Assert.True(result.TryGetProperty("isError", out var isError) && isError.GetBoolean(), result.GetRawText());
        var error = result.GetProperty("structuredContent");
        Assert.Equal(code, error.GetProperty("code").GetString());
        return error;
    }

    /// <summary>A raw JSON-RPC POST, for the checks that happen before the MCP server sees the request.</summary>
    public static Task<HttpResponseMessage> PostRawAsync(this HttpClient client, string body = """{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{}}""")
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "/mcp") { Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json") };
        request.Headers.Accept.ParseAdd("application/json, text/event-stream");
        return client.SendAsync(request);
    }
}
