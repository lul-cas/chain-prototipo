using System.Text.Json;
using System.Text.Json.Nodes;
using static Chain.Forms.Tests.SampleForm;

namespace Chain.Forms.Tests;

/// <summary>
/// An admin's correction of one top-level key, checked against one form field (workflow-engine.md §16.3): the field's type and
/// own rules at every depth, without evaluating conditions or recomputing computed fields.
/// </summary>
public sealed class CorrectionTests
{
    private static readonly JsonObject Condition = new()
    {
        ["kind"] = "compare",
        ["left"] = new JsonObject { ["kind"] = "path", ["path"] = new JsonArray("modalidade") },
        ["operator"] = "equals",
        ["right"] = new JsonObject { ["kind"] = "literal", ["type"] = "text", ["value"] = "pj" },
    };

    [Theory]
    [InlineData("valor", "7000", "7000")]
    [InlineData("valor", "1234.5", "1234.5")]
    [InlineData("nome", "\"Ana Lima\"", "\"Ana Lima\"")]
    [InlineData("cpf", "\"529.982.247-25\"", "\"529.982.247-25\"")]
    [InlineData("modalidade", "\"pj\"", "\"pj\"")]
    [InlineData("garantias", "[\"pf\",\"aval\"]", "[\"pf\",\"aval\"]")]
    [InlineData("aceite", "true", "true")]
    [InlineData("vencimento", "\"2026-10-20\"", "\"2026-10-20\"")]
    public void A_value_the_field_accepts_is_stored(string key, string value, string stored)
    {
        var result = Correct(Create(), key, value);

        Assert.Empty(result.Errors);
        Assert.Equal(stored, result.Value!.ToJsonString());
    }

    [Theory]
    [InlineData("hora", "time", "\"09:00\"", "\"09:00:00\"")]
    [InlineData("quando", "datetime", "\"2026-10-15T13:00-03:00\"", "\"2026-10-15T16:00:00Z\"")]
    public void Temporal_values_are_stored_in_canonical_form(string key, string type, string value, string stored)
    {
        var form = new JsonObject { ["schemaVersion"] = 1, ["components"] = new JsonArray { Field(type, key) } };

        var result = Correct(form, key, value);

        Assert.Empty(result.Errors);
        Assert.Equal(stored, result.Value!.ToJsonString());
    }

    [Theory]
    [InlineData("valor", "10", "valor", "too_small")]
    [InlineData("valor", "1000.123", "valor", "too_many_decimals")]
    [InlineData("valor", "\"7000\"", "valor", "type_mismatch")]
    [InlineData("nome", "\"Al\"", "nome", "too_short")]
    [InlineData("cpf", "\"111.111.111-11\"", "cpf", "invalid_format")]
    [InlineData("codigo", "\"abc-123\"", "codigo", "invalid_format")]
    [InlineData("modalidade", "\"xx\"", "modalidade", "invalid_option")]
    [InlineData("garantias", "[\"pf\",\"pj\",\"aval\"]", "garantias", "too_many")]
    [InlineData("vencimento", "\"2026-10-1\"", "vencimento", "type_mismatch")]
    [InlineData("endereco", "{\"cep\":\"abc\"}", "endereco.cep", "invalid_format")]
    [InlineData("endereco", "{\"cep\":\"01310-100\",\"bairro\":\"Centro\"}", "endereco.bairro", "unknown_field")]
    [InlineData("endereco", "{\"cep\":\"01310-100\",\"bairro\\u0000\":\"Centro\"}", "endereco", "invalid_value")] // a NUL key can't be echoed (#129)
    [InlineData("nome", "\"Ana\\u0000\"", "nome", "invalid_value")]
    [InlineData("endereco", "{}", "endereco.cep", "required")]
    [InlineData("endereco", "\"01310-100\"", "endereco", "type_mismatch")]
    [InlineData("socios", "[{\"nome\":\"Bruno\"},{\"nome\":\"Carla\"},{\"nome\":\"Diego\"}]", "socios", "too_many")]
    [InlineData("socios", "[{\"nome\":\"Bruno\"},{}]", "socios[1].nome", "required")]
    public void Rule_violations_use_the_submission_codes(string key, string value, string path, string code)
    {
        var result = Correct(Create(), key, value);

        Assert.Contains(new FieldError(path, code), result.Errors);
        Assert.Null(result.Value);
    }

    [Fact]
    public void An_empty_value_on_an_optional_field_stores_nothing()
    {
        var result = Correct(Create(), "observacao", "\"\"");

        Assert.Empty(result.Errors);
        Assert.Null(result.Value);
    }

    [Fact]
    public void An_empty_value_on_a_required_field_is_required()
    {
        var result = Correct(Create(), "nome", "\"\"");

        Assert.Equal(new[] { new FieldError("nome", "required") }, result.Errors);
    }

    [Fact]
    public void Conditions_are_not_evaluated()
    {
        var hidden = Field("number", "taxa", new JsonObject { ["min"] = 10 });
        hidden["visibleWhen"] = Condition.DeepClone();
        var conditional = Field("text", "motivo");
        conditional["requiredWhen"] = new JsonObject { ["kind"] = "compare", ["left"] = new JsonObject { ["kind"] = "literal", ["type"] = "number", ["value"] = "1" }, ["operator"] = "equals", ["right"] = new JsonObject { ["kind"] = "literal", ["type"] = "number", ["value"] = "1" } };
        var form = Group("extra", hidden, conditional);

        // taxa would be hidden (no modalidade), but its value is still checked; motivo's requiredWhen holds, but is not evaluated.
        var result = Correct(form, "extra", "{\"taxa\":1}");

        Assert.Equal(new[] { new FieldError("extra.taxa", "too_small") }, result.Errors);
    }

    [Fact]
    public void A_nested_field_with_visibleWhen_is_not_required()
    {
        var hidden = Field("text", "cnpj", new JsonObject { ["required"] = true });
        hidden["visibleWhen"] = Condition.DeepClone();

        var result = Correct(Group("empresa", hidden), "empresa", "{}");

        Assert.Empty(result.Errors);
        Assert.Equal("{}", result.Value!.ToJsonString());
    }

    [Theory]
    [InlineData("{\"cota\":10,\"dobro\":20}", "{\"cota\":10,\"dobro\":20}", null)] // unchanged
    [InlineData("{\"cota\":15,\"dobro\":20}", "{\"cota\":10,\"dobro\":20}", null)] // its input changes, it stays as stored
    [InlineData("{\"cota\":10,\"dobro\":99}", "{\"cota\":10,\"dobro\":20}", "partes.dobro")]
    [InlineData("{\"cota\":10}", "{\"cota\":10,\"dobro\":20}", "partes.dobro")] // removing it is a change too
    [InlineData("{\"cota\":10}", "{\"cota\":10}", null)]
    [InlineData("{\"cota\":10,\"dobro\":20}", null, "partes.dobro")] // nothing stored before
    public void Nested_computed_values_must_stay_as_stored(string value, string? current, string? errorPath)
    {
        var dobro = new JsonObject
        {
            ["type"] = "computed", ["key"] = "dobro", ["label"] = "Dobro",
            ["expression"] = new JsonObject
            {
                ["kind"] = "arithmetic", ["op"] = "multiply",
                ["left"] = new JsonObject { ["kind"] = "path", ["path"] = new JsonArray("partes", "cota") },
                ["right"] = new JsonObject { ["kind"] = "literal", ["type"] = "number", ["value"] = "2" },
            },
        };
        var form = Group("partes", Field("number", "cota"), dobro);

        var result = Correct(form, "partes", value, current);

        if (errorPath is null)
        {
            Assert.Empty(result.Errors);
            Assert.True(JsonNode.DeepEquals(JsonNode.Parse(value), result.Value)); // never recomputed
        }
        else
        {
            Assert.Equal(new[] { new FieldError(errorPath, "computed_field") }, result.Errors);
        }
    }

    [Fact]
    public void Nested_read_only_values_are_ignored_as_in_a_submission()
    {
        var form = Group("dados", Field("text", "nome"), ReadOnly(Field("text", "origem")));

        var result = Correct(form, "dados", "{\"nome\":\"Ana\",\"origem\":\"manual\"}");

        Assert.Empty(result.Errors);
        Assert.Equal("{\"nome\":\"Ana\"}", result.Value!.ToJsonString());
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void File_values_must_stay_as_stored(bool nested)
    {
        const string Stored = "[{\"fileId\":\"0199f0b4-1111-7000-8000-000000000001\",\"name\":\"a.pdf\",\"size\":10,\"contentType\":\"application/pdf\"}]";
        const string Other = "[{\"fileId\":\"0199f0b4-2222-7000-8000-000000000002\"}]";
        var file = Field("file", "docs");
        var form = nested ? Group("anexos", file) : new JsonObject { ["schemaVersion"] = 1, ["components"] = new JsonArray { file } };
        var key = nested ? "anexos" : "docs";
        string Wrap(string docs) => nested ? $"{{\"docs\":{docs}}}" : docs;

        var unchanged = Correct(form, key, Wrap(Stored), Wrap(Stored));
        var changed = Correct(form, key, Wrap(Other), Wrap(Stored));

        Assert.Empty(unchanged.Errors);
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(Wrap(Stored)), unchanged.Value));
        Assert.Equal(new[] { new FieldError(nested ? "anexos.docs" : "docs", "file_field") }, changed.Errors);
    }

    private static CorrectionResult Correct(JsonObject form, string key, string value, string? current = null)
    {
        var field = Parse(form).Components.Single(c => c.Key == key);
        using var json = JsonDocument.Parse(value);
        using var stored = current is null ? null : JsonDocument.Parse(current);
        return SubmissionProcessor.Correct(field, json.RootElement, stored?.RootElement, Now, Zone);
    }

    private static JsonObject Group(string key, params JsonObject[] fields) => new()
    {
        ["schemaVersion"] = 1,
        ["components"] = new JsonArray
        {
            new JsonObject { ["type"] = "group", ["key"] = key, ["label"] = key, ["components"] = new JsonArray(fields) },
        },
    };

    private static JsonObject ReadOnly(JsonObject field)
    {
        field["readOnly"] = true;
        return field;
    }
}
