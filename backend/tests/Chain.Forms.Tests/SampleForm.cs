using System.Text.Json;
using System.Text.Json.Nodes;

namespace Chain.Forms.Tests;

/// <summary>A credit proposal form exercising every F1 component type (forms.md §F1).</summary>
internal static class SampleForm
{
    public static readonly DateTimeOffset Now = new(2026, 10, 15, 12, 0, 0, TimeSpan.Zero); // 09:00 in UTC−03:00
    public static readonly TimeSpan Zone = TimeSpan.FromHours(-3);

    public static JsonObject Create() => new()
    {
        ["schemaVersion"] = 1,
        ["components"] = new JsonArray
        {
            new JsonObject { ["type"] = "heading", ["text"] = "Dados do cliente" },
            Field("text", "cpf", new JsonObject { ["required"] = true, ["format"] = "cpf" }),
            Field("text", "nome", new JsonObject { ["required"] = true, ["minLength"] = 3, ["maxLength"] = 60 }),
            Field("textarea", "observacao", new JsonObject { ["maxLength"] = 500 }),
            Field("number", "valor", new JsonObject { ["required"] = true, ["min"] = 1000, ["max"] = 50000, ["decimalDigits"] = 2 }),
            Field("checkbox", "aceite", new JsonObject { ["required"] = true }),
            WithOptions(Field("select", "modalidade", new JsonObject { ["required"] = true })),
            WithOptions(Field("checklist", "garantias", new JsonObject { ["minSelected"] = 1, ["maxSelected"] = 2 })),
            Field("date", "vencimento", new JsonObject { ["required"] = true, ["min"] = new JsonObject { ["system"] = "currentDate" } }),
            Field("text", "codigo", new JsonObject { ["pattern"] = "[A-Z]{3}-[0-9]{3}" }),
            new JsonObject
            {
                ["type"] = "group", ["key"] = "endereco", ["label"] = "Endereço",
                ["components"] = new JsonArray { Field("text", "cep", new JsonObject { ["required"] = true, ["format"] = "cep" }) },
            },
            new JsonObject
            {
                ["type"] = "dynamicList", ["key"] = "socios", ["label"] = "Sócios", ["validate"] = new JsonObject { ["maxRows"] = 2 },
                ["components"] = new JsonArray { Field("text", "nome", new JsonObject { ["required"] = true }) },
            },
            new JsonObject { ["type"] = "computed", ["key"] = "parcela", ["label"] = "Parcela", ["expression"] = new JsonObject { ["kind"] = "path", ["path"] = new JsonArray("valor") } },
        },
    };

    /// <summary>A submission that satisfies every rule of <see cref="Create"/>.</summary>
    public static JsonObject ValidSubmission() => new()
    {
        ["cpf"] = "529.982.247-25",
        ["nome"] = "Ana Souza",
        ["valor"] = 15000.50,
        ["aceite"] = true,
        ["modalidade"] = "pf",
        ["garantias"] = new JsonArray("pf"),
        ["vencimento"] = "2026-10-15",
        ["codigo"] = "ABC-123",
        ["endereco"] = new JsonObject { ["cep"] = "01310-100" },
        ["socios"] = new JsonArray(new JsonObject { ["nome"] = "Bruno" }),
    };

    public static JsonObject Field(string type, string key, JsonObject? validate = null)
    {
        var field = new JsonObject { ["type"] = type, ["key"] = key, ["label"] = key };
        if (validate is not null)
        {
            field["validate"] = validate;
        }

        return field;
    }

    public static JsonObject Component(JsonObject form, string key) =>
        form["components"]!.AsArray().Select(c => c!.AsObject()).Single(c => (string?)c["key"] == key);

    public static FormDocument Parse(JsonObject form)
    {
        var result = FormDocumentParser.Parse(form.ToJsonString());
        Assert.True(result.IsSuccess, $"Expected the form to parse, got {result.Error}");
        return result.Document!;
    }

    public static IReadOnlyList<FieldError> Submit(JsonObject submission, JsonObject? form = null)
    {
        using var json = JsonDocument.Parse(submission.ToJsonString());
        return SubmissionValidator.Validate(Parse(form ?? Create()), json.RootElement, Now, Zone);
    }

    private static JsonObject WithOptions(JsonObject field)
    {
        field["options"] = new JsonArray
        {
            new JsonObject { ["value"] = "pf", ["label"] = "Pessoa física" },
            new JsonObject { ["value"] = "pj", ["label"] = "Pessoa jurídica" },
            new JsonObject { ["value"] = "aval", ["label"] = "Aval" },
        };
        return field;
    }
}
