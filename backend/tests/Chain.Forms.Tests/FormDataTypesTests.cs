using System.Text.Json.Nodes;
using Chain.Expressions;
using static Chain.Forms.Tests.SampleForm;

namespace Chain.Forms.Tests;

/// <summary>A form's data contract for the workflow data catalog (workflow-definition.md §6.1, §6.2, §6.4).</summary>
public sealed class FormDataTypesTests
{
    [Fact]
    public void Stored_types_follow_the_component_table()
    {
        var stored = FormDataTypes.Stored(Parse(Create()));

        Assert.Equal(ExprType.Text, stored["cpf"].Type);
        Assert.Equal(ExprType.Text, stored["observacao"].Type);
        Assert.Equal(ExprType.Number, stored["valor"].Type);
        Assert.Equal(ExprType.Boolean, stored["aceite"].Type);
        Assert.Equal(ExprType.Text, stored["modalidade"].Type);
        Assert.Equal(ExprType.ListOf(ExprType.Text), stored["garantias"].Type);
        Assert.Equal(ExprType.Date, stored["vencimento"].Type);
        Assert.Equal(TypeKind.Record, stored["endereco"].Type.Kind);
        Assert.Equal(ExprType.Text, stored["endereco"].Type.Fields["cep"].Type);
        Assert.Equal(TypeKind.List, stored["socios"].Type.Kind);
        Assert.Equal(ExprType.Text, stored["socios"].Type.Element!.Fields["nome"].Type);
        Assert.Equal(ExprType.Unknown, stored["parcela"].Type); // a bare path: unknown
        Assert.DoesNotContain(stored.Keys, k => k.Length == 0);
        Assert.Equal(12, stored.Count); // the heading stores nothing
    }

    // Card #203: the start fields a sub-workflow step must map (WF207, workflow-definition.md §6.4).

    [Fact]
    public void Always_required_fields_are_the_required_top_level_ones_in_form_order()
    {
        // Not the group's own required field (cep), nor the list rows' (nome inside socios).
        Assert.Equal(["cpf", "nome", "valor", "aceite", "modalidade", "vencimento"], FormDataTypes.AlwaysRequired(Parse(Create())));
    }

    [Fact]
    public void A_visibility_condition_or_read_only_makes_a_required_field_not_always_required()
    {
        var form = Create();
        var condition = new JsonObject { ["kind"] = "compare", ["left"] = new JsonObject { ["kind"] = "path", ["path"] = new JsonArray("x") }, ["operator"] = "isEmpty" };
        Component(form, "cpf")["visibleWhen"] = condition;
        Component(form, "nome")["readOnly"] = true;
        Component(form, "valor")["requiredWhen"] = condition.DeepClone(); // still required: validate.required wins (forms.md F2)
        Component(form, "observacao")["requiredWhen"] = condition.DeepClone(); // required only sometimes

        Assert.Equal(["valor", "aceite", "modalidade", "vencimento"], FormDataTypes.AlwaysRequired(Parse(form)));
    }

    [Fact]
    public void Only_always_stored_fields_are_definite()
    {
        var stored = FormDataTypes.Stored(Parse(Create()));

        Assert.True(stored["cpf"].Definite);
        Assert.True(stored["valor"].Definite);
        Assert.True(stored["endereco"].Definite); // groups are always stored when visible
        Assert.True(stored["endereco"].Type.Fields["cep"].Definite);
        Assert.False(stored["observacao"].Definite); // not required
        Assert.False(stored["garantias"].Definite);
        Assert.False(stored["socios"].Definite); // lists are stored only when sent
        Assert.False(stored["parcela"].Definite); // computed values may be missing
    }

    [Fact]
    public void Conditional_read_only_and_computed_fields_are_optional()
    {
        var form = Create();
        Component(form, "cpf")["visibleWhen"] = new JsonObject { ["kind"] = "compare", ["left"] = new JsonObject { ["kind"] = "path", ["path"] = new JsonArray("x") }, ["operator"] = "isEmpty" };
        Component(form, "nome")["readOnly"] = true;
        Component(form, "endereco")["visibleWhen"] = Component(form, "cpf")["visibleWhen"]!.DeepClone();
        Component(form, "parcela")["expression"] = new JsonObject
        {
            ["kind"] = "call", ["function"] = "sum", ["args"] = new JsonArray(new JsonObject { ["kind"] = "path", ["path"] = new JsonArray("socios", "[]", "x") }),
        };

        var stored = FormDataTypes.Stored(Parse(form));

        Assert.False(stored["cpf"].Definite);
        Assert.False(stored["nome"].Definite);
        Assert.False(stored["endereco"].Definite);
        Assert.False(stored["endereco"].Type.Fields["cep"].Definite); // inside a conditional group
        Assert.Equal(ExprType.Number, stored["parcela"].Type); // inferred from sum(…)
    }

    // Keys an empty answer can remove (forms.md F2, "Empty values"; workflow-definition.md §6.2; card #136)

    [Fact]
    public void Optional_editable_top_level_fields_can_clear_their_keys()
    {
        var form = Create();
        form["components"]!.AsArray().Add(Field("file", "anexos"));

        var clearable = FormDataTypes.Clearable(Parse(form));

        // Not: required fields (cpf, nome, valor, aceite, modalidade, vencimento), the group (endereco), the computed parcela,
        // and nested keys. The dynamic list socios can't be required, and null clears it.
        Assert.Equal(["anexos", "codigo", "garantias", "observacao", "socios"], clearable.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void Visibility_and_required_when_do_not_change_what_can_clear_and_read_only_never_clears()
    {
        var form = Create();
        var condition = new JsonObject { ["kind"] = "compare", ["left"] = new JsonObject { ["kind"] = "path", ["path"] = new JsonArray("x") }, ["operator"] = "isEmpty" };
        Component(form, "cpf")["visibleWhen"] = condition.DeepClone(); // required: empty when visible is rejected, hidden changes nothing
        Component(form, "endereco")["visibleWhen"] = condition.DeepClone(); // a group is written whole when visible
        Component(form, "codigo")["visibleWhen"] = condition.DeepClone(); // optional: can be emptied while visible
        Component(form, "observacao")["requiredWhen"] = condition.DeepClone(); // can be emptied while the condition is false
        Component(form, "garantias")["readOnly"] = true; // never written

        var clearable = FormDataTypes.Clearable(Parse(form));

        Assert.Equal(["codigo", "observacao", "socios"], clearable.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void Accepted_inputs_ignore_computed_and_read_only_fields()
    {
        var form = Create();
        Component(form, "nome")["readOnly"] = true;

        var accepted = FormDataTypes.Accepted(Parse(form));

        Assert.Equal(ExprType.Number, accepted["valor"]);
        Assert.Equal(ExprType.Date, accepted["vencimento"]);
        Assert.Null(accepted["nome"]);
        Assert.Null(accepted["parcela"]);
        Assert.True(accepted.ContainsKey("endereco"));
        Assert.False(accepted.ContainsKey("inexistente"));
    }
}
