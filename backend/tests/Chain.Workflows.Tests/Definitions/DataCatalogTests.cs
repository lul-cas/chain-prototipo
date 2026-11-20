using System.Text.Json.Nodes;
using Chain.Expressions;
using Chain.Workflows.Definitions;

namespace Chain.Workflows.Tests.Definitions;

/// <summary>Data catalog flow analysis and type rules WF201–WF206 (workflow-definition.md §6).</summary>
public sealed class DataCatalogTests
{
    // Builders

    private static JsonObject Start(string id = "start") => new() { ["id"] = id, ["type"] = "start", ["label"] = id };

    private static JsonObject Task(string id) => new() { ["id"] = id, ["type"] = "task", ["taskKind"] = "human", ["label"] = id };

    private static JsonObject End(string id = "end") => new() { ["id"] = id, ["type"] = "end", ["label"] = id };

    private static JsonObject HumanGateway(string id) => new() { ["id"] = id, ["type"] = "gateway", ["label"] = id, ["decisionMode"] = "human", ["question"] = "?" };

    private static JsonObject AutoGateway(string id, JsonNode condition) =>
        new() { ["id"] = id, ["type"] = "gateway", ["label"] = id, ["decisionMode"] = "automatic", ["condition"] = condition };

    private static JsonObject Subprocess(string id, JsonObject? inputs = null, JsonObject? outputs = null) => new()
    {
        ["id"] = id, ["type"] = "task", ["taskKind"] = "subprocess", ["label"] = id,
        ["workflow"] = new JsonObject { ["workflowId"] = "7f1d2c3b-0000-4000-8000-000000000001", ["inputs"] = inputs, ["outputs"] = outputs },
    };

    private static JsonObject Flow(string source, string target, string? branch = null)
    {
        var flow = new JsonObject { ["id"] = $"f_{source}_{target}_{branch}", ["source"] = source, ["target"] = target };
        if (branch is not null)
        {
            flow["branch"] = branch;
        }

        return flow;
    }

    private static WorkflowDocument Document(JsonArray nodes, JsonArray flows)
    {
        var json = new JsonObject { ["schemaVersion"] = 1, ["lanes"] = new JsonArray(), ["nodes"] = nodes, ["flows"] = flows };
        var parsed = WorkflowDocumentParser.Parse(json.ToJsonString());
        Assert.True(parsed.IsSuccess, parsed.Error?.Message);
        return parsed.Document!;
    }

    private static JsonObject Path(params string[] path) => new() { ["kind"] = "path", ["path"] = new JsonArray([.. path.Select(p => JsonValue.Create(p))]) };

    private static JsonObject Literal(string type, string value) => new() { ["kind"] = "literal", ["type"] = type, ["value"] = value };

    private static JsonObject Compare(JsonObject left, string op, JsonObject right) => new() { ["kind"] = "compare", ["left"] = left, ["operator"] = op, ["right"] = right };

    private static Dictionary<string, FieldType> Fields(params (string Key, ExprType Type, bool Definite)[] fields) =>
        fields.ToDictionary(f => f.Key, f => new FieldType(f.Type, f.Definite), StringComparer.Ordinal);

    /// <summary>Pinned forms by node id; no field can clear its key unless <see cref="Clearing"/> says so.</summary>
    private static StepContracts Forms(params (string NodeId, Dictionary<string, FieldType> Fields)[] forms) => new(
        forms.ToDictionary(f => f.NodeId, f => new FormContract(f.Fields, new HashSet<string>(StringComparer.Ordinal)), StringComparer.Ordinal),
        new Dictionary<string, SubworkflowContract>(StringComparer.Ordinal));

    /// <summary>The same contracts, where the form of <paramref name="nodeId"/> can clear <paramref name="keys"/> (§6.2).</summary>
    private static StepContracts Clearing(StepContracts contracts, string nodeId, params string[] keys) => contracts with
    {
        Forms = new Dictionary<string, FormContract>(contracts.Forms, StringComparer.Ordinal)
        {
            [nodeId] = contracts.Forms[nodeId] with { Clearable = keys.ToHashSet(StringComparer.Ordinal) },
        },
    };

    private static readonly Dictionary<string, FieldType> Proposta = Fields(("valor", ExprType.Number, true), ("obs", ExprType.Text, false));

    // 1. Presence along paths

    [Fact]
    public void Keys_written_on_every_path_are_definite_and_on_some_paths_optional()
    {
        var document = Document(
            [Start(), HumanGateway("gw"), Task("a"), Task("join"), End()],
            [Flow("start", "gw"), Flow("gw", "a", "true"), Flow("gw", "join", "false"), Flow("a", "join"), Flow("join", "end")]);

        var catalog = DataCatalog.Analyze(document, Forms(("start", Proposta), ("a", Fields(("parecer", ExprType.Text, true)))));

        Assert.Empty(catalog.At("start")!.Keys);
        var atJoin = catalog.At("join")!.Keys;
        Assert.Equal(new KeyState(ExprType.Number, true, ["start"]).Type, atJoin["valor"].Type);
        Assert.True(atJoin["valor"].Definite);
        Assert.False(atJoin["obs"].Definite); // optional field of the form
        Assert.False(atJoin["parecer"].Definite); // only on the "true" branch
        Assert.Equal(["a"], atJoin["parecer"].Sources);
        Assert.True(catalog.At("a")!.Keys["valor"].Definite);
        Assert.False(catalog.At("a")!.Keys.ContainsKey("parecer")); // written when "a" completes, not before
        Assert.True(catalog.AtCompletion.Keys["valor"].Definite);
    }

    [Fact]
    public void A_loop_back_to_start_makes_loop_data_optional_at_the_start()
    {
        var document = Document(
            [Start(), Task("analise"), HumanGateway("ok"), End()],
            [Flow("start", "analise"), Flow("analise", "ok"), Flow("ok", "end", "true"), Flow("ok", "start", "false")]);

        var catalog = DataCatalog.Analyze(document, Forms(("start", Proposta), ("analise", Fields(("parecer", ExprType.Text, true)))));

        var atStart = catalog.At("start")!.Keys;
        Assert.False(atStart["valor"].Definite); // the first arrival has no data
        Assert.False(atStart["parecer"].Definite);
        var atAnalise = catalog.At("analise")!.Keys;
        Assert.True(atAnalise["valor"].Definite);
        Assert.False(atAnalise["parecer"].Definite); // only after a loop
        Assert.True(catalog.At("ok")!.Keys["parecer"].Definite);
    }

    // 2. Last write wins, merging

    [Fact]
    public void A_later_definite_write_replaces_the_type()
    {
        var document = Document([Start(), Task("t1"), Task("t2"), End()], [Flow("start", "t1"), Flow("t1", "t2"), Flow("t2", "end")]);

        var catalog = DataCatalog.Analyze(document, Forms(("start", Fields(("x", ExprType.Number, true))), ("t1", Fields(("x", ExprType.Text, true)))));

        var x = catalog.At("t2")!.Keys["x"];
        Assert.Equal(ExprType.Text, x.Type);
        Assert.Equal(["t1"], x.Sources);
    }

    [Fact]
    public void Conflicting_types_on_different_paths_become_unknown()
    {
        var document = Document(
            [Start(), HumanGateway("gw"), Task("t1"), Task("join"), End()],
            [Flow("start", "gw"), Flow("gw", "t1", "true"), Flow("gw", "join", "false"), Flow("t1", "join"), Flow("join", "end")]);

        var catalog = DataCatalog.Analyze(document, Forms(("start", Fields(("x", ExprType.Number, true))), ("t1", Fields(("x", ExprType.Text, true)))));

        var x = catalog.At("join")!.Keys["x"];
        Assert.Equal(ExprType.Unknown, x.Type);
        Assert.True(x.Definite);
        Assert.Equal(["start", "t1"], x.Sources);
    }

    [Fact]
    public void A_key_definite_on_one_path_and_optional_on_another_is_optional()
    {
        var document = Document(
            [Start(), HumanGateway("gw"), Task("t1"), Task("join"), End()],
            [Flow("start", "gw"), Flow("gw", "t1", "true"), Flow("gw", "join", "false"), Flow("t1", "join"), Flow("join", "end")]);

        var catalog = DataCatalog.Analyze(document, Forms(("start", Fields(("x", ExprType.Number, false))), ("t1", Fields(("x", ExprType.Number, true)))));

        var x = catalog.At("join")!.Keys["x"];
        Assert.False(x.Definite);
        Assert.Equal(ExprType.Number, x.Type);
        Assert.Equal(["start", "t1"], x.Sources);
    }

    [Fact]
    public void An_optional_write_that_cannot_clear_keeps_earlier_presence_and_merges_sources()
    {
        var document = Document([Start(), Task("t1"), Task("t2"), End()], [Flow("start", "t1"), Flow("t1", "t2"), Flow("t2", "end")]);

        // t1's x is optional but can't clear the key: say, required with a visibleWhen (§6.2).
        var catalog = DataCatalog.Analyze(document, Forms(("start", Fields(("x", ExprType.Number, true))), ("t1", Fields(("x", ExprType.Number, false)))));

        var x = catalog.At("t2")!.Keys["x"];
        Assert.True(x.Definite);
        Assert.Equal(ExprType.Number, x.Type);
        Assert.Equal(["start", "t1"], x.Sources);
    }

    [Fact]
    public void A_form_that_can_clear_a_key_makes_it_optional_after_its_step()
    {
        var document = Document([Start(), Task("t1"), Task("t2"), End()], [Flow("start", "t1"), Flow("t1", "t2"), Flow("t2", "end")]);

        // Decision B (#86): an empty answer in t1's optional x removes the key.
        var catalog = DataCatalog.Analyze(document, Clearing(
            Forms(("start", Fields(("x", ExprType.Number, true))), ("t1", Fields(("x", ExprType.Number, false)))), "t1", "x"));

        var x = catalog.At("t2")!.Keys["x"];
        Assert.False(x.Definite);
        Assert.Equal(ExprType.Number, x.Type);
        Assert.Equal(["start", "t1"], x.Sources);
        Assert.True(catalog.At("t1")!.Keys["x"].Definite); // still there when t1 starts
        Assert.False(catalog.AtCompletion.Keys["x"].Definite);
    }

    // 3. WF201

    [Fact]
    public void WF201_rejects_an_ill_typed_automatic_condition()
    {
        var document = Document(
            [Start(), AutoGateway("gw", Compare(Path("valor"), "greaterThan", Literal("text", "abc"))), End()],
            [Flow("start", "gw"), Flow("gw", "end", "true"), Flow("gw", "end", "false")]);

        var catalog = DataCatalog.Analyze(document, Forms(("start", Proposta)));

        var error = Assert.Single(catalog.TypeErrors);
        Assert.Equal("WF201", error.Code);
        Assert.Equal("gw", error.ElementId);
    }

    [Theory]
    [InlineData("valor", "number", "1")] // well typed
    [InlineData("inexistente", "text", "abc")] // TC-1: a key that is never written
    [InlineData("obs", "text", "abc")] // TC-2: optional keys of the right type
    public void WF201_accepts_conditions_that_are_not_definitely_wrong(string key, string type, string value)
    {
        var document = Document(
            [Start(), AutoGateway("gw", Compare(Path(key), key == "obs" ? "equals" : "greaterThan", Literal(type, value))), End()],
            [Flow("start", "gw"), Flow("gw", "end", "true"), Flow("gw", "end", "false")]);

        Assert.Empty(DataCatalog.Analyze(document, Forms(("start", Proposta))).TypeErrors);
    }

    [Fact]
    public void Conditions_that_do_not_parse_are_left_to_WF013()
    {
        var document = Document(
            [Start(), AutoGateway("gw", new JsonObject { ["kind"] = "nonsense" }), End()],
            [Flow("start", "gw"), Flow("gw", "end", "true"), Flow("gw", "end", "false")]);

        Assert.Empty(DataCatalog.Analyze(document, StepContracts.None).TypeErrors);
    }

    // 4. Sub-workflows: WF202, WF203 and outputs

    private static readonly SubworkflowContract Child = new(
        new Dictionary<string, ExprType?>(StringComparer.Ordinal) { ["valor"] = ExprType.Number, ["prazo"] = ExprType.Date, ["calculado"] = null },
        new DataState(new Dictionary<string, KeyState>(StringComparer.Ordinal)
        {
            ["score"] = new(ExprType.Number, true, ["risk"]),
            ["nota"] = new(ExprType.Text, false, ["risk"]),
        }));

    private static DataCatalog AnalyzeSub(JsonObject? inputs, JsonObject? outputs, SubworkflowContract? contract = null)
    {
        var document = Document([Start(), Subprocess("sub", inputs, outputs), Task("after"), End()], [Flow("start", "sub"), Flow("sub", "after"), Flow("after", "end")]);
        var contracts = Forms(("start", Proposta)) with
        {
            Subworkflows = new Dictionary<string, SubworkflowContract>(StringComparer.Ordinal) { ["sub"] = contract ?? Child },
        };
        return DataCatalog.Analyze(document, contracts);
    }

    [Fact]
    public void Inputs_that_fit_the_child_start_form_are_accepted()
    {
        var catalog = AnalyzeSub(new JsonObject
        {
            ["valor"] = Path("valor"),
            ["prazo"] = new JsonObject { ["kind"] = "system", ["name"] = "currentDate" },
            ["calculado"] = Literal("boolean", "true"), // ignored by the child's form
        }, null);

        Assert.Empty(catalog.TypeErrors);
    }

    [Theory]
    [InlineData("valor", "text", "abc")] // a number field
    [InlineData("prazo", "datetime", "2026-10-15T10:00:00Z")] // a date field
    [InlineData("inexistente", "number", "1")] // not a start-form field
    public void WF202_rejects_inputs_the_child_start_form_cannot_take(string key, string type, string value)
    {
        var catalog = AnalyzeSub(new JsonObject { [key] = Literal(type, value) }, null);

        var error = Assert.Single(catalog.TypeErrors);
        Assert.Equal("WF202", error.Code);
        Assert.Equal("sub", error.ElementId);
        Assert.Contains(key, error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void WF202_rejects_ill_typed_input_trees_even_without_a_start_form()
    {
        var bad = new JsonObject { ["kind"] = "arithmetic", ["op"] = "add", ["left"] = Path("obs"), ["right"] = Literal("number", "1") };

        var catalog = AnalyzeSub(new JsonObject { ["qualquer"] = bad, ["outro"] = Literal("text", "ok") }, null, Child with { StartFields = null });

        Assert.Equal("WF202", Assert.Single(catalog.TypeErrors).Code);
    }

    // WF206 (card #69, owner decision A): sub-workflow inputs carry no files.

    private static readonly Dictionary<string, FieldType> Anexos = Fields(
        ("docs", ExprType.ListOf(ExprType.File), true),
        ("dados", ExprType.ObjectOf(Fields(("nome", ExprType.Text, true), ("comprovante", ExprType.ListOf(ExprType.File), false))), true),
        ("socios", ExprType.ListOf(ExprType.ObjectOf(Fields(("doc", ExprType.ListOf(ExprType.File), false)))), false),
        ("valor", ExprType.Number, true));

    private static readonly SubworkflowContract ChildWithFiles = new(
        new Dictionary<string, ExprType?>(StringComparer.Ordinal)
        {
            ["docs"] = ExprType.ListOf(ExprType.File),
            ["dados"] = ExprType.ObjectOf(Fields(("nome", ExprType.Text, true), ("comprovante", ExprType.ListOf(ExprType.File), false))),
            ["valor"] = ExprType.Number,
        },
        DataState.Empty);

    /// <summary>start (<see cref="Anexos"/>) → sub (inputs) → after → end.</summary>
    private static DataCatalog AnalyzeFiles(JsonObject inputs, SubworkflowContract contract)
    {
        var document = Document([Start(), Subprocess("sub", inputs), Task("after"), End()], [Flow("start", "sub"), Flow("sub", "after"), Flow("after", "end")]);
        return DataCatalog.Analyze(document, Forms(("start", Anexos)) with
        {
            Subworkflows = new Dictionary<string, SubworkflowContract>(StringComparer.Ordinal) { ["sub"] = contract },
        });
    }

    [Theory]
    [InlineData("docs", "docs", true)] // list<file> into the child's file field: the case of card #69
    [InlineData("anexos", "docs", false)] // into a child without a start form
    [InlineData("dados", "dados", true)] // an object with a file field
    [InlineData("socios", "socios", false)] // a list of rows with a file field
    [InlineData("arquivos", "socios.[].doc", false)] // list<list<file>>
    public void WF206_rejects_inputs_that_carry_files(string key, string path, bool startForm)
    {
        var catalog = AnalyzeFiles(new JsonObject { [key] = Path(path.Split('.')) }, startForm ? ChildWithFiles : ChildWithFiles with { StartFields = null });

        var error = Assert.Single(catalog.TypeErrors);
        Assert.Equal(("WF206", "sub"), (error.Code, error.ElementId));
        Assert.Contains($"'{key}'", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void WF206_rejects_any_input_into_a_start_form_file_field_instead_of_WF202()
    {
        var catalog = AnalyzeFiles(new JsonObject { ["docs"] = Literal("text", "contrato.pdf") }, ChildWithFiles);

        Assert.Equal(["WF206"], catalog.TypeErrors.Select(e => e.Code));
    }

    [Fact]
    public void WF206_accepts_inputs_that_only_read_from_files_or_are_unknown()
    {
        var count = new JsonObject { ["kind"] = "call", ["function"] = "count", ["args"] = new JsonArray(Path("docs")) };
        var inputs = new JsonObject
        {
            ["quantos"] = count, // a number
            ["nomes"] = Path("docs", "[]", "name"), // list<unknown>: a file has no typed fields
            ["incerto"] = Path("inexistente"), // unknown (TC-1)
            ["nome"] = Path("dados", "nome"),
        };

        Assert.Empty(AnalyzeFiles(inputs, ChildWithFiles with { StartFields = null }).TypeErrors);
        Assert.Empty(AnalyzeFiles(new JsonObject { ["dados"] = Path("inexistente"), ["valor"] = Path("valor") }, ChildWithFiles).TypeErrors);
    }

    // WF207 (card #203): a step maps every field of the child's start form that is certainly required.

    private static readonly SubworkflowContract Requiring = Child with { RequiredStartFields = ["valor", "prazo"] };

    [Fact]
    public void WF207_rejects_a_step_that_leaves_a_required_start_field_unmapped()
    {
        var catalog = AnalyzeSub(new JsonObject { ["valor"] = Path("valor") }, null, Requiring);

        var error = Assert.Single(catalog.TypeErrors);
        Assert.Equal(("WF207", "sub"), (error.Code, error.ElementId));
        Assert.Contains("'prazo'", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void WF207_reports_each_unmapped_field_in_form_order_also_without_inputs()
    {
        var catalog = AnalyzeSub(null, null, Requiring);

        Assert.Collection(
            catalog.TypeErrors,
            error => Assert.Equal(("WF207", true), (error.Code, error.Message.Contains("'valor'", StringComparison.Ordinal))),
            error => Assert.Equal(("WF207", true), (error.Code, error.Message.Contains("'prazo'", StringComparison.Ordinal))));
    }

    [Fact]
    public void WF207_says_a_required_file_field_can_never_be_filled()
    {
        var catalog = AnalyzeFiles(new JsonObject { ["valor"] = Path("valor") }, ChildWithFiles with { RequiredStartFields = ["docs"] });

        var error = Assert.Single(catalog.TypeErrors);
        Assert.Equal("WF207", error.Code);
        Assert.Contains("can't receive files", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void WF207_accepts_mapped_fields_and_children_without_a_start_form()
    {
        var mapped = new JsonObject { ["valor"] = Path("valor"), ["prazo"] = new JsonObject { ["kind"] = "system", ["name"] = "currentDate" } };

        Assert.Empty(AnalyzeSub(mapped, null, Requiring).TypeErrors);
        Assert.Empty(AnalyzeSub(null, null, Requiring with { StartFields = null }).TypeErrors); // takes any keys (TC-5)
    }

    [Fact]
    public void WF203_rejects_outputs_ill_typed_over_the_child_catalog()
    {
        var bad = new JsonObject { ["kind"] = "arithmetic", ["op"] = "multiply", ["left"] = Path("nota"), ["right"] = Literal("number", "2") };

        var catalog = AnalyzeSub(null, new JsonObject { ["limite"] = bad });

        var error = Assert.Single(catalog.TypeErrors);
        Assert.Equal("WF203", error.Code);
        Assert.Equal("sub", error.ElementId);
    }

    [Fact]
    public void Outputs_are_typed_over_the_child_catalog_and_written_to_the_parent()
    {
        var catalog = AnalyzeSub(null, new JsonObject
        {
            ["score"] = Path("score"),
            ["limite"] = new JsonObject { ["kind"] = "arithmetic", ["op"] = "multiply", ["left"] = Path("score"), ["right"] = Literal("number", "2") },
            ["nota"] = Path("nota"),
            ["fixo"] = Literal("text", "x"),
            ["entrada"] = Path("valor"), // TC-5: not in the child's own catalog
        });

        var after = catalog.At("after")!.Keys;
        Assert.Empty(catalog.TypeErrors);
        Assert.True(after["score"].Definite); // a path to a definite child key
        Assert.False(after["limite"].Definite); // arithmetic may yield missing
        Assert.False(after["nota"].Definite);
        Assert.True(after["fixo"].Definite); // a literal
        Assert.False(after["entrada"].Definite);
        Assert.Equal(ExprType.Number, after["score"].Type);
        Assert.Equal(ExprType.Number, after["limite"].Type);
        Assert.Equal(ExprType.Text, after["nota"].Type);
        Assert.Equal(ExprType.Unknown, after["entrada"].Type);
        Assert.Equal(["sub"], after["score"].Sources);
        Assert.False(catalog.At("sub")!.Keys.ContainsKey("score"));
    }

    [Fact]
    public void An_output_of_a_child_key_that_a_later_child_step_can_clear_is_optional()
    {
        var child = Document([Start(), Task("revisar"), End()], [Flow("start", "revisar"), Flow("revisar", "end")]);
        var completion = DataCatalog.Analyze(child, Clearing(
            Forms(("start", Fields(("valor", ExprType.Number, true))), ("revisar", Fields(("valor", ExprType.Number, false)))), "revisar", "valor")).AtCompletion;

        var catalog = AnalyzeSub(null, new JsonObject { ["revisado"] = Path("valor") }, new SubworkflowContract(null, completion));

        Assert.False(catalog.At("after")!.Keys["revisado"].Definite); // the child's valor may be gone when it completes
        Assert.Equal(ExprType.Number, catalog.At("after")!.Keys["revisado"].Type);
    }

    [Fact]
    public void Outputs_of_an_unresolved_child_are_unknown_and_optional()
    {
        var document = Document([Start(), Subprocess("sub", null, new JsonObject { ["r"] = Path("x") }), End()], [Flow("start", "sub"), Flow("sub", "end")]);

        var r = DataCatalog.Analyze(document, StepContracts.None).AtCompletion.Keys["r"];

        Assert.Equal(ExprType.Unknown, r.Type);
        Assert.False(r.Definite);
    }

    // 5. Entries and robustness

    [Fact]
    public void Entries_flatten_objects_and_lists_with_presence()
    {
        var row = ExprType.ObjectOf(Fields(("nome", ExprType.Text, true)));
        var state = new DataState(new Dictionary<string, KeyState>(StringComparer.Ordinal)
        {
            ["valor"] = new(ExprType.Number, true, ["start"]),
            ["endereco"] = new(ExprType.ObjectOf(Fields(("cep", ExprType.Text, true), ("numero", ExprType.Text, false))), true, ["start"]),
            ["socios"] = new(ExprType.ListOf(row), false, ["t1"]),
        });

        var entries = DataCatalog.Entries(state);

        Assert.Equal(
            ["endereco", "endereco.cep", "endereco.numero", "socios", "socios.[].nome", "valor"],
            entries.Select(e => string.Join('.', e.Path)));
        Assert.Equal(["object", "text", "text", "list<object>", "list<text>", "number"], entries.Select(e => e.Type));
        Assert.Equal([true, true, false, false, false, true], entries.Select(e => e.Definite));
        Assert.Equal(["t1"], entries.Single(e => e.Path[0] == "socios" && e.Path.Count == 3).Sources);
    }

    [Fact]
    public void State_as_type_carries_types_and_presence()
    {
        var type = new DataState(new Dictionary<string, KeyState>(StringComparer.Ordinal) { ["v"] = new(ExprType.Number, false, ["s"]) }).AsType();

        Assert.Equal(TypeKind.Record, type.Kind);
        Assert.Equal(new FieldType(ExprType.Number, false), type.Fields["v"]);
    }

    [Fact]
    public void Broken_structure_does_not_break_the_analysis()
    {
        var document = Document(
            [Start("s1"), Start("s2"), Task("t"), HumanGateway("orphan")],
            [Flow("s1", "t"), Flow("t", "missing"), Flow("s2", "t"), Flow("t", "s1")]);

        var catalog = DataCatalog.Analyze(document, Forms(("t", Fields(("x", ExprType.Number, true)))));

        Assert.NotNull(catalog.At("t"));
        Assert.Null(catalog.At("orphan"));
        Assert.Empty(catalog.AtCompletion.Keys); // no end node
    }

    // 6. Writers: the keys an admin correction may set (workflow-engine.md §16.3)

    [Fact]
    public void Writers_list_each_reachable_step_that_can_write_a_key_with_its_type_in_document_order()
    {
        var document = Document(
            [Start(), Task("a"), Task("b"), Task("orphan"), End()],
            [Flow("start", "a"), Flow("a", "b"), Flow("b", "start"), Flow("b", "end")]);

        var catalog = DataCatalog.Analyze(document, Forms(
            ("start", Proposta),
            ("a", Fields(("valor", ExprType.Text, false))),
            ("b", Fields(("parecer", ExprType.Text, true))),
            ("orphan", Fields(("nunca", ExprType.Number, true)))));

        Assert.Equal(new[] { ("start", ExprType.Number), ("a", ExprType.Text) }, catalog.Writers["valor"].Select(w => (w.NodeId, w.Type)));
        Assert.Equal(["start"], catalog.Writers["obs"].Select(w => w.NodeId));
        Assert.Equal(["b"], catalog.Writers["parecer"].Select(w => w.NodeId));
        Assert.False(catalog.Writers.ContainsKey("nunca")); // an unreachable step never writes
    }

    [Fact]
    public void Sub_workflow_outputs_are_writers_with_their_inferred_type()
    {
        var catalog = AnalyzeSub(null, new JsonObject { ["risco"] = Path("score"), ["texto"] = Path("desconhecida") });

        Assert.Equal(new[] { ("sub", ExprType.Number) }, catalog.Writers["risco"].Select(w => (w.NodeId, w.Type)));
        Assert.Equal(new[] { ("sub", ExprType.Unknown) }, catalog.Writers["texto"].Select(w => (w.NodeId, w.Type)));
    }

    // 7. Automation steps: WF204, WF205 and outputs (card #76, AU-5)

    private static JsonObject Automation(string id, JsonObject? inputs = null, JsonObject? outputs = null) => new()
    {
        ["id"] = id, ["type"] = "task", ["taskKind"] = "automation", ["label"] = id,
        ["automation"] = new JsonObject { ["automationId"] = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", ["inputs"] = inputs, ["outputs"] = outputs },
    };

    private static readonly Dictionary<string, FieldType> Pedido = Fields(
        ("valor", ExprType.Number, true), ("obs", ExprType.Text, false), ("vencimento", ExprType.Date, true),
        ("endereco", ExprType.ObjectOf(Fields(("cep", ExprType.Text, true))), true), ("anexos", ExprType.ListOf(ExprType.File), false));

    /// <summary>Version 3 of the step's automation, as the catalog types it.</summary>
    private static readonly AutomationContract Consulta = new(
        3,
        new Dictionary<string, ExprType>(StringComparer.Ordinal)
        {
            ["cpf"] = ExprType.Text, ["valor"] = ExprType.Number, ["prazo"] = ExprType.Date, ["dados"] = ExprType.ObjectOf(Fields()),
            ["anexos"] = ExprType.ListOf(ExprType.ObjectOf(Fields())), ["extra"] = ExprType.Unknown,
        },
        Fields(
            ("situacao", ExprType.Text, true), // a required output
            ("score", ExprType.Number, false), // an optional one
            ("httpStatus", ExprType.Number, true), // the status
            ("endereco", ExprType.ObjectOf(Fields()), true)));

    /// <summary>start (Pedido) → cpf (the automation step) → after → end.</summary>
    private static DataCatalog AnalyzeAutomation(JsonObject? inputs, JsonObject? outputs)
    {
        var document = Document([Start(), Automation("cpf", inputs, outputs), Task("after"), End()], [Flow("start", "cpf"), Flow("cpf", "after"), Flow("after", "end")]);
        var contracts = Forms(("start", Pedido)) with
        {
            Automations = new Dictionary<string, AutomationContract>(StringComparer.Ordinal) { ["cpf"] = Consulta },
        };
        return DataCatalog.Analyze(document, contracts);
    }

    [Fact]
    public void Automation_outputs_are_typed_over_the_output_object_and_written_when_the_result_is_applied()
    {
        var catalog = AnalyzeAutomation(null, new JsonObject
        {
            ["situacao_cpf"] = Path("situacao"),
            ["pontos"] = Path("score"),
            ["codigo"] = Path("httpStatus"),
            ["cep"] = Path("endereco", "cep"), // TC-1: an object output declares no fields
            ["canal"] = Literal("text", "web"),
        });

        var after = catalog.At("after")!.Keys;
        Assert.Empty(catalog.TypeErrors);
        Assert.Equal((ExprType.Text, true), (after["situacao_cpf"].Type, after["situacao_cpf"].Definite)); // a required output
        Assert.Equal((ExprType.Number, false), (after["pontos"].Type, after["pontos"].Definite)); // an optional one
        Assert.Equal((ExprType.Number, true), (after["codigo"].Type, after["codigo"].Definite)); // the status
        Assert.Equal((ExprType.Unknown, false), (after["cep"].Type, after["cep"].Definite));
        Assert.Equal((ExprType.Text, true), (after["canal"].Type, after["canal"].Definite)); // a literal
        Assert.Equal(["cpf"], after["situacao_cpf"].Sources);
        Assert.False(catalog.At("cpf")!.Keys.ContainsKey("situacao_cpf"));
        Assert.Equal(new[] { ("cpf", ExprType.Text) }, catalog.Writers["situacao_cpf"].Select(w => (w.NodeId, w.Type)));
    }

    [Fact]
    public void Outputs_of_an_unresolved_automation_are_optional_over_an_unknown_output_object()
    {
        var document = Document(
            [Start(), Automation("cpf", outputs: new JsonObject { ["situacao"] = Path("situacao"), ["canal"] = Literal("text", "web") }), End()],
            [Flow("start", "cpf"), Flow("cpf", "end")]);

        var catalog = DataCatalog.Analyze(document, StepContracts.None);

        var situacao = catalog.AtCompletion.Keys["situacao"];
        var canal = catalog.AtCompletion.Keys["canal"];
        Assert.Equal((ExprType.Unknown, false), (situacao.Type, situacao.Definite));
        Assert.Equal((ExprType.Text, false), (canal.Type, canal.Definite));
        Assert.Empty(catalog.TypeErrors);
    }

    [Theory]
    [InlineData("cpf", "valor")] // text takes no number
    [InlineData("valor", "obs")] // a number takes no text
    [InlineData("dados", "anexos")] // an object takes no list
    [InlineData("anexos", "endereco")] // a list takes no object
    public void WF204_rejects_an_input_the_automation_cannot_take(string key, string path)
    {
        var catalog = AnalyzeAutomation(new JsonObject { [key] = Path(path) }, null);

        var error = Assert.Single(catalog.TypeErrors);
        Assert.Equal(("WF204", "cpf"), (error.Code, error.ElementId));
        Assert.StartsWith($"Input '{key}': automation version 3 takes ", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void WF204_names_the_declared_type_and_the_given_one()
    {
        var datetime = new JsonObject { ["kind"] = "system", ["name"] = "currentDateTime" };

        var catalog = AnalyzeAutomation(new JsonObject { ["prazo"] = datetime }, null);

        Assert.Equal("Input 'prazo': automation version 3 takes date, not datetime.", Assert.Single(catalog.TypeErrors).Message);
    }

    [Theory]
    [InlineData("cpf", "vencimento")] // a date is sent as ISO text
    [InlineData("prazo", "obs")] // TC-4: text may stand for a date
    [InlineData("valor", "inexistente")] // TC-1: a key that is never written
    [InlineData("dados", "endereco")]
    [InlineData("anexos", "anexos")] // each file is sent as an object
    [InlineData("extra", "anexos")] // unknown takes anything
    [InlineData("naoDeclarada", "valor")] // WF110's, not WF204's
    public void WF204_accepts_inputs_that_are_not_definitely_wrong(string key, string path)
    {
        Assert.Empty(AnalyzeAutomation(new JsonObject { [key] = Path(path) }, null).TypeErrors);
    }

    [Fact]
    public void WF204_rejects_ill_typed_input_trees_even_when_the_automation_does_not_resolve()
    {
        var bad = new JsonObject { ["kind"] = "arithmetic", ["op"] = "add", ["left"] = Path("obs"), ["right"] = Literal("number", "1") };
        var document = Document([Start(), Automation("cpf", new JsonObject { ["cpf"] = bad }), End()], [Flow("start", "cpf"), Flow("cpf", "end")]);

        var catalog = DataCatalog.Analyze(document, Forms(("start", Pedido)));

        var error = Assert.Single(catalog.TypeErrors);
        Assert.Equal(("WF204", "cpf"), (error.Code, error.ElementId));
    }

    [Fact]
    public void WF205_rejects_outputs_ill_typed_over_the_output_object()
    {
        var bad = new JsonObject { ["kind"] = "arithmetic", ["op"] = "multiply", ["left"] = Path("situacao"), ["right"] = Literal("number", "2") };

        var catalog = AnalyzeAutomation(null, new JsonObject { ["dobro"] = bad, ["pontos"] = Path("score") });

        var error = Assert.Single(catalog.TypeErrors);
        Assert.Equal(("WF205", "cpf"), (error.Code, error.ElementId));
        Assert.StartsWith("Output 'dobro': ", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Automation_trees_that_do_not_parse_are_left_to_WF109()
    {
        var notAValue = Compare(Literal("text", "a"), "greaterThan", Literal("number", "1"));

        var catalog = AnalyzeAutomation(new JsonObject { ["cpf"] = notAValue }, new JsonObject { ["x"] = notAValue.DeepClone() });

        Assert.Empty(catalog.TypeErrors);
        Assert.False(catalog.At("after")!.Keys.ContainsKey("x"));
    }
}
