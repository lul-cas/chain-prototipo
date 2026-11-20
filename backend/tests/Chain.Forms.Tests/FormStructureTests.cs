using System.Text.Json.Nodes;
using static Chain.Forms.Tests.SampleForm;

namespace Chain.Forms.Tests;

/// <summary>Parsing (FM000) and structural rules FM001–FM007 (forms.md §F1).</summary>
public sealed class FormStructureTests
{
    [Fact]
    public void Sample_form_parses_and_is_valid()
    {
        Assert.Empty(FormValidator.Validate(Parse(Create())));
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("""{"schemaVersion":2,"components":[]}""")]
    [InlineData("""{"schemaVersion":1,"components":[{"type":"signature","key":"x"}]}""")]
    [InlineData("""{"schemaVersion":1,"components":[{"type":"text","key":"x","onChange":"alert(1)"}]}""")]
    [InlineData("""{"schemaVersion":1}""")]
    [InlineData("""null""")] // a draft body without "document" (#93)
    [InlineData("""{"schemaVersion":1,"components":[{"type":"text","key":"x","label":"a\u0000b"}]}""")] // NUL: jsonb cannot store it (#93)
    [InlineData("""{"schemaVersion":1,"components":[{"type":"text","key":"x","label":"\\\u0000"}]}""")]
    [InlineData("""{"schemaVersion":1,"components":[{"type":"text","key":"x","visibleWhen":{"kind":"compare","left":{"kind":"path","path":["y"]},"operator":"equals","right":{"kind":"literal","type":"text","value":"\u0000"}}}]}""")]
    [InlineData("""{"schemaVersion":1,"components":[{"type":"text","key":"x","visibleWhen":{"kind":"compare","left":{"kind":"path","path":["y"]},"operator":"equals","right":{"kind":"literal","type":"text","value":"\ud800"}}}]}""")] // an unpaired surrogate: not Unicode (#129)
    [InlineData("""{"schemaVersion":1,"components":[{"type":"text","key":"x","requiredWhen":{"kind":"compare","left":{"kind":"path","path":["y\udc00"]},"operator":"isEmpty"}}]}""")]
    [InlineData("""{"schemaVersion":1,"components":[{"type":"text","key":"x","label":"\ud83d\ud83d"}]}""")]
    public void FM000_malformed_documents_are_rejected(string json)
    {
        var result = FormDocumentParser.Parse(json);

        Assert.False(result.IsSuccess);
        Assert.Equal("FM000", result.Error!.Code);
    }

    [Fact]
    public void FM000_an_escaped_backslash_before_u0000_is_text_not_NUL()
    {
        var result = FormDocumentParser.Parse("""{"schemaVersion":1,"components":[{"type":"text","key":"x","label":"\\u0000"}]}""");

        Assert.True(result.IsSuccess, result.Error?.Message);
        Assert.Equal("\\u0000", result.Document!.Components[0].Label);
    }

    [Fact]
    public void FM000_an_escaped_surrogate_pair_is_text()
    {
        var result = FormDocumentParser.Parse("""{"schemaVersion":1,"components":[{"type":"text","key":"x","label":"Nota 😀","visibleWhen":{"kind":"compare","left":{"kind":"path","path":["y"]},"operator":"equals","right":{"kind":"literal","type":"text","value":"😀"}}}]}""");

        Assert.True(result.IsSuccess, result.Error?.Message);
        Assert.Equal("Nota 😀", result.Document!.Components[0].Label);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("1abc")]
    [InlineData("com espaço")]
    [InlineData("valor\n")] // accepted before #81: in .NET, $ also matches before a final newline
    public void FM001_value_fields_need_a_valid_key(string? key)
    {
        var form = Create();
        var field = Component(form, "nome");
        if (key is null)
        {
            field.Remove("key");
        }
        else
        {
            field["key"] = key;
        }

        AssertIssue(form, "FM001");
    }

    // FM011 (form-designer.md FD16): every component that produces a value has a label with something besides whitespace.
    [Theory]
    [InlineData("nome", null)]
    [InlineData("nome", "")]
    [InlineData("nome", "   ")]
    [InlineData("nome", "\u0085")] // whitespace in .NET; the designer's local check reads it the same way (#124)
    [InlineData("endereco", null)] // a group
    [InlineData("socios", "")]     // a list
    [InlineData("parcela", "\t")] // a computed field
    public void FM011_value_fields_need_a_label(string key, string? label)
    {
        var form = Create();
        var field = Component(form, key);
        if (label is null)
        {
            field.Remove("label");
        }
        else
        {
            field["label"] = label;
        }

        AssertIssue(form, "FM011", key);
    }

    [Fact]
    public void FM011_display_components_need_no_label()
    {
        var form = Create();
        form["components"]!.AsArray().Add(new JsonObject { ["type"] = "heading", ["text"] = "Dados" });
        form["components"]!.AsArray().Add(new JsonObject { ["type"] = "separator" });

        Assert.Empty(FormValidator.Validate(Parse(form)));
    }

    // FM012: help text (owner decision Q-FD3 (a), card #234)

    [Fact]
    public void FM012_a_field_may_have_a_description_of_up_to_500_characters()
    {
        var form = Create();
        Component(form, "codigo")["description"] = new string('d', 500);
        Component(form, "nome")["description"] = "Como no documento.";

        var parsed = Parse(form);

        Assert.Empty(FormValidator.Validate(parsed));
        Assert.Equal("Como no documento.", parsed.Components.Single(c => c.Key == "nome").Description);
    }

    [Fact]
    public void FM012_a_longer_description_or_one_on_a_display_component_is_refused()
    {
        var form = Create();
        Component(form, "codigo")["description"] = new string('d', 501);
        form["components"]!.AsArray().Add(new JsonObject { ["type"] = "heading", ["text"] = "Dados", ["description"] = "x" });

        var issues = FormValidator.Validate(Parse(form));

        Assert.Equal(["codigo", "components[" + (form["components"]!.AsArray().Count - 1) + "]"], issues.Where(i => i.Code == "FM012").Select(i => i.Path));
    }

    [Fact]
    public void FM002_keys_are_unique_per_level_but_may_repeat_in_nested_levels()
    {
        Assert.Empty(FormValidator.Validate(Parse(Create()))); // "nome" exists at the root and inside "socios"

        var form = Create();
        Component(form, "observacao")["key"] = "nome";
        AssertIssue(form, "FM002", "nome");
    }

    [Fact]
    public void FM003_choice_fields_need_unique_options()
    {
        var form = Create();
        Component(form, "modalidade")["options"]!.AsArray().Add(new JsonObject { ["value"] = "pf", ["label"] = "Duplicada" });
        AssertIssue(form, "FM003", "modalidade");

        var empty = Create();
        Component(empty, "garantias")["options"] = new JsonArray();
        AssertIssue(empty, "FM003", "garantias");
    }

    [Theory]
    [InlineData("valor", "min", 60000)]           // min > max
    [InlineData("nome", "minLength", -1)]
    [InlineData("valor", "decimalDigits", 11)]
    [InlineData("cpf", "format", "passport")]
    [InlineData("nome", "min", 3)]                 // number option on a text field
    [InlineData("vencimento", "min", "15/10/2026")] // not an ISO date
    public void FM004_validation_options_must_fit_the_type(string key, string option, object value)
    {
        var form = Create();
        Component(form, key)["validate"]![option] = JsonValue.Create(value);

        AssertIssue(form, "FM004", key);
    }

    // #238: a draft is untrusted input, and a bound of the wrong JSON kind is FM004, not an exception.
    [Theory]
    [InlineData("valor", "min", "\"1000\"")] // a number field's bound as text
    [InlineData("valor", "max", "true")]
    [InlineData("vencimento", "min", """{"system":"currentDate","offset":{"amount":"1","unit":"days"}}""")]
    [InlineData("vencimento", "min", """{"system":"currentDate","offset":{"amount":1,"unit":5}}""")]
    [InlineData("vencimento", "max", """{"system":"currentDate","offset":{"amount":1.5,"unit":"days"}}""")]
    [InlineData("vencimento", "max", "[]")]
    [InlineData("vencimento", "max", """{"system":"currentDate","offset":{"amount":-2147483648,"unit":"days"}}""")] // Math.Abs would overflow
    public void FM004_bounds_of_the_wrong_json_kind_are_problems(string key, string option, string json)
    {
        var form = Create();
        Component(form, key)["validate"]![option] = JsonNode.Parse(json);

        AssertIssue(form, "FM004", key);
    }

    [Theory]
    [InlineData("(a)\\1")]       // backreference
    [InlineData("(?<=a)b")]     // lookbehind
    [InlineData("(?i)abc")]     // inline modifier
    [InlineData("[a-")]         // does not compile
    [InlineData("a)|(?:b")]     // compiles only inside the wrap, ^(?:a)|(?:b)$, which splits the anchors (#125)
    [InlineData("a)(b")]
    public void FM005_patterns_must_compile_and_use_the_shared_subset(string pattern)
    {
        var form = Create();
        Component(form, "codigo")["validate"]!["pattern"] = pattern;

        AssertIssue(form, "FM005", "codigo");
    }

    // $ means the end of the value on both sides (#125), so FM005 does not refuse it.
    [Theory]
    [InlineData("^[A-Z]{3}-[0-9]{3}$")]
    [InlineData("a(b|$)")]
    [InlineData("R\\$ [0-9]+")]
    [InlineData("[$]")]
    [InlineData("(a|b)\\)")]
    public void FM005_accepts_dollar_signs_and_balanced_parentheses(string pattern)
    {
        var form = Create();
        Component(form, "codigo")["validate"]!["pattern"] = pattern;

        Assert.Empty(FormValidator.Validate(Parse(form)));
    }

    [Fact]
    public void FM006_size_and_depth_are_limited()
    {
        var big = Create();
        for (var i = 0; i < 200; i++)
        {
            big["components"]!.AsArray().Add(Field("text", $"extra{i}"));
        }

        AssertIssue(big, "FM006");

        var deep = Create();
        var level3 = new JsonObject { ["type"] = "group", ["key"] = "c", ["label"] = "c", ["components"] = new JsonArray { Field("text", "x") } };
        var level2 = new JsonObject { ["type"] = "group", ["key"] = "b", ["label"] = "b", ["components"] = new JsonArray { level3 } };
        var level1 = new JsonObject { ["type"] = "group", ["key"] = "a", ["label"] = "a", ["components"] = new JsonArray { level2 } };
        var level0 = new JsonObject { ["type"] = "group", ["key"] = "z", ["label"] = "z", ["components"] = new JsonArray { level1 } };
        deep["components"]!.AsArray().Add(level0);
        AssertIssue(deep, "FM006");
    }

    [Fact]
    public void FM007_computed_fields_need_an_expression()
    {
        var form = Create();
        Component(form, "parcela").Remove("expression");

        AssertIssue(form, "FM007", "parcela");
    }

    // #237: a problem names its component by the full path from the root, so the designer can find it (form-designer.md §9.3).
    [Fact]
    public void Problem_paths_name_every_ancestor()
    {
        var form = Create();
        var field = Field("text", "c");
        field["options"] = new JsonArray(); // only choice fields have options: FM004
        var heading = new JsonObject { ["type"] = "heading", ["text"] = "Título", ["sensitive"] = true }; // FM009
        var inner = new JsonObject { ["type"] = "group", ["key"] = "b", ["label"] = "b", ["components"] = new JsonArray { field, heading } };
        form["components"]!.AsArray().Add(new JsonObject { ["type"] = "group", ["key"] = "a", ["label"] = "a", ["components"] = new JsonArray { inner } });

        var issues = FormValidator.Validate(Parse(form));

        Assert.Equal(["FM004 a.b.c", "FM009 a.b.components[1]"], issues.Select(i => $"{i.Code} {i.Path}"));
    }

    private static void AssertIssue(JsonObject form, string code, string? path = null)
    {
        var issues = FormValidator.Validate(Parse(form));
        Assert.Contains(issues, i => i.Code == code && (path is null || i.Path == path));
    }
}
