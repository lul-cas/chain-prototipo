using System.Text.Json;
using System.Text.Json.Nodes;
using static Chain.Forms.Tests.SampleForm;

namespace Chain.Forms.Tests;

/// <summary>
/// Regression #86 (owner decision B, 2026-10-17; forms.md §F2 "Empty values"): an empty optional value stored nothing, and
/// submissions merge at the top level, so a later step that showed the same key couldn't clear it. An unchecked box stayed
/// <c>true</c>. Now an empty value in a visible, editable field comes out as <c>null</c>, which the engine removes.
/// </summary>
public sealed class EmptyValueTests
{
    /// <summary>A later step's form, over data that an earlier step stored.</summary>
    private static JsonObject ReviewForm()
    {
        var options = new JsonArray { new JsonObject { ["value"] = "pf", ["label"] = "PF" }, new JsonObject { ["value"] = "pj", ["label"] = "PJ" } };
        var modalidade = Field("select", "modalidade");
        modalidade["options"] = options.DeepClone();
        var garantias = Field("checklist", "garantias");
        garantias["options"] = options.DeepClone();
        var protocolo = Field("text", "protocolo");
        protocolo["readOnly"] = true;
        var segredo = Field("text", "segredo");
        segredo["visibleWhen"] = new JsonObject
        {
            ["kind"] = "compare",
            ["left"] = new JsonObject { ["kind"] = "path", ["path"] = new JsonArray("nunca") },
            ["operator"] = "equals",
            ["right"] = new JsonObject { ["kind"] = "literal", ["type"] = "text", ["value"] = "sim" },
        };
        var tipos = Field("checklist", "tipos");
        tipos["options"] = options.DeepClone();
        return new JsonObject
        {
            ["schemaVersion"] = 1,
            ["components"] = new JsonArray
            {
                Field("checkbox", "aceite"), Field("text", "obs"), modalidade, Field("number", "valor"), garantias, Field("date", "inicio"),
                protocolo, segredo,
                new JsonObject { ["type"] = "group", ["key"] = "endereco", ["label"] = "Endereço", ["components"] = new JsonArray { Field("text", "cep"), tipos } },
                new JsonObject { ["type"] = "dynamicList", ["key"] = "socios", ["label"] = "Sócios", ["components"] = new JsonArray { Field("text", "nome") } },
            },
        };
    }

    /// <summary>What the earlier step stored.</summary>
    private static JsonObject Stored() => new()
    {
        ["aceite"] = true,
        ["obs"] = "Primeira análise",
        ["modalidade"] = "pf",
        ["valor"] = 10,
        ["garantias"] = new JsonArray("pf"),
        ["inicio"] = "2026-10-15",
        ["protocolo"] = "P-1",
        ["segredo"] = "s",
        ["endereco"] = new JsonObject { ["cep"] = "01310-100", ["tipos"] = new JsonArray("pj") },
        ["socios"] = new JsonArray(new JsonObject { ["nome"] = "Bruno" }),
    };

    private static SubmissionResult Process(JsonObject submission, JsonObject? form = null)
    {
        using var json = JsonDocument.Parse(submission.ToJsonString());
        using var data = JsonDocument.Parse(Stored().ToJsonString());
        return SubmissionProcessor.Process(Parse(form ?? ReviewForm()), json.RootElement, data.RootElement, Now, Zone);
    }

    private static void AssertCleared(SubmissionResult result, string key)
    {
        Assert.Empty(result.Errors);
        Assert.True(result.Values.ContainsKey(key), $"Expected '{key}' to be cleared, got {result.Values.ToJsonString()}");
        Assert.Null(result.Values[key]);
    }

    [Fact]
    public void An_unchecked_box_clears_the_stored_true()
    {
        AssertCleared(Process(new JsonObject { ["aceite"] = false }), "aceite");
    }

    [Fact]
    public void A_cleared_text_clears_the_stored_text()
    {
        AssertCleared(Process(new JsonObject { ["obs"] = "" }), "obs");
    }

    [Fact]
    public void A_cleared_choice_clears_the_stored_choice()
    {
        AssertCleared(Process(new JsonObject { ["modalidade"] = "" }), "modalidade");
        AssertCleared(Process(new JsonObject { ["modalidade"] = null }), "modalidade");
    }

    [Theory]
    [InlineData("aceite", "null")]
    [InlineData("obs", "null")]
    [InlineData("valor", "null")]
    [InlineData("valor", "\"\"")]
    [InlineData("garantias", "[]")]
    [InlineData("garantias", "null")]
    [InlineData("inicio", "\"\"")]
    [InlineData("socios", "null")]
    public void Any_empty_value_of_a_visible_editable_field_clears_it(string key, string empty)
    {
        AssertCleared(Process(new JsonObject { [key] = JsonNode.Parse(empty) }), key);
    }

    [Fact]
    public void A_key_left_out_changes_nothing()
    {
        var result = Process(new JsonObject { ["obs"] = "Segunda análise" });

        Assert.Empty(result.Errors);
        Assert.Equal("Segunda análise", (string?)result.Values["obs"]);
        Assert.All(["aceite", "modalidade", "valor", "garantias", "inicio", "socios"], key => Assert.False(result.Values.ContainsKey(key), key));
    }

    [Theory]
    [InlineData("\"\"")]
    [InlineData("null")]
    public void Hidden_and_read_only_fields_never_clear(string empty)
    {
        var result = Process(new JsonObject { ["protocolo"] = JsonNode.Parse(empty), ["segredo"] = JsonNode.Parse(empty) });

        Assert.Empty(result.Errors);
        Assert.False(result.Values.ContainsKey("protocolo"));
        Assert.False(result.Values.ContainsKey("segredo"));
    }

    [Fact]
    public void A_required_field_sent_empty_is_required_not_cleared()
    {
        var form = ReviewForm();
        Component(form, "aceite")["validate"] = new JsonObject { ["required"] = true };

        var result = Process(new JsonObject { ["aceite"] = false }, form);

        Assert.Contains(result.Errors, e => e.Key == "aceite" && e.Code == "required");
    }

    [Fact]
    public void Groups_and_lists_are_written_whole_without_their_empty_fields()
    {
        var result = Process(new JsonObject
        {
            ["endereco"] = new JsonObject { ["cep"] = "", ["tipos"] = new JsonArray() },
            ["socios"] = new JsonArray(),
        });

        Assert.Empty(result.Errors);
        Assert.Equal("{}", result.Values["endereco"]!.ToJsonString());
        Assert.Equal("[]", result.Values["socios"]!.ToJsonString());
    }
}
