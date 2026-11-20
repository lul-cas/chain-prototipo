namespace Chain.Forms.Tests;

/// <summary>Marking fields sensitive: the flag, FM009 and FM010 (sensitive-data.md §1, card #53).</summary>
public sealed class SensitiveFieldTests
{
    private static FormDocument Parse(string components)
    {
        var result = FormDocumentParser.Parse($$"""{"schemaVersion":1,"components":[{{components}}]}""");
        Assert.True(result.IsSuccess, result.Error?.Message);
        return result.Document!;
    }

    [Fact]
    public void Top_level_fields_read_only_fields_groups_lists_and_computed_fields_can_be_sensitive()
    {
        var document = Parse("""
            {"type":"text","key":"cpf","label":"CPF","sensitive":true},
            {"type":"text","key":"nome","label":"Nome","readOnly":true,"sensitive":true},
            {"type":"group","key":"conta","label":"Conta","sensitive":true,"components":[{"type":"text","key":"numero","label":"Número"}]},
            {"type":"dynamicList","key":"dependentes","label":"Dependentes","sensitive":true,"components":[{"type":"text","key":"nome","label":"Nome"}]},
            {"type":"computed","key":"prefixo","label":"Prefixo","sensitive":true,"expression":{"kind":"path","path":["cpf"]}},
            {"type":"text","key":"obs","label":"Observação","sensitive":false}
            """);

        Assert.Empty(FormValidator.Validate(document));
        Assert.Equal(["conta", "cpf", "dependentes", "nome", "prefixo"], document.SensitiveKeys());
    }

    [Fact]
    public void A_form_without_the_flag_has_no_sensitive_keys()
    {
        Assert.Empty(Parse("""{"type":"text","key":"cpf","label":"CPF"}""").SensitiveKeys());
    }

    [Fact]
    public void FM009_a_nested_or_display_component_can_not_be_sensitive()
    {
        var document = Parse("""
            {"type":"heading","text":"Dados","sensitive":true},
            {"type":"group","key":"conta","label":"Conta","components":[{"type":"text","key":"numero","label":"Número","sensitive":true}]},
            {"type":"dynamicList","key":"socios","label":"Sócios","components":[{"type":"text","key":"cpf","label":"CPF","sensitive":true}]}
            """);

        var issues = FormValidator.Validate(document);

        Assert.Equal(
            [("FM009", "components[0]"), ("FM009", "conta.numero"), ("FM009", "socios.cpf")],
            issues.Select(issue => (issue.Code, issue.Path)).ToList());
        Assert.Empty(document.SensitiveKeys()); // a misplaced flag marks nothing
    }

    [Fact]
    public void FM010_a_file_field_can_not_be_sensitive()
    {
        var document = Parse("""{"type":"file","key":"rg","label":"RG","sensitive":true}""");

        Assert.Equal([("FM010", "rg")], FormValidator.Validate(document).Select(issue => (issue.Code, issue.Path)).ToList());
        Assert.Empty(document.SensitiveKeys());
    }
}
