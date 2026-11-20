using System.Text.Json;
using System.Text.Json.Nodes;
using Chain.SharedKernel;

namespace Chain.Automations.Tests;

/// <summary>
/// Automation documents (automation.md §5.2–§5.4): parsing (AU000), the structural rules AU001–AU012, the reference rules
/// AU101–AU106 and the published form. Every rule has a failing case and a near miss that passes.
/// </summary>
public sealed class AutomationDocumentTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 16, 12, 0, 0, TimeSpan.Zero);

    private static readonly IReadOnlyDictionary<string, IReadOnlyList<string>> ErpKey =
        new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal) { ["erp_api_key"] = ["erp"] };

    private static JsonObject Valid() => JsonNode.Parse("""
        {
          "schemaVersion": 1,
          "kind": "http",
          "inputs": [
            { "key": "cpf", "type": "text", "required": true },
            { "key": "valor", "type": "number" },
            { "key": "itens", "type": "list<object>" }
          ],
          "request": {
            "method": "POST",
            "destination": "erp",
            "path": "/v1/clientes/{cpf}/consultas",
            "query": { "origem": "chain", "valor": "{valor}" },
            "headers": { "X-Api-Key": "{{secret:erp_api_key}}", "Accept": "application/json" },
            "body": { "type": "json", "keys": ["cpf", "valor", "itens"] }
          },
          "response": { "type": "json" },
          "outputs": [
            { "key": "situacao", "type": "text", "required": true, "source": "body", "path": ["resultado", "situacao"] },
            { "key": "primeiro", "type": "unknown", "source": "body", "path": ["itens", 0] },
            { "key": "httpStatus", "type": "number", "required": true, "source": "status" }
          ]
        }
        """)!.AsObject();

    private static JsonObject With(Action<JsonObject> change)
    {
        var document = Valid();
        change(document);
        return document;
    }

    private static JsonObject Request(JsonObject document) => document["request"]!.AsObject();

    private static AutomationDocument Parse(JsonNode node)
    {
        var parsed = AutomationDocumentParser.Parse(node.ToJsonString());
        Assert.True(parsed.IsSuccess, parsed.Error?.Message);
        return parsed.Document!;
    }

    private static List<string> Codes(JsonNode node) => [.. AutomationRules.Validate(Parse(node)).Select(issue => issue.Code)];

    private static Destination Erp(string host = "api.erp.example", string? pathPrefix = "/v1", string scheme = "https", bool secretsOverHttp = false) =>
        Destination.Create("erp", new DestinationSettings(null, scheme, host, null, pathPrefix, scheme == "http", secretsOverHttp, null, null), Guid.CreateVersion7(Now), Now).Value!;

    private static List<string> ReferenceCodes(JsonNode node, Destination? destination, IReadOnlyDictionary<string, IReadOnlyList<string>>? secrets = null) =>
        [.. AutomationRules.CheckReferences(Parse(node), destination, secrets ?? ErpKey).Select(issue => issue.Code)];

    // The valid documents

    [Fact]
    public void A_valid_document_passes_every_rule()
    {
        Assert.Empty(Codes(Valid()));
        Assert.Empty(ReferenceCodes(Valid(), Erp()));
    }

    [Fact]
    public void The_contract_fixture_document_passes_every_rule()
    {
        using var fixture = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "contract", "work-request.json")));
        var document = JsonNode.Parse(fixture.RootElement.GetProperty("scenario").GetProperty("automation").GetProperty("document").GetRawText())!;

        Assert.Empty(Codes(document));
        Assert.Empty(ReferenceCodes(document, Erp()));
    }

    // AU000: parsing

    [Theory]
    [InlineData("""{"schemaVersion":1,"kind":"http","request":{"method":"GET","destination":"erp","path":"/"},"response":{"type":"none"},"extra":1}""")]
    [InlineData("""{"schemaVersion":2,"kind":"http","request":{"method":"GET","destination":"erp","path":"/"},"response":{"type":"none"}}""")]
    [InlineData("""{"schemaVersion":1,"kind":"rpa","request":{"method":"GET","destination":"erp","path":"/"},"response":{"type":"none"}}""")]
    [InlineData("""{"schemaVersion":1,"request":{"method":"GET","destination":"erp","path":"/"},"response":{"type":"none"}}""")]
    [InlineData("""{"schemaVersion":1,"kind":"http","response":{"type":"none"}}""")]
    [InlineData("""{"schemaVersion":1,"kind":"http","request":{"method":"GET","destination":"erp","path":"/"}}""")]
    [InlineData("""{"schemaVersion":1,"kind":"http","request":{"method":"GET","destination":"erp","path":"/","verb":"x"},"response":{"type":"none"}}""")]
    [InlineData("""{"schemaVersion":1,"kind":"http","request":{"method":1,"destination":"erp","path":"/"},"response":{"type":"none"}}""")]
    [InlineData("""{"schemaVersion":1,"kind":"http","request":{"method":"GET","destination":null,"path":"/"},"response":{"type":"none"}}""")]
    [InlineData("""{"schemaVersion":1,"kind":"http","inputs":[null],"request":{"method":"GET","destination":"erp","path":"/"},"response":{"type":"none"}}""")]
    [InlineData("""{"schemaVersion":1,"kind":"http","inputs":[{"key":"a","type":"text","required":"yes"}],"request":{"method":"GET","destination":"erp","path":"/"},"response":{"type":"none"}}""")]
    [InlineData("""{"schemaVersion":1,"kind":"http","request":{"method":"GET","destination":"erp","path":"/","headers":{"Accept":null}},"response":{"type":"none"}}""")]
    [InlineData("""{"schemaVersion":1,"kind":"http","request":{"method":"GET","destination":"erp","path":"/","headers":{"Accept":"a","Accept":"b"}},"response":{"type":"none"}}""")]
    [InlineData("""{"schemaVersion":1,"kind":"http","request":{"method":"GET","destination":"erp","path":"/","query":{"a":1}},"response":{"type":"none"}}""")]
    [InlineData("""{"schemaVersion":1,"kind":"http","request":{"method":"POST","destination":"erp","path":"/","body":{"type":"json","keys":[null]}},"response":{"type":"none"}}""")]
    [InlineData("""{"schemaVersion":1,"kind":"http","request":{"method":"GET","destination":"erp","path":"/"},"response":{"type":"none"},"execution":{"timeoutSeconds":30.5}}""")]
    [InlineData("""{"schemaVersion":1,"kind":"http","request":{"method":"GET","destination":"erp","path":"/"},"response":{"type":"none"},"outputs":[{"key":"a","type":"text","source":"body","path":"a"}]}""")]
    [InlineData("""{"schemaVersion":1,"kind":"http","request":{"method":"GET","destination":"erp","path":"/","headers":{"X":"a\u0000b"}},"response":{"type":"none"}}""")]
    [InlineData("""{"schemaVersion":1,"kind":"http","request":{"method":"GET","destination":"erp","path":"/","headers":{"X":"\\\u0000"}},"response":{"type":"none"}}""")]
    [InlineData("""{"schemaVersion":1,"kind":"http","request":{"method":"GET","destination":"erp","path":"/"},"response":{"type":"json"},"outputs":[{"key":"a","type":"text","source":"body","path":["\ud800"]}]}""")] // an unpaired surrogate in free-form JSON (#129)
    [InlineData("""{"schemaVersion":1,"kind":"http","request":{"method":"GET","destination":"erp","path":"/","headers":{"X":"\udc00"}},"response":{"type":"none"}}""")]
    [InlineData("""[]""")]
    [InlineData("""null""")]
    [InlineData("""{"schemaVersion":1,""")]
    public void Malformed_documents_are_AU000(string json)
    {
        var parsed = AutomationDocumentParser.Parse(json);

        Assert.False(parsed.IsSuccess);
        Assert.Equal("AU000", parsed.Error!.Code);
    }

    [Fact]
    public void An_escaped_backslash_before_u0000_is_text_not_NUL()
    {
        var parsed = AutomationDocumentParser.Parse("""{"schemaVersion":1,"kind":"http","request":{"method":"GET","destination":"erp","path":"/","headers":{"X":"\\u0000"}},"response":{"type":"none"}}""");

        Assert.True(parsed.IsSuccess, parsed.Error?.Message);
        Assert.Equal("\\u0000", parsed.Document!.Request.Headers["X"]);
    }

    [Fact]
    public void An_escaped_surrogate_pair_is_text()
    {
        var parsed = AutomationDocumentParser.Parse("""{"schemaVersion":1,"kind":"http","request":{"method":"GET","destination":"erp","path":"/"},"response":{"type":"json"},"outputs":[{"key":"a","type":"text","source":"body","path":["😀"]}]}""");

        Assert.True(parsed.IsSuccess, parsed.Error?.Message);
        Assert.Equal("😀", parsed.Document!.Outputs[0].Path![0].GetString());
    }

    [Fact]
    public void A_minimal_document_parses()
    {
        var parsed = AutomationDocumentParser.Parse("""{"schemaVersion":1,"kind":"http","request":{"method":"GET","destination":"erp","path":"/"},"response":{"type":"none"}}""");

        Assert.True(parsed.IsSuccess, parsed.Error?.Message);
        Assert.Empty(AutomationRules.Validate(parsed.Document!));
    }

    [Fact]
    public void A_new_automation_starts_with_a_draft_that_parses()
    {
        var parsed = AutomationDocumentParser.Parse(AutomationDefinition.EmptyDraft);

        Assert.True(parsed.IsSuccess, parsed.Error?.Message);
        Assert.Equal(["AU101"], AutomationRules.CheckReferences(parsed.Document!, null, ErpKey).Select(issue => issue.Code));
    }

    // AU001: keys

    [Theory]
    [InlineData("1cpf")]
    [InlineData("cpf-x")]
    [InlineData("")]
    [InlineData("cpf\n")]
    [InlineData("ação")]
    public void Input_and_output_keys_have_the_key_format(string key)
    {
        Assert.Contains("AU001", Codes(With(d => d["inputs"]![0]!["key"] = key)));
        Assert.Contains("AU001", Codes(With(d => d["outputs"]![2]!["key"] = key)));
    }

    [Fact]
    public void Keys_are_unique_within_their_list_and_at_most_50()
    {
        Assert.Contains("AU001", Codes(With(d => d["inputs"]![1]!["key"] = "cpf")));
        Assert.Contains("AU001", Codes(With(d => d["outputs"]![1]!["key"] = "situacao")));
        Assert.Contains("AU001", Codes(With(d => d["inputs"] = new JsonArray([.. Enumerable.Range(0, 51).Select(i => (JsonNode)new JsonObject { ["key"] = $"k{i}", ["type"] = "text" })]))));
    }

    [Fact]
    public void Near_misses_for_keys_pass()
    {
        Assert.Empty(Codes(With(d => d["outputs"]![0]!["key"] = "cpf"))); // the lists are separate
        Assert.Empty(Codes(With(d => d["outputs"]![1]!["key"] = "a" + new string('b', 63))));
        Assert.DoesNotContain("AU001", Codes(With(d =>
        {
            d["inputs"] = new JsonArray([.. Enumerable.Range(0, 50).Select(i => (JsonNode)new JsonObject { ["key"] = $"k{i}", ["type"] = "text" })]);
            Request(d).Remove("body");
        })));
    }

    // AU002: types

    [Theory]
    [InlineData("string")]
    [InlineData("file")]
    [InlineData("Text")]
    [InlineData("list<>")]
    [InlineData("list<text")]
    [InlineData("list< text >")]
    [InlineData("list<file>")]
    [InlineData("")]
    public void Types_are_type_names(string type)
    {
        Assert.Contains("AU002", Codes(With(d => d["inputs"]![2]!["type"] = type)));
        Assert.Contains("AU002", Codes(With(d => d["outputs"]![1]!["type"] = type)));
    }

    [Theory]
    [InlineData("text")]
    [InlineData("number")]
    [InlineData("boolean")]
    [InlineData("date")]
    [InlineData("datetime")]
    [InlineData("time")]
    [InlineData("object")]
    [InlineData("unknown")]
    [InlineData("list<list<number>>")]
    public void Near_misses_for_types_pass(string type) => Assert.Empty(Codes(With(d => d["inputs"]![2]!["type"] = type)));

    // AU003: method

    [Theory]
    [InlineData("get")]
    [InlineData("HEAD")]
    [InlineData("OPTIONS")]
    public void The_method_is_one_of_five(string method) => Assert.Contains("AU003", Codes(With(d => Request(d)["method"] = method)));

    [Theory]
    [InlineData("GET")]
    [InlineData("DELETE")]
    public void Get_and_delete_have_no_body(string method)
    {
        Assert.Contains("AU003", Codes(With(d => Request(d)["method"] = method)));
        Assert.Empty(Codes(With(d =>
        {
            Request(d)["method"] = method;
            Request(d).Remove("body");
        })));
    }

    [Theory]
    [InlineData("PUT")]
    [InlineData("PATCH")]
    public void Near_misses_for_the_method_pass(string method) => Assert.Empty(Codes(With(d => Request(d)["method"] = method)));

    // AU004: path

    [Theory]
    [InlineData("v1/clientes")] // no leading slash
    [InlineData("/v1/../admin")]
    [InlineData("/v1/..")]
    [InlineData("/v1?x=1")]
    [InlineData("/v1#parte")]
    [InlineData("/v1/\u0001")]
    [InlineData("/v1/{{secret:erp_api_key}}")]
    [InlineData("/v1/{nope}")] // not an input
    [InlineData("/v1/{itens}")] // not a scalar input
    [InlineData("/v1/{cpf")]
    [InlineData("/v1/{}")]
    [InlineData("/v1/a b")]
    [InlineData("/v1/relatórios")]
    [InlineData("/v1/%2e%2e/admin")] // encoded dots and slashes could climb past the prefix on the server
    [InlineData("/v1/a%2Fb")]
    [InlineData("/v1/a%5cb")]
    [InlineData("/v1/a\\b")]
    [InlineData("/v1/%zz")]
    public void The_path_is_a_url_path_with_scalar_input_templates(string path) => Assert.Contains("AU004", Codes(With(d => Request(d)["path"] = path)));

    // The message quotes the whole character, never half of a surrogate pair, which JSON would show as U+FFFD (#127).
    [Theory]
    [InlineData("/v1/\U0001F600", "\U0001F600")] // 😀, a surrogate pair
    [InlineData("/v1/\U0001F1E7\U0001F1F7", "\U0001F1E7\U0001F1F7")] // 🇧🇷, two code points that read as one flag
    [InlineData("/v1/café", "é")] // é written as e and a combining accent
    [InlineData("/v1/relatórios", "ó")] // ó, one UTF-16 unit
    public void The_path_message_quotes_the_whole_character(string path, string quoted) =>
        Assert.Equal(
            $"'{quoted}' cannot appear in a path; percent-encode it (RFC 3986).",
            AutomationRules.Validate(Parse(With(d => Request(d)["path"] = path))).Single(issue => issue.Code == "AU004").Message);

    [Fact]
    public void The_path_is_at_most_2000_characters()
    {
        Assert.Contains("AU004", Codes(With(d => Request(d)["path"] = "/v1/" + new string('a', 1997))));
        Assert.DoesNotContain("AU004", Codes(With(d => Request(d)["path"] = "/v1/" + new string('a', 1996))));
    }

    [Theory]
    [InlineData("/v1/clientes/{cpf}/x-{valor}.json")]
    [InlineData("/v1")]
    [InlineData("/v1/a%20b")]
    [InlineData("/v1/..x/~a!$&'()*+,;=:@")]
    [InlineData("/v1/")]
    public void Near_misses_for_the_path_pass(string path) => Assert.DoesNotContain("AU004", Codes(With(d => Request(d)["path"] = path)));

    // AU005: query

    [Fact]
    public void Query_names_are_1_to_100_characters()
    {
        Assert.Contains("AU005", Codes(With(d => Request(d)["query"]![""] = "x")));
        Assert.Contains("AU005", Codes(With(d => Request(d)["query"]![new string('q', 101)] = "x")));
        Assert.DoesNotContain("AU005", Codes(With(d => Request(d)["query"]![new string('q', 100)] = "x")));
    }

    [Theory]
    [InlineData("{nope}")]
    [InlineData("{itens}")]
    [InlineData("x{valor}")]
    [InlineData("{valor}{cpf}")]
    [InlineData("{{secret:erp_api_key}}")]
    public void Query_values_are_literals_or_exactly_one_scalar_input(string value) => Assert.Contains("AU005", Codes(With(d => Request(d)["query"]!["q"] = value)));

    [Theory]
    [InlineData("{cpf}")]
    [InlineData("chain")]
    [InlineData("""{"a":1}""")]
    [InlineData("")]
    public void Near_misses_for_query_values_pass(string value) => Assert.Empty(Codes(With(d => Request(d)["query"]!["q"] = value)));

    // AU006: headers

    [Theory]
    [InlineData("X Api")]
    [InlineData("")]
    [InlineData("X-Ação")]
    [InlineData("Host")]
    [InlineData("content-length")]
    [InlineData("Transfer-Encoding")]
    [InlineData("Connection")]
    [InlineData("Upgrade")]
    [InlineData("TE")]
    [InlineData("Trailer")]
    [InlineData("Proxy-Authorization")]
    [InlineData("idempotency-key")] // the default idempotency header
    [InlineData("accept")] // the same name as "Accept", ignoring case
    public void Header_names_are_tokens_and_not_reserved(string name) => Assert.Contains("AU006", Codes(With(d => Request(d)["headers"]![name] = "x")));

    [Theory]
    [InlineData("a\r\nX-Injected: 1")]
    [InlineData("a\nb")]
    [InlineData("{cpf}")]
    [InlineData("Bearer {valor}")]
    [InlineData("{{erp_api_key}}")] // a {key} inside: inputs never go in headers in E4 (AU-4)
    public void Header_values_have_no_line_breaks_and_no_inputs(string value) => Assert.Contains("AU006", Codes(With(d => Request(d)["headers"]!["X-Value"] = value)));

    [Theory]
    [InlineData("João")] // non-ASCII: the HTTP client sends only visible ASCII, spaces and tabs (automation-contract.md §3)
    [InlineData("a\u00A0b")] // a no-break space is not a space
    [InlineData("a\u007Fb")] // DEL, just above '~'
    [InlineData("a\u001Fb")] // a control character, just below ' '
    [InlineData("a\vb")] // a vertical tab is not a tab
    public void Header_values_hold_only_visible_ascii_spaces_and_tabs(string value) =>
        Assert.Contains("AU006", Codes(With(d => Request(d)["headers"]!["X-Nome"] = value)));

    [Theory]
    [InlineData("Joao")]
    [InlineData("a\tb")]
    [InlineData("a b")]
    [InlineData("!~")] // the first and the last visible ASCII characters
    [InlineData("{{secret:erp_api_key}}")] // the secret's value is checked when the step runs
    public void Near_misses_for_header_values_pass(string value) => Assert.Empty(Codes(With(d => Request(d)["headers"]!["X-Nome"] = value)));

    [Fact]
    public void There_are_at_most_30_headers()
    {
        Assert.Contains("AU006", Codes(With(d => Request(d)["headers"] = new JsonObject([.. Enumerable.Range(0, 31).Select(i => KeyValuePair.Create($"X-H{i}", (JsonNode?)"v"))]))));
        Assert.DoesNotContain("AU006", Codes(With(d => Request(d)["headers"] = new JsonObject([.. Enumerable.Range(0, 30).Select(i => KeyValuePair.Create($"X-H{i}", (JsonNode?)"v"))]))));
    }

    [Fact]
    public void Near_misses_for_headers_pass()
    {
        Assert.Empty(Codes(With(d => Request(d)["headers"]!["X-Proxy"] = "x")));
        Assert.Empty(Codes(With(d => Request(d)["headers"]!["Content-Type"] = "application/json; charset=utf-8")));
        Assert.Empty(Codes(With(d => Request(d)["headers"]!["X-Template"] = """{"a": 1} { x }"""))); // braces, but no {key}
        Assert.Empty(Codes(With(d =>
        {
            Request(d)["headers"]!["Idempotency-Key"] = "fixed";
            d["execution"] = new JsonObject { ["idempotency"] = new JsonObject { ["mode"] = "none" } };
        })));
    }

    // AU007: secret placeholders

    [Theory]
    [InlineData("{{secret:ERP}}")]
    [InlineData("{{secret:erp_api_key")]
    [InlineData("{{secret:}}")]
    [InlineData("{{secret: erp_api_key}}")]
    [InlineData("Bearer {{secret:erp_api_key}} {{secret:-x}}")]
    public void Placeholders_are_well_formed(string value) => Assert.Contains("AU007", Codes(With(d => Request(d)["headers"]!["Authorization"] = value)));

    [Fact]
    public void Placeholders_appear_only_in_header_values_and_basic_auth()
    {
        Assert.Contains("AU007", Codes(With(d => Request(d)["query"]!["key"] = "{{secret:erp_api_key}}")));
        Assert.Contains("AU007", Codes(With(d => Request(d)["path"] = "/v1/{{secret:erp_api_key}}")));
        Assert.Contains("AU007", Codes(With(d => Request(d)["host"] = "{{secret:erp_api_key}}")));
        Assert.Contains("AU007", Codes(With(d => Request(d)["headers"]!["{{secret:erp_api_key}}"] = "x")));
        Assert.Contains("AU007", Codes(With(d => d["outputs"]![0]!["path"]![1] = "{{secret:erp_api_key}}")));
    }

    [Fact]
    public void Near_misses_for_placeholders_pass()
    {
        Assert.Empty(Codes(With(d => Request(d)["headers"]!["Authorization"] = "Bearer {{secret:erp_api_key}}")));
        Assert.Empty(Codes(With(d => Request(d)["auth"] = new JsonObject
        {
            ["type"] = "basic", ["username"] = "{{secret:erp_user}}", ["password"] = "pre-{{secret:erp_api_key}}",
        })));
    }

    // AU008: basic auth

    [Theory]
    [InlineData("digest", "u", "p")]
    [InlineData("basic", "", "p")]
    [InlineData("basic", "u", "")]
    public void Auth_is_basic_with_a_username_and_a_password(string type, string username, string password) =>
        Assert.Contains("AU008", Codes(With(d => Request(d)["auth"] = new JsonObject { ["type"] = type, ["username"] = username, ["password"] = password })));

    [Fact]
    public void Auth_and_an_authorization_header_do_not_mix()
    {
        Assert.Contains("AU008", Codes(With(d =>
        {
            Request(d)["auth"] = new JsonObject { ["type"] = "basic", ["username"] = "u", ["password"] = "p" };
            Request(d)["headers"]!["authorization"] = "Bearer x";
        })));
        Assert.Empty(Codes(With(d => Request(d)["headers"]!["Authorization"] = "Bearer {{secret:erp_api_key}}")));
    }

    private static JsonObject Basic(string username, string password = "{{secret:erp_api_key}}") => new() { ["type"] = "basic", ["username"] = username, ["password"] = password };

    [Theory]
    [InlineData("a:b")]
    [InlineData(":")]
    [InlineData("{{secret:erp_user}}:x")] // the colon is literal, whatever the secret holds
    public void A_basic_auth_username_has_no_colon(string username) => Assert.Contains("AU008", Codes(With(d => Request(d)["auth"] = Basic(username))));

    // #128: RFC 7617 forbids control characters in the user-id and the password; a secret's value is checked when the step runs.
    [Theory]
    [InlineData("ana\nsouza", "p", "request.auth.username")]
    [InlineData("ana\u001b", "p", "request.auth.username")] // NUL is refused earlier, as text that can't be stored (#93)
    [InlineData("u", "pass\tword", "request.auth.password")]
    [InlineData("u", "pass\u007f", "request.auth.password")]
    [InlineData("u", "pass\u0085", "request.auth.password")] // a C1 control, as char.IsControl reads it
    public void Basic_auth_has_no_control_characters(string username, string password, string path)
    {
        var issues = AutomationRules.Validate(Parse(With(d => Request(d)["auth"] = Basic(username, password))));

        Assert.Contains(issues, issue => issue.Code == "AU008" && issue.Path == path);
    }

    [Fact]
    public void Near_misses_for_the_username_pass()
    {
        Assert.Empty(Codes(With(d => Request(d)["auth"] = Basic("{{secret:erp_user}}")))); // the secret's value is checked when the step runs
        Assert.Empty(Codes(With(d => Request(d)["auth"] = Basic("pre-{{secret:erp_user}}"))));
        Assert.Empty(Codes(With(d => Request(d)["auth"] = Basic("ana.souza"))));
        Assert.Empty(Codes(With(d => Request(d)["auth"] = Basic("u", "a:b{{secret:erp_api_key}}")))); // RFC 7617 allows ':' in the password
        Assert.Empty(Codes(With(d => Request(d)["auth"] = Basic("joão", "senha com espaço e ç {{secret:erp_api_key}}")))); // text beyond ASCII is no control
        Assert.Equal(["AU007"], Codes(With(d => Request(d)["auth"] = Basic("{{secret:ERP}}")))); // a malformed placeholder, not a ':' in the username
    }

    // AU013: no literal credentials (Q-AS4 (c), #235)

    [Theory]
    [InlineData("Authorization", "Bearer abc123")]
    [InlineData("authorization", "abc")]
    [InlineData("Cookie", "sessao=abc")]
    [InlineData("X-Api-Key", "abc123")]
    [InlineData("x-api-key", "")]
    public void Credential_headers_hold_a_placeholder(string name, string value)
    {
        var issue = Assert.Single(AutomationRules.Validate(Parse(With(d => Request(d)["headers"]![name] = value))), issue => issue.Code == "AU013");

        Assert.Equal(($"The header '{name}' holds a {{{{secret:…}}}} credential, not a literal one (ADR-0012).", $"request.headers.{name}"), (issue.Message, issue.Path));
    }

    [Fact]
    public void A_basic_auth_password_holds_a_placeholder()
    {
        var issue = Assert.Single(AutomationRules.Validate(Parse(With(d => Request(d)["auth"] = Basic("u", "hunter2")))));

        Assert.Equal(("AU013", "The password holds a {{secret:…}} credential, not a literal one (ADR-0012).", "request.auth.password"), (issue.Code, issue.Message, issue.Path));
    }

    [Fact]
    public void Near_misses_for_literal_credentials_pass()
    {
        Assert.Empty(Codes(With(d => Request(d)["headers"]!["Authorization"] = "Bearer {{secret:erp_api_key}}")));
        Assert.Empty(Codes(With(d => Request(d)["headers"]!["Accept"] = "application/json"))); // not a credential header
        Assert.Empty(Codes(With(d => Request(d)["auth"] = Basic("chain", "pre-{{secret:erp_api_key}}")))); // a literal username is fine
        Assert.Equal(["AU007"], Codes(With(d => Request(d)["headers"]!["Authorization"] = "{{secret:ERP}}"))); // malformed: AU007's alone
        Assert.DoesNotContain("AU013", Codes(With(d => Request(d)["auth"] = Basic("u", "")))); // an empty password is AU008's
    }

    // AU009: body

    [Fact]
    public void Body_keys_name_inputs_once_and_the_body_is_json()
    {
        Assert.Contains("AU009", Codes(With(d => Request(d)["body"]!["keys"] = new JsonArray("cpf", "nope"))));
        Assert.Contains("AU009", Codes(With(d => Request(d)["body"]!["keys"] = new JsonArray("cpf", "cpf"))));
        Assert.Contains("AU009", Codes(With(d => Request(d)["body"]!["type"] = "xml")));
    }

    [Fact]
    public void Near_misses_for_the_body_pass()
    {
        Assert.Empty(Codes(With(d => Request(d)["body"]!.AsObject().Remove("keys"))));
        Assert.Empty(Codes(With(d => Request(d)["body"]!["keys"] = new JsonArray())));
        Assert.Empty(Codes(With(d => Request(d)["body"] = null)));
    }

    // AU010: outputs and response

    [Fact]
    public void Outputs_read_the_body_by_path_or_the_status_as_a_number()
    {
        Assert.Contains("AU010", Codes(With(d => d["outputs"]![0]!["source"] = "header")));
        Assert.Contains("AU010", Codes(With(d => d["outputs"]![0]!.AsObject().Remove("path"))));
        Assert.Contains("AU010", Codes(With(d => d["outputs"]![0]!["path"] = new JsonArray())));
        Assert.Contains("AU010", Codes(With(d => d["outputs"]![0]!["path"] = new JsonArray([.. Enumerable.Range(0, 21).Select(i => (JsonNode)$"p{i}")]))));
        Assert.Contains("AU010", Codes(With(d => d["outputs"]![0]!["path"] = new JsonArray("a", -1))));
        Assert.Contains("AU010", Codes(With(d => d["outputs"]![0]!["path"] = new JsonArray("a", 1.5))));
        Assert.Contains("AU010", Codes(With(d => d["outputs"]![0]!["path"] = new JsonArray("a", ""))));
        Assert.Contains("AU010", Codes(With(d => d["outputs"]![0]!["path"] = new JsonArray("a", null))));
        Assert.Contains("AU010", Codes(With(d => d["outputs"]![0]!["path"] = new JsonArray("a", true))));
        Assert.Contains("AU010", Codes(With(d => d["outputs"]![2]!["type"] = "text")));
        Assert.Contains("AU010", Codes(With(d => d["outputs"]![2]!["path"] = new JsonArray("a"))));
    }

    [Fact]
    public void Body_outputs_need_a_json_response()
    {
        Assert.Contains("AU010", Codes(With(d => d["response"]!["type"] = "none")));
        Assert.Contains("AU010", Codes(With(d => d["response"]!["type"] = "xml")));
        Assert.Empty(Codes(With(d =>
        {
            d["response"]!["type"] = "none";
            d["outputs"] = new JsonArray(new JsonObject { ["key"] = "httpStatus", ["type"] = "number", ["source"] = "status" });
        })));
    }

    [Fact]
    public void Near_misses_for_output_paths_pass()
    {
        Assert.Empty(Codes(With(d => d["outputs"]![0]!["path"] = new JsonArray([.. Enumerable.Range(0, 20).Select(i => (JsonNode)$"p{i}")]))));
        Assert.Empty(Codes(With(d => d["outputs"]![0]!["path"] = new JsonArray("itens", 0, "nome"))));
    }

    // AU011: execution limits

    [Theory]
    [InlineData("""{"timeoutSeconds":0}""")]
    [InlineData("""{"timeoutSeconds":301}""")]
    [InlineData("""{"retry":{"maxAttempts":0}}""")]
    [InlineData("""{"retry":{"maxAttempts":11}}""")]
    [InlineData("""{"retry":{"initialDelaySeconds":0}}""")]
    [InlineData("""{"retry":{"initialDelaySeconds":61}}""")]
    [InlineData("""{"redirects":{"follow":true}}""")]
    [InlineData("""{"redirects":{"follow":true,"max":0}}""")]
    [InlineData("""{"redirects":{"follow":true,"max":4}}""")]
    [InlineData("""{"redirects":{"follow":false,"max":2}}""")]
    public void Execution_limits_are_in_range(string execution) => Assert.Contains("AU011", Codes(With(d => d["execution"] = JsonNode.Parse(execution))));

    [Theory]
    [InlineData("""{"timeoutSeconds":1,"retry":{"maxAttempts":1,"initialDelaySeconds":1}}""")]
    [InlineData("""{"timeoutSeconds":300,"retry":{"maxAttempts":10,"initialDelaySeconds":60}}""")]
    [InlineData("""{"redirects":{"follow":true,"max":3}}""")]
    [InlineData("""{"redirects":{"follow":true,"max":1}}""")]
    [InlineData("""{"redirects":{"follow":false,"max":0}}""")]
    [InlineData("""{}""")]
    public void Near_misses_for_execution_limits_pass(string execution) => Assert.Empty(Codes(With(d => d["execution"] = JsonNode.Parse(execution))));

    // AU012: idempotency

    [Theory]
    [InlineData("""{"mode":"always"}""")]
    [InlineData("""{"mode":"header","header":"Idem Key"}""")]
    [InlineData("""{"mode":"header","header":""}""")]
    [InlineData("""{"mode":"none","header":"Idempotency-Key"}""")]
    public void The_idempotency_header_is_a_token_used_with_mode_header(string idempotency) =>
        Assert.Contains("AU012", Codes(With(d => d["execution"] = new JsonObject { ["idempotency"] = JsonNode.Parse(idempotency) })));

    [Fact]
    public void The_idempotency_header_is_at_most_100_characters()
    {
        JsonObject Policy(int length) => new() { ["idempotency"] = new JsonObject { ["mode"] = "header", ["header"] = "X" + new string('k', length - 1) } };
        Assert.Contains("AU012", Codes(With(d => d["execution"] = Policy(101))));
        Assert.Empty(Codes(With(d => d["execution"] = Policy(100))));
        Assert.Empty(Codes(With(d => d["execution"] = new JsonObject { ["idempotency"] = new JsonObject { ["mode"] = "none" } })));
    }

    // AU101–AU106: references, checked at publish

    [Fact]
    public void The_destination_exists()
    {
        Assert.Contains("AU101", ReferenceCodes(Valid(), null));
        Assert.Contains("AU101", ReferenceCodes(With(d => Request(d)["destination"] = ""), null));
    }

    [Fact]
    public void Referenced_secrets_exist_and_allow_the_destination()
    {
        Assert.Contains("AU102", ReferenceCodes(Valid(), Erp(), new Dictionary<string, IReadOnlyList<string>>()));
        Assert.Contains("AU103", ReferenceCodes(Valid(), Erp(), new Dictionary<string, IReadOnlyList<string>> { ["erp_api_key"] = ["crm"] }));
        Assert.Contains("AU102", ReferenceCodes(
            With(d => Request(d)["auth"] = new JsonObject { ["type"] = "basic", ["username"] = "u", ["password"] = "{{secret:erp_password}}" }), Erp()));
    }

    // Card #206: AU103 for one secret, which a change of its allowed destinations is checked with (automation.md §4.2).

    [Fact]
    public void A_secret_must_allow_the_destination_only_when_the_document_uses_it()
    {
        var document = Parse(Valid()); // sends erp_api_key to "erp"

        var issue = Assert.Single(AutomationRules.CheckSecret(document, "erp_api_key", ["crm"]));
        Assert.Equal(("AU103", "The secret 'erp_api_key' is not allowed for the destination 'erp'.", "request"), (issue.Code, issue.Message, issue.Path));
        Assert.Empty(AutomationRules.CheckSecret(document, "erp_api_key", ["crm", "erp"]));
        Assert.Empty(AutomationRules.CheckSecret(document, "other_key", [])); // a secret the document doesn't use
    }

    [Fact]
    public void Secrets_go_over_plain_http_only_where_the_admin_allowed_it()
    {
        Assert.Contains("AU104", ReferenceCodes(Valid(), Erp(scheme: "http")));
        Assert.Empty(ReferenceCodes(Valid(), Erp(scheme: "http", secretsOverHttp: true)));
        Assert.Empty(ReferenceCodes(With(d => Request(d)["headers"]!.AsObject().Remove("X-Api-Key")), Erp(scheme: "http")));
    }

    [Theory]
    [InlineData("/v2/clientes")]
    [InlineData("/v1x")]
    [InlineData("/v1{cpf}")]
    [InlineData("/")]
    public void The_path_stays_within_the_destination_prefix(string path) => Assert.Contains("AU105", ReferenceCodes(With(d => Request(d)["path"] = path), Erp()));

    [Theory]
    [InlineData("/v1", "/v1")]
    [InlineData("/v1", "/v1/clientes/{cpf}")]
    [InlineData(null, "/qualquer")]
    [InlineData("/", "/qualquer/{cpf}")]
    [InlineData("/v1/", "/v1/clientes")]
    public void Near_misses_for_the_prefix_pass(string? prefix, string path) =>
        Assert.DoesNotContain("AU105", ReferenceCodes(With(d => Request(d)["path"] = path), Erp(pathPrefix: prefix)));

    [Theory]
    [InlineData(null)] // a wildcard destination needs a host
    [InlineData("example.com")] // not a proper subdomain
    [InlineData("api.other.com")]
    [InlineData("API.example.com")]
    [InlineData("evil.com/.example.com")]
    public void The_host_fits_a_wildcard_destination(string? host) =>
        Assert.Contains("AU106", ReferenceCodes(With(d => Request(d)["host"] = host), Erp(host: "*.example.com")));

    [Fact]
    public void The_host_of_an_exact_destination_is_absent_or_the_same()
    {
        Assert.Contains("AU106", ReferenceCodes(With(d => Request(d)["host"] = "other.erp.example"), Erp()));
        Assert.Empty(ReferenceCodes(With(d => Request(d)["host"] = "api.erp.example"), Erp()));
        Assert.Empty(ReferenceCodes(With(d => Request(d)["host"] = "api.example.com"), Erp(host: "*.example.com")));
        Assert.Empty(ReferenceCodes(With(d => Request(d)["host"] = "a.b.example.com"), Erp(host: "*.example.com")));
    }

    // The published form

    [Fact]
    public void Publishing_makes_the_defaults_explicit()
    {
        var published = JsonNode.Parse(AutomationDocumentParser.Normalize(Parse(JsonNode.Parse(
            """{"schemaVersion":1,"kind":"http","inputs":[{"key":"a","type":"text"}],"request":{"method":"GET","destination":"erp","path":"/"},"response":{"type":"none"}}""")!)))!;

        Assert.False(published["inputs"]![0]!["required"]!.GetValue<bool>());
        Assert.Equal("{}", published["request"]!["query"]!.ToJsonString());
        Assert.Equal("{}", published["request"]!["headers"]!.ToJsonString());
        Assert.True(published["request"]!.AsObject().ContainsKey("auth"));
        Assert.Null(published["request"]!["auth"]);
        Assert.True(published["request"]!.AsObject().ContainsKey("body"));
        Assert.Null(published["request"]!["body"]);
        Assert.Equal("[]", published["outputs"]!.ToJsonString());
        Assert.Equal(
            """{"idempotency":{"header":"Idempotency-Key","mode":"header"},"redirects":{"follow":false,"max":0},"retry":{"initialDelaySeconds":5,"maxAttempts":5},"timeoutSeconds":30}""",
            ContentHash.Canonicalize(published["execution"]!.ToJsonString()));
    }

    [Fact]
    public void The_same_automation_written_differently_has_one_content_hash()
    {
        var implicitDefaults = Valid();
        var explicitDefaults = With(d =>
        {
            Request(d)["auth"] = null;
            d["execution"] = JsonNode.Parse("""{"redirects":{"max":0,"follow":false},"timeoutSeconds":30,"retry":{"maxAttempts":5,"initialDelaySeconds":5},"idempotency":{"mode":"header","header":"Idempotency-Key"}}""");
        });

        Assert.Equal(
            ContentHash.Compute(AutomationDocumentParser.Normalize(Parse(implicitDefaults))),
            ContentHash.Compute(AutomationDocumentParser.Normalize(Parse(explicitDefaults))));
        Assert.NotEqual(
            ContentHash.Compute(AutomationDocumentParser.Normalize(Parse(implicitDefaults))),
            ContentHash.Compute(AutomationDocumentParser.Normalize(Parse(With(d => d["execution"] = JsonNode.Parse("""{"timeoutSeconds":31}"""))))));
    }

    [Fact]
    public void The_published_form_parses_and_keeps_every_rule_passing()
    {
        var published = AutomationDocumentParser.Normalize(Parse(Valid()));
        var reparsed = AutomationDocumentParser.Parse(published);

        Assert.True(reparsed.IsSuccess, reparsed.Error?.Message);
        Assert.Empty(AutomationRules.Validate(reparsed.Document!));
        Assert.Equal(published, AutomationDocumentParser.Normalize(reparsed.Document!));
    }

    [Fact]
    public void A_version_names_each_secret_it_uses_once_in_order()
    {
        var document = Parse(With(d =>
        {
            Request(d)["headers"]!["X-Other"] = "{{secret:zeta}} and {{secret:erp_api_key}}";
            Request(d)["auth"] = new JsonObject { ["type"] = "basic", ["username"] = "{{secret:alpha}}", ["password"] = "{{secret:erp_api_key}}" };
        }));

        Assert.Equal(["alpha", "erp_api_key", "zeta"], AutomationRules.SecretsOf(document));
    }

    // The definition

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Automation_names_are_not_blank(string name) => Assert.False(AutomationName.TryCreate(name, out _));

    [Fact]
    public void Automation_names_are_trimmed_and_at_most_100_characters()
    {
        Assert.True(AutomationName.TryCreate("  Consultar CPF  ", out var name));
        Assert.Equal(("Consultar CPF", "consultar cpf"), (name.Value, name.Normalized));
        Assert.True(AutomationName.TryCreate(new string('a', 100), out _));
        Assert.False(AutomationName.TryCreate(new string('a', 101), out _));
    }

    // Regression #129: PostgreSQL text cannot store the NUL character, so saving a name with one failed in the database.

    [Fact]
    public void Automation_names_postgresql_cannot_store_are_rejected()
    {
        Assert.False(AutomationName.TryCreate("Consultar\u0000CPF", out _));
        Assert.False(AutomationName.TryCreate("Consultar\ud800", out _));
    }
}
