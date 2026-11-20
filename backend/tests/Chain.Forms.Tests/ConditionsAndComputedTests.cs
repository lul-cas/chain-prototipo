using System.Text.Json;
using System.Text.Json.Nodes;
using static Chain.Forms.Tests.SampleForm;

namespace Chain.Forms.Tests;

/// <summary>Forms increment F2: conditions and computed fields (forms.md §F2).</summary>
public sealed class ConditionsAndComputedTests
{
    private static JsonObject Compare(string key, string op, string type, string value) => new()
    {
        ["kind"] = "compare",
        ["left"] = new JsonObject { ["kind"] = "path", ["path"] = new JsonArray(key) },
        ["operator"] = op,
        ["right"] = new JsonObject { ["kind"] = "literal", ["type"] = type, ["value"] = value },
    };

    /// <summary>modalidade = "pj" shows "cnpj" (required) and hides "cpf"; "motivo" is required when valor &gt; 30000; "total" sums the partners' shares.</summary>
    private static JsonObject ConditionalForm()
    {
        var cpf = Field("text", "cpf", new JsonObject { ["required"] = true, ["format"] = "cpf" });
        cpf["visibleWhen"] = Compare("modalidade", "notEquals", "text", "pj");
        var cnpj = Field("text", "cnpj", new JsonObject { ["required"] = true, ["format"] = "cnpj" });
        cnpj["visibleWhen"] = Compare("modalidade", "equals", "text", "pj");
        var motivo = Field("textarea", "motivo");
        motivo["requiredWhen"] = Compare("valor", "greaterThan", "number", "30000");
        var socios = new JsonObject
        {
            ["type"] = "dynamicList", ["key"] = "socios", ["label"] = "Sócios",
            ["components"] = new JsonArray { Field("number", "cota") },
        };
        socios["visibleWhen"] = Compare("modalidade", "equals", "text", "pj");
        var total = new JsonObject
        {
            ["type"] = "computed", ["key"] = "total", ["label"] = "Total",
            ["expression"] = new JsonObject { ["kind"] = "call", ["function"] = "sum", ["args"] = new JsonArray(new JsonObject { ["kind"] = "path", ["path"] = new JsonArray("socios", "[]", "cota") }) },
        };
        var dobro = new JsonObject
        {
            ["type"] = "computed", ["key"] = "dobro", ["label"] = "Dobro",
            ["expression"] = new JsonObject { ["kind"] = "arithmetic", ["op"] = "multiply", ["left"] = new JsonObject { ["kind"] = "path", ["path"] = new JsonArray("total") }, ["right"] = new JsonObject { ["kind"] = "literal", ["type"] = "number", ["value"] = "2" } },
        };
        return new JsonObject
        {
            ["schemaVersion"] = 1,
            ["components"] = new JsonArray
            {
                new JsonObject { ["type"] = "select", ["key"] = "modalidade", ["label"] = "Modalidade", ["options"] = new JsonArray { new JsonObject { ["value"] = "pf", ["label"] = "PF" }, new JsonObject { ["value"] = "pj", ["label"] = "PJ" } } },
                cpf, cnpj, Field("number", "valor"), motivo, socios, total, dobro,
            },
        };
    }

    private static SubmissionResult Process(JsonObject submission, JsonObject? instanceData = null, JsonObject? form = null)
    {
        using var json = JsonDocument.Parse(submission.ToJsonString());
        using var data = JsonDocument.Parse((instanceData ?? new JsonObject()).ToJsonString());
        return SubmissionProcessor.Process(Parse(form ?? ConditionalForm()), json.RootElement, data.RootElement, Now, Zone);
    }

    [Fact]
    public void FM008_conditions_must_be_valid_trees()
    {
        var form = ConditionalForm();
        Component(form, "cnpj")["visibleWhen"] = new JsonObject { ["kind"] = "script" };
        Component(form, "motivo")["requiredWhen"] = Compare("valor", "like", "number", "1");

        var issues = FormValidator.Validate(Parse(form));

        Assert.Contains(issues, i => i.Code == "FM008" && i.Path == "cnpj");
        Assert.Contains(issues, i => i.Code == "FM008" && i.Path == "motivo");
    }

    [Fact]
    public void FM007_computed_expression_must_be_a_valid_value_tree()
    {
        var form = ConditionalForm();
        Component(form, "total")["expression"] = new JsonObject { ["kind"] = "call", ["function"] = "eval", ["args"] = new JsonArray() };

        Assert.Contains(FormValidator.Validate(Parse(form)), i => i.Code == "FM007" && i.Path == "total");
    }

    [Fact]
    public void Hidden_fields_are_not_validated_or_stored()
    {
        var result = Process(new JsonObject { ["modalidade"] = "pf", ["cpf"] = "529.982.247-25", ["cnpj"] = "garbage", ["valor"] = 100 });

        Assert.Empty(result.Errors);
        Assert.False(result.Values.ContainsKey("cnpj"));
        Assert.Equal("529.982.247-25", (string?)result.Values["cpf"]);
    }

    [Fact]
    public void Visible_conditional_fields_are_validated_and_required()
    {
        var result = Process(new JsonObject { ["modalidade"] = "pj", ["valor"] = 100 });

        Assert.Contains(result.Errors, e => e.Key == "cnpj" && e.Code == "required");
        Assert.DoesNotContain(result.Errors, e => e.Key == "cpf");
    }

    [Fact]
    public void Children_of_hidden_containers_are_hidden()
    {
        var result = Process(new JsonObject { ["modalidade"] = "pf", ["cpf"] = "529.982.247-25", ["socios"] = new JsonArray(new JsonObject { ["cota"] = "x" }) });

        Assert.Empty(result.Errors);
        Assert.False(result.Values.ContainsKey("socios"));
    }

    [Fact]
    public void Required_when_applies_only_when_its_condition_holds()
    {
        Assert.Empty(Process(new JsonObject { ["modalidade"] = "pf", ["cpf"] = "529.982.247-25", ["valor"] = 30000 }).Errors);
        Assert.Contains(Process(new JsonObject { ["modalidade"] = "pf", ["cpf"] = "529.982.247-25", ["valor"] = 30000.01 }).Errors, e => e.Key == "motivo" && e.Code == "required");
    }

    [Fact]
    public void Computed_fields_are_recomputed_in_order_and_client_values_ignored()
    {
        var result = Process(new JsonObject
        {
            ["modalidade"] = "pj", ["cnpj"] = "11.222.333/0001-81",
            ["socios"] = new JsonArray(new JsonObject { ["cota"] = 60.5 }, new JsonObject { ["cota"] = 39.5 }),
            ["total"] = 1, ["dobro"] = 1,
        });

        Assert.Empty(result.Errors);
        Assert.Equal(100m, result.Values["total"]!.GetValue<decimal>());
        Assert.Equal(200m, result.Values["dobro"]!.GetValue<decimal>());
    }

    [Fact]
    public void Conditions_read_existing_instance_data_overlaid_by_the_submission()
    {
        var form = ConditionalForm();
        Component(form, "motivo")["requiredWhen"] = Compare("risco", "equals", "text", "alto");

        var withRisk = Process(new JsonObject { ["modalidade"] = "pf", ["cpf"] = "529.982.247-25" }, new JsonObject { ["risco"] = "alto" }, form);
        var overridden = Process(new JsonObject { ["modalidade"] = "pj", ["cnpj"] = "11.222.333/0001-81" }, new JsonObject { ["modalidade"] = "pf" }, ConditionalForm());

        Assert.Contains(withRisk.Errors, e => e.Key == "motivo" && e.Code == "required");
        Assert.DoesNotContain(overridden.Errors, e => e.Key == "cnpj"); // submitted "pj" wins over stored "pf"
    }

    [Fact]
    public void Evaluation_errors_are_reported_on_the_field()
    {
        var form = ConditionalForm();
        Component(form, "motivo")["requiredWhen"] = Compare("valor", "greaterThan", "text", "abc"); // number vs text

        var result = Process(new JsonObject { ["modalidade"] = "pf", ["cpf"] = "529.982.247-25", ["valor"] = 5 }, form: form);

        Assert.Contains(result.Errors, e => e.Key == "motivo" && e.Code == "expression_error");
    }

    [Fact]
    public void Computed_errors_are_reported_on_the_field()
    {
        var form = ConditionalForm();
        Component(form, "dobro")["expression"] = new JsonObject
        {
            ["kind"] = "arithmetic", ["op"] = "divide",
            ["left"] = new JsonObject { ["kind"] = "literal", ["type"] = "number", ["value"] = "1" },
            ["right"] = new JsonObject { ["kind"] = "literal", ["type"] = "number", ["value"] = "0" },
        };

        var result = Process(new JsonObject { ["modalidade"] = "pf", ["cpf"] = "529.982.247-25" }, form: form);

        Assert.Contains(result.Errors, e => e.Key == "dobro" && e.Code == "expression_error");
    }

    [Fact]
    public void Read_only_fields_are_not_stored_from_the_client()
    {
        var form = ConditionalForm();
        Component(form, "valor")["readOnly"] = true;

        var result = Process(new JsonObject { ["modalidade"] = "pf", ["cpf"] = "529.982.247-25", ["valor"] = 999 }, form: form);

        Assert.False(result.Values.ContainsKey("valor"));
    }

    // Conditions read the submitted values before each field's own checks, so text with NUL still reaches the evaluator (#126).
    // .NET's parser ignored a trailing NUL and read "12\0" as 12, where the browser's number() fails.
    [Fact]
    public void A_condition_on_text_ending_in_NUL_is_an_expression_error()
    {
        var detalhe = Field("text", "detalhe");
        detalhe["visibleWhen"] = new JsonObject
        {
            ["kind"] = "compare",
            ["left"] = new JsonObject { ["kind"] = "call", ["function"] = "number", ["args"] = new JsonArray(new JsonObject { ["kind"] = "path", ["path"] = new JsonArray("texto") }) },
            ["operator"] = "greaterThan",
            ["right"] = new JsonObject { ["kind"] = "literal", ["type"] = "number", ["value"] = "5" },
        };
        var form = new JsonObject { ["schemaVersion"] = 1, ["components"] = new JsonArray { Field("text", "texto"), detalhe } };

        var result = Process(new JsonObject { ["texto"] = "12\0" }, form: form);

        Assert.Contains(result.Errors, e => e.Key == "texto" && e.Code == "invalid_value");
        Assert.Contains(result.Errors, e => e.Key == "detalhe" && e.Code == "expression_error");
    }
}
