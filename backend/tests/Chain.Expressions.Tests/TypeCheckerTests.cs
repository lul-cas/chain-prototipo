using System.Text.Json;

namespace Chain.Expressions.Tests;

/// <summary>Publish-time type rules (workflow-definition.md §6.4).</summary>
public sealed class TypeCheckerTests
{
    private static readonly ExprType Data = ExprType.ObjectOf(new Dictionary<string, FieldType>
    {
        ["valor"] = new(ExprType.Number, true),
        ["nome"] = new(ExprType.Text, true),
        ["aprovado"] = new(ExprType.Boolean, false),
        ["vencimento"] = new(ExprType.Date, true),
        ["emitido"] = new(ExprType.DateTime, false),
        ["hora"] = new(ExprType.Time, false),
        ["garantias"] = new(ExprType.ListOf(ExprType.Text), false),
        ["itens"] = new(ExprType.ListOf(ExprType.ObjectOf(new Dictionary<string, FieldType> { ["valor"] = new(ExprType.Number, true) })), false),
        ["cliente"] = new(ExprType.ObjectOf(new Dictionary<string, FieldType> { ["cpf"] = new(ExprType.Text, true) }), true),
        ["misto"] = new(ExprType.Unknown, false),
    });

    // Value builders (expression-language.md §5.1).
    private static string P(params string[] path) => $$"""{ "kind": "path", "path": [{{string.Join(", ", path.Select(s => $"\"{s}\""))}}] }""";

    private static string POff(string key, int amount, string unit) => $$"""{ "kind": "path", "path": ["{{key}}"], "offset": { "amount": {{amount}}, "unit": "{{unit}}" } }""";

    private static string L(string type, string value) => $$"""{ "kind": "literal", "type": "{{type}}", "value": "{{value}}" }""";

    private static string N(string value) => L("number", value);

    private static string T(string value) => L("text", value);

    private static string S(string name) => $$"""{ "kind": "system", "name": "{{name}}" }""";

    private static string Call(string function, params string[] args) => $$"""{ "kind": "call", "function": "{{function}}", "args": [{{string.Join(", ", args)}}] }""";

    private static string Arith(string op, string left, string right) => $$"""{ "kind": "arithmetic", "op": "{{op}}", "left": {{left}}, "right": {{right}} }""";

    private static string Cmp(string left, string op, string? right = null) =>
        right is null
            ? $$"""{ "kind": "compare", "left": {{left}}, "operator": "{{op}}" }"""
            : $$"""{ "kind": "compare", "left": {{left}}, "operator": "{{op}}", "right": {{right}} }""";

    private static string And(params string[] items) => $$"""{ "kind": "group", "op": "and", "items": [{{string.Join(", ", items)}}] }""";

    private static IReadOnlyList<TypeIssue> Check(string condition)
    {
        using var json = JsonDocument.Parse(condition);
        var parsed = ExpressionParser.ParseCondition(json.RootElement);
        Assert.True(parsed.IsSuccess, parsed.Error?.Message);
        return TypeChecker.Check(parsed.Condition!, Data);
    }

    private static ExprType Infer(string value, List<TypeIssue>? issues = null)
    {
        using var json = JsonDocument.Parse(value);
        var parsed = ExpressionParser.ParseValue(json.RootElement);
        Assert.True(parsed.IsSuccess, parsed.Error?.Message);
        return TypeChecker.Infer(parsed.Value!, Data, issues ?? []);
    }

    public static TheoryData<string, string> WellTyped => new()
    {
        { "number > number", Cmp(P("valor"), "greaterThan", N("30000")) },
        { "date >= currentDate", Cmp(P("vencimento"), "greaterOrEqual", S("currentDate")) },
        { "date >= currentDate - 30 days", Cmp(P("vencimento"), "greaterOrEqual", S("currentDate").Replace(" }", ", \"offset\": { \"amount\": -30, \"unit\": \"days\" } }", StringComparison.Ordinal)) },
        { "datetime < currentDateTime", Cmp(P("emitido"), "lessThan", S("currentDateTime")) },
        { "time > time literal", Cmp(P("hora"), "greaterThan", L("time", "10:00")) },
        { "text equals text", Cmp(P("nome"), "equals", T("Ana")) },
        { "boolean equals boolean", Cmp(P("aprovado"), "equals", L("boolean", "true")) },
        { "text contains text", Cmp(P("nome"), "contains", T("A")) },
        { "list<text> contains text", Cmp(P("garantias"), "contains", T("pf")) },
        { "nested object field", Cmp(P("cliente", "cpf"), "equals", T("52998224725")) },
        { "unknown key (TC-1)", Cmp(P("inexistente"), "greaterThan", T("abc")) },
        { "unknown field of an object (TC-1)", Cmp(P("cliente", "rg"), "greaterThan", N("1")) },
        { "unknown-typed key", Cmp(P("misto"), "greaterThan", N("1")) },
        { "date equals text (TC-4)", Cmp(P("vencimento"), "equals", T("2026-10-15")) },
        { "text vs currentDate (TC-4)", Cmp(P("nome"), "lessThan", S("currentDate")) },
        { "isEmpty on a list", Cmp(P("itens"), "isEmpty") },
        { "isNotEmpty on an object", Cmp(P("cliente"), "isNotEmpty") },
        { "sum of a projection", Cmp(Call("sum", P("itens", "[]", "valor")), "greaterThan", N("10")) },
        { "count of a list", Cmp(Call("count", P("garantias")), "greaterThan", N("0")) },
        { "max of several numbers", Cmp(Call("max", P("valor"), N("1")), "greaterThan", N("0")) },
        { "round with places", Cmp(Call("round", P("valor"), N("2")), "equals", N("1")) },
        { "arithmetic", Cmp(Arith("multiply", P("valor"), N("2")), "greaterThan", N("1")) },
        { "date of a datetime", Cmp(Call("date", P("emitido")), "equals", S("currentDate")) },
        { "string of a number", Cmp(Call("string", P("valor")), "equals", T("1")) },
        { "number of text", Cmp(Call("number", P("nome")), "greaterThan", N("1")) },
        { "datetime of date and time", Cmp(Call("datetime", P("vencimento"), P("hora")), "lessThan", S("currentDateTime")) },
        { "date path with a month offset", Cmp(POff("vencimento", 1, "months"), "greaterThan", S("currentDate")) },
        { "abs of unknown", Cmp(Call("abs", P("inexistente")), "greaterThan", N("1")) },
    };

    [Theory]
    [MemberData(nameof(WellTyped))]
    public void Well_typed_conditions_have_no_issues(string name, string condition)
    {
        Assert.True(Check(condition).Count == 0, $"{name}: {string.Join("; ", Check(condition).Select(i => i.Message))}");
    }

    public static TheoryData<string, string> IllTyped => new()
    {
        { "number > text", Cmp(P("valor"), "greaterThan", T("abc")) },
        { "date vs currentDateTime", Cmp(P("vencimento"), "greaterOrEqual", S("currentDateTime")) },
        { "date vs time", Cmp(P("vencimento"), "equals", P("hora")) },
        { "ordering text", Cmp(P("nome"), "greaterThan", T("a")) },
        { "ordering booleans", Cmp(P("aprovado"), "greaterThan", L("boolean", "true")) },
        { "number equals boolean", Cmp(P("valor"), "equals", L("boolean", "true")) },
        { "list equals", Cmp(P("garantias"), "equals", T("pf")) },
        { "object equals", Cmp(P("cliente"), "notEquals", T("x")) },
        { "list<text> contains number", Cmp(P("garantias"), "contains", N("1")) },
        { "number contains", Cmp(P("valor"), "contains", N("1")) },
        { "date contains text", Cmp(P("vencimento"), "contains", T("2026")) },
        { "sum of list<text>", Cmp(Call("sum", P("garantias")), "greaterThan", N("1")) },
        { "max of number and text", Cmp(Call("max", P("valor"), P("nome")), "greaterThan", N("1")) },
        { "count of a number", Cmp(Call("count", P("valor")), "greaterThan", N("1")) },
        { "abs of text", Cmp(Call("abs", P("nome")), "greaterThan", N("1")) },
        { "round places as text", Cmp(Call("round", P("valor"), T("2")), "greaterThan", N("1")) },
        { "string of a list", Cmp(Call("string", P("garantias")), "equals", T("x")) },
        { "number of a boolean", Cmp(Call("number", P("aprovado")), "equals", N("1")) },
        { "number of a date", Cmp(Call("number", P("vencimento")), "equals", N("1")) },
        { "date of a number", Cmp(Call("date", P("valor")), "equals", S("currentDate")) },
        { "time of a date", Cmp(Call("time", P("vencimento")), "equals", L("time", "10:00")) },
        { "datetime of a date", Cmp(Call("datetime", P("vencimento")), "equals", S("currentDateTime")) },
        { "datetime of number and time", Cmp(Call("datetime", P("valor"), P("hora")), "equals", S("currentDateTime")) },
        { "arithmetic on text", Cmp(Arith("add", P("valor"), P("nome")), "greaterThan", N("1")) },
        { "number result vs date", Cmp(Call("sum", P("itens", "[]", "valor")), "greaterThan", S("currentDate")) },
        { "offset on a number", Cmp(POff("valor", 1, "days"), "greaterThan", N("1")) },
        { "date moved by hours", Cmp(POff("vencimento", 1, "hours"), "greaterThan", S("currentDate")) },
        { "error inside a group", And(Cmp(P("valor"), "greaterThan", N("1")), Cmp(P("nome"), "lessThan", N("1"))) },
    };

    [Theory]
    [MemberData(nameof(IllTyped))]
    public void Definitely_ill_typed_conditions_are_reported(string name, string condition)
    {
        Assert.True(Check(condition).Count > 0, $"{name}: expected a type issue");
    }

    [Fact]
    public void Every_problem_is_reported()
    {
        var issues = Check(And(Cmp(P("valor"), "greaterThan", T("a")), Cmp(P("nome"), "lessThan", T("b"))));

        Assert.Equal(2, issues.Count);
        Assert.Contains("greaterThan", issues[0].Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Infers_the_types_of_values()
    {
        Assert.Equal(ExprType.Number, Infer(Call("sum", P("itens", "[]", "valor"))));
        Assert.Equal(ExprType.ListOf(ExprType.Number), Infer(P("itens", "[]", "valor")));
        Assert.Equal(ExprType.Text, Infer(P("cliente", "cpf")));
        Assert.Equal(ExprType.Date, Infer(POff("vencimento", 1, "days")));
        Assert.Equal(ExprType.Date, Infer(S("currentDate")));
        Assert.Equal(ExprType.DateTime, Infer(Call("datetime", T("2026-10-15T10:00:00Z"))));
        Assert.Equal(ExprType.Text, Infer(Call("string", P("valor"))));
        Assert.Equal(ExprType.Number, Infer(Arith("divide", P("inexistente"), N("2"))));
        Assert.Equal(ExprType.Unknown, Infer(P("inexistente")));
        Assert.Equal(ExprType.Unknown, Infer(P("valor", "x")));
        Assert.Equal(ExprType.Unknown, Infer(P("nome", "[]")));
        Assert.Equal(ExprType.Boolean, Infer(L("boolean", "false")));
    }

    [Fact]
    public void Infer_reports_issues_in_value_trees()
    {
        var issues = new List<TypeIssue>();

        Assert.Equal(ExprType.Number, Infer(Arith("add", P("nome"), N("1")), issues));
        Assert.Single(issues);
    }

    [Fact]
    public void Merging_types_follows_the_catalog_rules()
    {
        var a = ExprType.ObjectOf(new Dictionary<string, FieldType> { ["x"] = new(ExprType.Text, true), ["y"] = new(ExprType.Number, true) });
        var b = ExprType.ObjectOf(new Dictionary<string, FieldType> { ["x"] = new(ExprType.Number, true) });

        var merged = ExprType.Merge(a, b);

        Assert.Equal(ExprType.Unknown, merged.Fields["x"].Type);
        Assert.True(merged.Fields["x"].Definite);
        Assert.False(merged.Fields["y"].Definite);
        Assert.Equal(ExprType.Text, ExprType.Merge(ExprType.Text, ExprType.Text));
        Assert.Equal(ExprType.Unknown, ExprType.Merge(ExprType.Text, ExprType.Date));
        Assert.Equal(ExprType.ListOf(ExprType.Unknown), ExprType.Merge(ExprType.ListOf(ExprType.Text), ExprType.ListOf(ExprType.Number)));
        Assert.Equal("list<datetime>", ExprType.ListOf(ExprType.DateTime).ToString());
    }
}
