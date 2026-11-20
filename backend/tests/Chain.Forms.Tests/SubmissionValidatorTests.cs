using System.Text.Json.Nodes;
using static Chain.Forms.Tests.SampleForm;

namespace Chain.Forms.Tests;

/// <summary>Server-side submission validation (forms.md §F1, ADR-0009 §3).</summary>
public sealed class SubmissionValidatorTests
{
    [Fact]
    public void Valid_submission_has_no_errors()
    {
        Assert.Empty(Submit(ValidSubmission()));
    }

    [Theory]
    [InlineData("nome", 123)]
    [InlineData("valor", "1500")]
    [InlineData("aceite", "yes")]
    [InlineData("vencimento", "15/10/2026")]
    [InlineData("garantias", "pf")]
    public void Wrong_types_are_rejected(string key, object value)
    {
        var submission = ValidSubmission();
        submission[key] = JsonValue.Create(value);

        AssertError(Submit(submission), key, "type_mismatch");
    }

    [Theory]
    [InlineData("nome", null)]
    [InlineData("nome", "")]
    [InlineData("aceite", false)]
    public void Required_fields_must_be_filled(string key, object? value)
    {
        var submission = ValidSubmission();
        submission[key] = value is null ? null : JsonValue.Create(value);

        AssertError(Submit(submission), key, "required");
    }

    [Fact]
    public void Missing_required_field_is_reported_and_missing_optional_field_is_fine()
    {
        var submission = ValidSubmission();
        submission.Remove("modalidade");
        submission.Remove("observacao");

        var errors = Submit(submission);

        AssertError(errors, "modalidade", "required");
        Assert.DoesNotContain(errors, e => e.Key == "observacao");
    }

    [Fact]
    public void Text_length_limits()
    {
        var submission = ValidSubmission();
        submission["nome"] = "Al";
        AssertError(Submit(submission), "nome", "too_short");

        submission["nome"] = new string('a', 61);
        AssertError(Submit(submission), "nome", "too_long");
    }

    // Regression #93: PostgreSQL jsonb cannot store the NUL character, so storing text with one failed in the database.

    [Fact]
    public void Text_with_the_NUL_character_is_an_invalid_value_at_any_depth()
    {
        var submission = ValidSubmission();
        submission["nome"] = "Ana\u0000Souza";
        submission["observacao"] = "\u0000";
        submission["socios"] = new JsonArray(new JsonObject { ["nome"] = "Bruno\u0000" });

        var errors = Submit(submission);

        Assert.Equal([("nome", "invalid_value"), ("observacao", "invalid_value"), ("socios[0].nome", "invalid_value")], errors.Select(e => (e.Key, e.Code)));
    }

    // Regression #129: unknown_field echoed a key with the NUL character, and storing that result for replay failed in the
    // database. The error goes to the object that holds the key instead, once per object.

    [Fact]
    public void A_key_with_the_NUL_character_is_an_invalid_value_of_the_object_that_holds_it()
    {
        var submission = ValidSubmission();
        submission["x\u0000y"] = 1;
        submission["\u0000"] = 2;
        submission["endereco"] = new JsonObject { ["cep"] = "01310-100", ["bairro\u0000"] = "Centro" };
        submission["socios"] = new JsonArray(new JsonObject { ["nome"] = "Bruno", ["\u0000"] = true });

        var errors = Submit(submission);

        Assert.Equal([("", "invalid_value"), ("endereco", "invalid_value"), ("socios[0]", "invalid_value")], errors.Select(e => (e.Key, e.Code)));
    }

    [Theory]
    [InlineData(999.99, "too_small")]
    [InlineData(50000.01, "too_large")]
    [InlineData(1500.555, "too_many_decimals")]
    public void Number_limits(double value, string code)
    {
        var submission = ValidSubmission();
        submission["valor"] = value;

        AssertError(Submit(submission), "valor", code);
    }

    [Fact]
    public void Relative_date_bounds_use_the_evaluation_zone()
    {
        var submission = ValidSubmission();
        submission["vencimento"] = "2026-10-14"; // yesterday in UTC−03:00

        AssertError(Submit(submission), "vencimento", "too_early");

        // 01:00 UTC on the 16th is still the 15th in UTC−03:00, so "today" is the 15th.
        submission["vencimento"] = "2026-10-15";
        using var json = System.Text.Json.JsonDocument.Parse(submission.ToJsonString());
        Assert.Empty(SubmissionValidator.Validate(Parse(Create()), json.RootElement, new DateTimeOffset(2026, 10, 16, 1, 0, 0, TimeSpan.Zero), Zone));
    }

    [Fact]
    public void Options_must_be_valid()
    {
        var submission = ValidSubmission();
        submission["modalidade"] = "mei";
        submission["garantias"] = new JsonArray("pf", "imovel");

        var errors = Submit(submission);

        AssertError(errors, "modalidade", "invalid_option");
        AssertError(errors, "garantias", "invalid_option");
    }

    [Fact]
    public void Selection_and_row_counts_are_limited()
    {
        var submission = ValidSubmission();
        submission["garantias"] = new JsonArray("pf", "pj", "aval");
        submission["socios"] = new JsonArray(new JsonObject { ["nome"] = "A" }, new JsonObject { ["nome"] = "B" }, new JsonObject { ["nome"] = "C" });
        var errors = Submit(submission);
        AssertError(errors, "garantias", "too_many");
        AssertError(errors, "socios", "too_many");

        submission["garantias"] = new JsonArray();
        AssertError(Submit(submission), "garantias", "too_few");
    }

    [Theory]
    [InlineData("529.982.247-25", true)]
    [InlineData("52998224725", true)]
    [InlineData("529.982.247-24", false)] // wrong check digit
    [InlineData("111.111.111-11", false)] // repeated digits
    [InlineData("1234", false)]
    public void Cpf_check_digits_are_verified(string cpf, bool valid)
    {
        var submission = ValidSubmission();
        submission["cpf"] = cpf;

        var errors = Submit(submission);

        Assert.Equal(valid, !errors.Any(e => e.Key == "cpf"));
    }

    [Theory]
    [InlineData("11.222.333/0001-81", true)]
    [InlineData("11222333000181", true)]
    [InlineData("11.222.333/0001-80", false)]
    [InlineData("00.000.000/0000-00", false)]
    public void Cnpj_check_digits_are_verified(string cnpj, bool valid)
    {
        var form = Create();
        Component(form, "cpf")["validate"]!["format"] = "cnpj";
        var submission = ValidSubmission();
        submission["cpf"] = cnpj;

        Assert.Equal(valid, !Submit(submission, form).Any(e => e.Key == "cpf"));
    }

    [Theory]
    [InlineData("email", "ana@empresa.com.br", true)]
    [InlineData("email", "ana@empresa", false)]
    [InlineData("phone", "(11) 98765-4321", true)]
    [InlineData("phone", "+55 11 3333-4444", true)]
    [InlineData("phone", "123", false)]
    [InlineData("cep", "01310100", true)]
    [InlineData("cep", "0131-0100", false)]
    // ASCII digits only, as in the browser (ADR-0009 F-3, #68): .NET's \d also matches other scripts' digits.
    [InlineData("cep", "\u0660\u0661\u0663\u0661\u0660-\u0661\u0660\u0660", false)]
    [InlineData("cep", "\uff10\uff11\uff13\uff11\uff10\uff11\uff10\uff10", false)]
    [InlineData("phone", "(11) 98765-4321\u0661", false)]
    [InlineData("phone", "(\u0661\u0661) 98765-4321", false)]
    [InlineData("cpf", "\u0665\u0662\u0669.\u0669\u0668\u0662.\u0662\u0664\u0667-\u0662\u0665", false)]
    [InlineData("cnpj", "\u0661\u0661.\u0662\u0662\u0662.\u0663\u0663\u0663/\u0660\u0660\u0660\u0661-\u0668\u0661", false)]
    public void Built_in_formats(string format, string value, bool valid)
    {
        var form = Create();
        Component(form, "cpf")["validate"]!["format"] = format;
        var submission = ValidSubmission();
        submission["cpf"] = value;

        Assert.Equal(valid, !Submit(submission, form).Any(e => e.Key == "cpf"));
    }

    [Theory]
    [InlineData("ABC-123", true)]
    [InlineData("abc-123", false)]
    [InlineData("XABC-123", false)] // the pattern must match the whole value
    [InlineData("ABC-123\n", false)] // as in the browser: in .NET, $ also matches before a final newline (#81)
    public void Patterns_match_the_whole_value(string value, bool valid)
    {
        var submission = ValidSubmission();
        submission["codigo"] = value;

        Assert.Equal(valid, !Submit(submission).Any(e => e.Key == "codigo"));
    }

    [Fact]
    public void Catastrophic_pattern_times_out_as_invalid_format()
    {
        var form = Create();
        Component(form, "codigo")["validate"]!["pattern"] = "(a+)+$";
        var submission = ValidSubmission();
        submission["codigo"] = new string('a', 40) + "!";

        var started = DateTime.UtcNow;
        var errors = Submit(submission, form);

        AssertError(errors, "codigo", "invalid_format");
        Assert.True(DateTime.UtcNow - started < TimeSpan.FromSeconds(2));
    }

    [Fact]
    public void Nested_errors_use_paths_and_unknown_fields_are_rejected()
    {
        var submission = ValidSubmission();
        submission["endereco"] = new JsonObject { ["cep"] = "abc", ["bairro"] = "Centro" };
        submission["socios"] = new JsonArray(new JsonObject { ["nome"] = "" });
        submission["hacker"] = "<script>";

        var errors = Submit(submission);

        AssertError(errors, "endereco.cep", "invalid_format");
        AssertError(errors, "endereco.bairro", "unknown_field");
        AssertError(errors, "socios[0].nome", "required");
        AssertError(errors, "hacker", "unknown_field");
    }

    [Fact]
    public void Computed_and_read_only_values_from_the_client_are_ignored()
    {
        var form = Create();
        Component(form, "observacao")["readOnly"] = true;
        var submission = ValidSubmission();
        submission["parcela"] = 999999;
        submission["observacao"] = 12345; // wrong type, but ignored because read-only

        Assert.Empty(Submit(submission, form));
    }

    [Fact]
    public void Submission_must_be_an_object()
    {
        using var json = System.Text.Json.JsonDocument.Parse("[1,2,3]");

        var errors = SubmissionValidator.Validate(Parse(Create()), json.RootElement, Now, Zone);

        AssertError(errors, "", "type_mismatch");
    }

    private static void AssertError(IReadOnlyList<FieldError> errors, string key, string code) =>
        Assert.Contains(errors, e => e.Key == key && e.Code == code);
}
