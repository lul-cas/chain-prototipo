using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Chain.Expressions;
using Chain.SharedKernel;

namespace Chain.Automations.Tests;

/// <summary>
/// The work-request payload .NET writes for Elixir (automation-contract.md §3), the input contract it checks first (automation.md
/// §7.1), and the step deadline (§8.2).
/// </summary>
public sealed partial class WorkRequestTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 16, 12, 0, 0, TimeSpan.Zero);
    private static readonly Guid RequestId = Guid.Parse("0199f000-0000-7000-8000-00000000000a");
    private static readonly Guid InstanceId = Guid.Parse("0199f000-0000-7000-8000-00000000000b");
    private static readonly Guid AutomationId = Guid.Parse("0199f000-0000-7000-8000-00000000000c");

    // The shared fixture (ADR-0011 §11): Elixir checks the same file

    [Fact]
    public void Builds_the_shared_work_request_fixture()
    {
        using var fixture = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "contract", "work-request.json")));
        var scenario = fixture.RootElement.GetProperty("scenario");
        var now = DateTimeOffset.Parse(scenario.GetProperty("now").GetString()!, CultureInfo.InvariantCulture);
        var draft = AutomationDocumentParser.Parse(scenario.GetProperty("automation").GetProperty("document").GetRawText()).Document!;
        var published = AutomationDocumentParser.Parse(ContentHash.Canonicalize(AutomationDocumentParser.Normalize(draft))).Document!;
        var place = scenario.GetProperty("destination");
        var destination = Destination.Create(
            place.GetProperty("name").GetString(),
            new DestinationSettings(null, place.GetProperty("scheme").GetString(), place.GetProperty("host").GetString(), null,
                place.GetProperty("pathPrefix").GetString(), false, false, null, null),
            Guid.Empty, now).Value!;
        var inputs = Evaluate(scenario.GetProperty("stepInputs"), scenario.GetProperty("instanceData"), now);
        var requestId = Guid.CreateVersion7();
        var context = new DispatchContext(
            requestId, Guid.CreateVersion7(), scenario.GetProperty("nodeId").GetString()!, 1, Guid.CreateVersion7(), 1,
            scenario.GetProperty("automation").GetProperty("name").GetString()!, requestId.ToString(), now, TraceId(), null);

        var built = WorkRequestBuilder.Build(published, destination, inputs, context);

        Assert.Null(built.InputError);
        var expected = JsonNode.Parse(fixture.RootElement.GetProperty("expected").GetRawText())!.AsObject();
        var actual = built.Payload!.DeepClone().AsObject();
        foreach (var path in fixture.RootElement.GetProperty("volatile").EnumerateArray().Select(p => p.GetString()!))
        {
            Assert.Equal(Format(Take(expected, path)), Format(Take(actual, path)));
        }

        Assert.True(JsonNode.DeepEquals(expected, actual), actual.ToJsonString());
    }

    [Fact]
    public void The_payload_names_the_activation_it_was_built_for()
    {
        var built = Build(Document("""{"method":"GET","destination":"erp","path":"/v1/clientes/{cpf}"}"""), """{"cpf":"1"}""");

        var payload = built.Payload!;
        Assert.Equal(1, payload["contractVersion"]!.GetValue<int>());
        Assert.Equal(RequestId.ToString(), payload["requestId"]!.GetValue<string>());
        Assert.Equal(InstanceId.ToString(), payload["instanceId"]!.GetValue<string>());
        Assert.Equal("task_cpf|1", $"{payload["nodeId"]}|{payload["activation"]}");
        Assert.Equal($$"""{"id":"{{AutomationId}}","version":3,"name":"Consultar CPF"}""", payload["automation"]!.ToJsonString());
        Assert.Equal($$"""{"header":"Idempotency-Key","key":"{{RequestId}}"}""", payload["idempotency"]!.ToJsonString());
        Assert.Equal("4bf92f3577b34da6a3ce929d0e0e4736", payload["correlationId"]!.GetValue<string>());
        Assert.Null(payload["traceparent"]);
    }

    // The input contract (automation.md §7.1)

    [Fact]
    public void Every_input_problem_is_reported_together_and_nothing_is_built()
    {
        var document = Document(
            """{"method":"GET","destination":"erp","path":"/v1/clientes"}""",
            """[{"key":"cpf","type":"text","required":true},{"key":"valor","type":"number"},{"key":"ativo","type":"boolean"}]""");

        var built = Build(document, """{"valor":"10","ativo":true}""");

        Assert.Null(built.Payload);
        Assert.Equal("The input 'cpf' is required. The input 'valor' must be a number.", built.InputError);
    }

    [Theory]
    [InlineData("text", "\"a\"", true)]
    [InlineData("text", "1", false)]
    [InlineData("number", "1.5", true)]
    [InlineData("number", "\"1\"", false)]
    [InlineData("boolean", "false", true)]
    [InlineData("boolean", "\"true\"", false)]
    [InlineData("date", "\"2026-10-16\"", true)]
    [InlineData("date", "\"16/10/2026\"", false)]
    [InlineData("datetime", "\"2026-10-16T12:00:00Z\"", true)]
    [InlineData("datetime", "\"ontem\"", false)]
    [InlineData("time", "\"12:30\"", true)]
    [InlineData("time", "\"25:00\"", false)]
    [InlineData("object", "{\"a\":1}", true)]
    [InlineData("object", "[1]", false)]
    [InlineData("list<number>", "[1,2]", true)]
    [InlineData("list<number>", "[1,\"2\"]", false)]
    [InlineData("list<list<text>>", "[[\"a\"],[]]", true)]
    [InlineData("list<text>", "\"a\"", false)]
    [InlineData("unknown", "{\"a\":[1]}", true)]
    public void Values_fit_their_declared_type(string type, string json, bool fits) =>
        Assert.Equal(fits, ContractTypes.Fits(JsonNode.Parse(json), type));

    // Card #76: the workflow data catalog types inputs and outputs with these (workflow-definition.md §6.1).

    [Theory]
    [InlineData("text", "text")]
    [InlineData("number", "number")]
    [InlineData("boolean", "boolean")]
    [InlineData("date", "date")]
    [InlineData("datetime", "datetime")]
    [InlineData("time", "time")]
    [InlineData("object", "object")]
    [InlineData("list<list<date>>", "list<list<date>>")]
    [InlineData("unknown", "unknown")]
    [InlineData("list<text", "unknown")] // not a type: publishing refuses it (AU002)
    public void Contract_types_are_the_catalog_types(string type, string catalog) =>
        Assert.Equal(catalog, ContractTypes.ToExprType(type).ToString());

    [Fact]
    public void An_object_declares_no_fields()
    {
        var type = ContractTypes.ToExprType("object");

        Assert.Equal(TypeKind.Record, type.Kind);
        Assert.Empty(type.Fields);
    }

    // The URL (automation.md §5.2, automation-contract.md §3)

    [Theory]
    [InlineData("a/b c", "/v1/clientes/a%2Fb%20c")]
    [InlineData("José~1.2_3-4", "/v1/clientes/Jos%C3%A9~1.2_3-4")]
    public void A_path_input_is_one_percent_encoded_segment(string cpf, string path)
    {
        var built = Build(Document("""{"method":"GET","destination":"erp","path":"/v1/clientes/{cpf}"}"""), new JsonObject { ["cpf"] = cpf }.ToJsonString());

        Assert.Equal("https://api.erp.example" + path, Url(built));
    }

    [Theory]
    [InlineData("""{"cpf":""}""", "The path input 'cpf' cannot be empty, '.' or '..'.")]
    [InlineData("""{"cpf":"."}""", "The path input 'cpf' cannot be empty, '.' or '..'.")]
    [InlineData("""{"cpf":".."}""", "The path input 'cpf' cannot be empty, '.' or '..'.")]
    [InlineData("{}", "The path input 'cpf' is missing.")]
    public void A_path_input_can_never_be_missing_empty_or_climb(string inputs, string error)
    {
        var document = Document("""{"method":"GET","destination":"erp","path":"/v1/clientes/{cpf}"}""", """[{"key":"cpf","type":"text"}]""");

        Assert.Equal(error, Build(document, inputs).InputError);
    }

    [Fact]
    public void Query_parameters_are_sorted_encoded_and_left_out_when_their_input_is_missing()
    {
        var document = Document(
            """{"method":"GET","destination":"erp","path":"/v1","query":{"z":"1 2&3","cpf":"{cpf}","nota":"{nota}","a":"x+y"}}""",
            """[{"key":"cpf","type":"text","required":true},{"key":"nota","type":"text"}]""");

        Assert.Equal("https://api.erp.example/v1?a=x%2By&cpf=123.456%2F78&z=1%202%263", Url(Build(document, """{"cpf":"123.456/78"}""")));
    }

    [Fact]
    public void Numbers_booleans_and_temporal_values_are_written_as_JSON_writes_them()
    {
        var document = Document(
            """{"method":"GET","destination":"erp","path":"/v1/{dia}","query":{"valor":"{valor}","ativo":"{ativo}"}}""",
            """[{"key":"dia","type":"date","required":true},{"key":"valor","type":"number"},{"key":"ativo","type":"boolean"}]""");

        Assert.Equal("https://api.erp.example/v1/2026-10-16?ativo=true&valor=1500.50", Url(Build(document, """{"dia":"2026-10-16","valor":1500.50,"ativo":true}""")));
    }

    [Theory]
    [InlineData("https", "*.erp.example", null, "sp.erp.example", "https://sp.erp.example/v1")]
    [InlineData("https", "api.erp.example", 8443, null, "https://api.erp.example:8443/v1")]
    [InlineData("https", "api.erp.example", 443, null, "https://api.erp.example/v1")]
    [InlineData("http", "erp.internal", 80, null, "http://erp.internal/v1")]
    [InlineData("http", "erp.internal", 8080, null, "http://erp.internal:8080/v1")]
    public void The_URL_uses_the_request_host_for_wildcards_and_only_non_default_ports(string scheme, string host, int? port, string? requestHost, string url)
    {
        var request = new JsonObject { ["method"] = "GET", ["destination"] = "erp", ["path"] = "/v1" };
        if (requestHost is not null)
        {
            request["host"] = requestHost;
        }

        var destination = Erp(scheme, host, port, @internal: scheme == "http");

        Assert.Equal(url, Url(Build(Document(request.ToJsonString()), """{"cpf":"1"}""", destination)));
    }

    // Headers, authentication and body

    [Fact]
    public void Headers_are_sorted_with_Content_Type_added_for_a_JSON_body_that_has_none()
    {
        var document = Document("""{"method":"POST","destination":"erp","path":"/v1","headers":{"accept":"application/json","X-B":"{{secret:erp_api_key}}"},"body":{"type":"json"}}""");

        Assert.Equal(
            """[["Content-Type","application/json"],["X-B","{{secret:erp_api_key}}"],["accept","application/json"]]""",
            Build(document, """{"cpf":"1"}""").Payload!["request"]!["headers"]!.ToJsonString());
    }

    [Theory]
    [InlineData("""{"method":"POST","destination":"erp","path":"/v1","headers":{"content-type":"application/vnd.api+json"},"body":{"type":"json"}}""", """[["content-type","application/vnd.api+json"]]""")]
    [InlineData("""{"method":"GET","destination":"erp","path":"/v1","headers":{"Accept":"*/*"}}""", """[["Accept","*/*"]]""")]
    public void Content_Type_is_left_alone_when_set_and_absent_without_a_body(string request, string headers)
    {
        var actual = Build(Document(request), """{"cpf":"1"}""").Payload!["request"]!["headers"];

        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(headers), actual), actual!.ToJsonString());
    }

    [Fact]
    public void Basic_auth_and_secret_names_travel_as_placeholders()
    {
        var document = Document("""{"method":"GET","destination":"erp","path":"/v1","auth":{"type":"basic","username":"{{secret:erp_user}}","password":"{{secret:erp_pass}}"}}""");

        var payload = Build(document, """{"cpf":"1"}""").Payload!;

        Assert.Equal("""{"username":"{{secret:erp_user}}","password":"{{secret:erp_pass}}"}""", payload["request"]!["basicAuth"]!.ToJsonString());
        Assert.Equal("""["erp_pass","erp_user"]""", payload["secrets"]!.ToJsonString());
    }

    [Theory]
    [InlineData("""{"type":"json","keys":["valor","cpf"]}""", """{"valor":1500,"cpf":"João"}""")]
    [InlineData("""{"type":"json"}""", """{"cpf":"João","valor":1500}""")]
    public void The_body_holds_the_listed_inputs_in_order_or_every_input(string body, string expected)
    {
        var document = Document(
            $$"""{"method":"POST","destination":"erp","path":"/v1","body":{{body}}}""",
            """[{"key":"cpf","type":"text","required":true},{"key":"valor","type":"number"},{"key":"nota","type":"text"}]""");

        var text = Build(document, """{"cpf":"João","valor":1500}""").Payload!["request"]!["body"]!.GetValue<string>();

        Assert.Equal(JsonNode.Parse(expected)!.ToJsonString(), JsonNode.Parse(text)!.ToJsonString());
        Assert.Contains("João", text, StringComparison.Ordinal); // UTF-8, not a \u escape
    }

    [Fact]
    public void Without_a_body_the_payload_body_is_null()
    {
        var payload = Build(Document("""{"method":"GET","destination":"erp","path":"/v1"}"""), """{"cpf":"1"}""").Payload!;

        Assert.Null(payload["request"]!["body"]);
        Assert.Null(payload["request"]!["basicAuth"]);
        Assert.Equal("[]", payload["secrets"]!.ToJsonString());
    }

    // Execution, idempotency and the deadline (automation.md §8.2–§8.3)

    [Fact]
    public void Execution_settings_travel_in_milliseconds_and_mode_none_sends_no_key()
    {
        var document = Document(
            """{"method":"GET","destination":"erp","path":"/v1"}""",
            execution: """{"timeoutSeconds":10,"retry":{"maxAttempts":3,"initialDelaySeconds":60},"idempotency":{"mode":"none"},"redirects":{"follow":true,"max":2}}""");

        var payload = Build(document, """{"cpf":"1"}""").Payload!;

        Assert.Equal("""{"timeoutMs":10000,"maxAttempts":3,"initialDelayMs":60000,"followRedirects":true,"maxRedirects":2}""", payload["execution"]!.ToJsonString());
        Assert.Null(payload["idempotency"]);
    }

    [Theory]
    [InlineData(30, 5, 5, 990)] // 150 + 4 × 60 + 600
    [InlineData(10, 3, 60, 828)] // 30 + 66 + 132 + 600
    [InlineData(300, 10, 60, 6042)] // 3000 + 66 + 132 + 264 + 6 × 330 + 600
    [InlineData(1, 1, 1, 601)]
    public void The_deadline_follows_the_formula(int timeoutSeconds, int maxAttempts, int initialDelaySeconds, int seconds)
    {
        var execution = new EffectiveExecution(timeoutSeconds, maxAttempts, initialDelaySeconds, "header", "Idempotency-Key", false, 0);

        Assert.Equal(Now.AddSeconds(seconds), StepDeadline.For(Now, execution));
    }

    [Fact]
    public void The_deadline_is_rounded_down_to_the_second_in_the_payload_and_the_result()
    {
        var built = Build(Document("""{"method":"GET","destination":"erp","path":"/v1"}"""), """{"cpf":"1"}""", now: Now.AddMilliseconds(750));

        Assert.Equal(Now.AddSeconds(990), built.DeadlineAt);
        Assert.Equal("2026-10-16T12:16:30Z", built.Payload!["deadlineAt"]!.GetValue<string>());
    }

    // Helpers

    private static Destination Erp(string scheme = "https", string host = "api.erp.example", int? port = null, bool @internal = false) =>
        Destination.Create("erp", new DestinationSettings(null, scheme, host, port, "/v1", @internal, false, null, null), Guid.Empty, Now).Value!;

    /// <summary>A document with the given request, inputs and execution; the rest default, as a published version has them.</summary>
    private static AutomationDocument Document(string request, string inputs = """[{"key":"cpf","type":"text","required":true}]""", string? execution = null)
    {
        var json = $$"""{"schemaVersion":1,"kind":"http","inputs":{{inputs}},"request":{{request}},"response":{"type":"json"}{{(execution is null ? "" : ",\"execution\":" + execution)}}}""";
        var parsed = AutomationDocumentParser.Parse(json);
        Assert.True(parsed.IsSuccess, parsed.Error?.Message);
        return AutomationDocumentParser.Parse(AutomationDocumentParser.Normalize(parsed.Document!)).Document!;
    }

    private static WorkRequestBuild Build(AutomationDocument document, string inputs, Destination? destination = null, DateTimeOffset? now = null) =>
        WorkRequestBuilder.Build(
            document, destination ?? Erp(), JsonNode.Parse(inputs)!.AsObject(),
            new DispatchContext(RequestId, InstanceId, "task_cpf", 1, AutomationId, 3, "Consultar CPF", RequestId.ToString(), now ?? Now, TraceId(), null));

    private static string TraceId() => "4bf92f3577b34da6a3ce929d0e0e4736";

    private static string Url(WorkRequestBuild built) => built.Payload!["request"]!["url"]!.GetValue<string>();

    /// <summary>The step's input mappings evaluated over the instance's data, as the engine does at dispatch.</summary>
    private static JsonObject Evaluate(JsonElement mappings, JsonElement data, DateTimeOffset now)
    {
        var inputs = new JsonObject();
        var context = new EvaluationContext(data, now, TimeSpan.Zero);
        foreach (var mapping in mappings.EnumerateObject())
        {
            var value = Evaluator.Evaluate(ExpressionParser.ParseValue(mapping.Value).Value!, context);
            if (value is not ExprValue.MissingValue)
            {
                inputs[mapping.Name] = value.ToJsonNode();
            }
        }

        return inputs;
    }

    /// <summary>Removes the value at a dotted path and returns it.</summary>
    private static JsonNode? Take(JsonObject root, string path)
    {
        var parts = path.Split('.');
        var parent = parts[..^1].Aggregate(root, (node, part) => node[part]!.AsObject());
        var value = parent[parts[^1]];
        parent.Remove(parts[^1]);
        return value;
    }

    /// <summary>The fixture's volatile formats: a UUID, a 32-character hex trace id, or null.</summary>
    private static string Format(JsonNode? value) => value?.GetValue<string>() switch
    {
        null => "null",
        var text when Guid.TryParseExact(text, "D", out _) => "uuid",
        var text when HexTraceId().IsMatch(text) => "trace-id",
        var text => $"unexpected '{text}'",
    };

    [GeneratedRegex("^[0-9a-f]{32}\\z")]
    private static partial Regex HexTraceId();
}
