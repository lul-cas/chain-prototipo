using System.Text.Json;
using System.Text.Json.Nodes;
using static Chain.Forms.Tests.SampleForm;

namespace Chain.Forms.Tests;

/// <summary>
/// Regression #137 (owner decisions of 2026-10-19; forms.md §F2 "Computed fields" and "Groups and lists"). Q1 B: a computed
/// field whose result went missing kept its old value. Q2 B: a visible group was written whole, so its hidden and read-only
/// fields lost their stored values, although such fields never change data.
/// </summary>
public sealed class ComputedAndGroupTests
{
    private static JsonObject Computed(string key, params string[] path) => new()
    {
        ["type"] = "computed",
        ["key"] = key,
        ["label"] = key,
        ["expression"] = new JsonObject { ["kind"] = "path", ["path"] = new JsonArray([.. path.Select(segment => (JsonNode)segment)]) },
    };

    /// <summary>A field shown only when `nunca` is "sim", which it never is.</summary>
    private static JsonObject Hidden(JsonObject field)
    {
        field["visibleWhen"] = new JsonObject
        {
            ["kind"] = "compare",
            ["left"] = new JsonObject { ["kind"] = "path", ["path"] = new JsonArray("nunca") },
            ["operator"] = "equals",
            ["right"] = new JsonObject { ["kind"] = "literal", ["type"] = "text", ["value"] = "sim" },
        };
        return field;
    }

    private static JsonObject ReadOnly(JsonObject field)
    {
        field["readOnly"] = true;
        return field;
    }

    private static JsonObject Group(string key, params JsonObject[] components) =>
        new() { ["type"] = "group", ["key"] = key, ["label"] = key, ["components"] = new JsonArray([.. components]) };

    private static JsonObject List(string key, params JsonObject[] components) =>
        new() { ["type"] = "dynamicList", ["key"] = key, ["label"] = key, ["components"] = new JsonArray([.. components]) };

    private static SubmissionResult Process(JsonObject submission, JsonObject stored, params JsonObject[] components)
    {
        using var json = JsonDocument.Parse(submission.ToJsonString());
        using var data = JsonDocument.Parse(stored.ToJsonString());
        var form = new JsonObject { ["schemaVersion"] = 1, ["components"] = new JsonArray([.. components]) };
        var result = SubmissionProcessor.Process(Parse(form), json.RootElement, data.RootElement, Now, Zone);
        Assert.Empty(result.Errors);
        return result;
    }

    private static void AssertJson(string expected, JsonNode? actual) =>
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(expected), actual), $"Expected {expected}, got {actual?.ToJsonString()}");

    // Q1 B: a missing result clears the stored value.

    [Fact]
    public void A_missing_result_clears_a_top_level_computed_value()
    {
        var result = Process(new JsonObject { ["valor"] = null }, new JsonObject { ["valor"] = 5, ["copia"] = 5 }, Field("number", "valor"), Computed("copia", "valor"));

        Assert.True(result.Values.ContainsKey("copia"), result.Values.ToJsonString());
        Assert.Null(result.Values["copia"]);
    }

    [Fact]
    public void A_result_is_still_stored()
    {
        var result = Process(new JsonObject { ["valor"] = 7 }, new JsonObject { ["valor"] = 5, ["copia"] = 5 }, Field("number", "valor"), Computed("copia", "valor"));

        Assert.Equal(7, result.Values["copia"]!.GetValue<decimal>());
    }

    [Fact]
    public void A_missing_result_inside_a_group_is_left_out_of_the_group_written()
    {
        var result = Process(new JsonObject { ["g"] = new JsonObject() }, new JsonObject { ["g"] = new JsonObject { ["v"] = 1, ["c"] = 1 } },
            Group("g", Field("number", "v"), Computed("c", "g", "v")));

        AssertJson("{}", result.Values["g"]);
    }

    // Q2 B: a group keeps its hidden and read-only values.

    [Fact]
    public void A_group_keeps_the_stored_values_of_its_hidden_and_read_only_fields()
    {
        var stored = JsonNode.Parse("""{ "endereco": { "cep": "01310-100", "codigo": "C-1", "interno": "i", "extra": { "x": "y" } } }""")!.AsObject();
        var submission = JsonNode.Parse("""{ "endereco": { "cep": "04538-133", "codigo": "X", "interno": "Z" } }""")!.AsObject();

        var result = Process(submission, stored,
            Group("endereco", Field("text", "cep"), ReadOnly(Field("text", "codigo")), Hidden(Field("text", "interno")), Hidden(Group("extra", Field("text", "x")))));

        AssertJson("""{ "cep": "04538-133", "codigo": "C-1", "interno": "i", "extra": { "x": "y" } }""", result.Values["endereco"]);
    }

    [Fact]
    public void A_group_keeps_nothing_where_nothing_was_stored()
    {
        var result = Process(JsonNode.Parse("""{ "endereco": { "cep": "04538-133" } }""")!.AsObject(), new JsonObject(),
            Group("endereco", Field("text", "cep"), ReadOnly(Field("text", "codigo"))));

        AssertJson("""{ "cep": "04538-133" }""", result.Values["endereco"]);
    }

    [Fact]
    public void A_dynamic_list_is_written_as_sent_even_a_group_in_its_rows()
    {
        var stored = JsonNode.Parse("""{ "socios": [ { "nome": "Ana", "id": "1", "dados": { "n": "a", "codigo": "C-1" } } ] }""")!.AsObject();
        var submission = JsonNode.Parse("""{ "socios": [ { "nome": "Bruno", "dados": { "n": "b" } } ] }""")!.AsObject();

        var result = Process(submission, stored,
            List("socios", Field("text", "nome"), ReadOnly(Field("text", "id")), Group("dados", Field("text", "n"), ReadOnly(Field("text", "codigo")))));

        AssertJson("""[ { "nome": "Bruno", "dados": { "n": "b" } } ]""", result.Values["socios"]); // rows have no identity to merge by
    }

    [Fact]
    public void Top_level_hidden_and_read_only_fields_still_change_nothing()
    {
        var result = Process(new JsonObject { ["codigo"] = "X" }, new JsonObject { ["codigo"] = "C-1" }, ReadOnly(Field("text", "codigo")));

        Assert.False(result.Values.ContainsKey("codigo"));
    }
}
