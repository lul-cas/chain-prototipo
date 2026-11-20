using System.Text.Json;

namespace Chain.Expressions.Tests;

public sealed class DateTimeGrammarTests
{
    [Theory]
    [InlineData("2026-10-15T13:00:00Z", 2026, 10, 15, 13, 0, 0, 0L, 0)]
    [InlineData("2026-10-15T13:00Z", 2026, 10, 15, 13, 0, 0, 0L, 0)]
    [InlineData("2026-10-15T13:00:00-03:00", 2026, 10, 15, 13, 0, 0, 0L, -180)]
    [InlineData("2026-10-15T13:00-03:00", 2026, 10, 15, 13, 0, 0, 0L, -180)]
    [InlineData("2026-10-15T13:00:00+00:00", 2026, 10, 15, 13, 0, 0, 0L, 0)]
    [InlineData("2026-10-15T13:00:00-00:00", 2026, 10, 15, 13, 0, 0, 0L, 0)]
    [InlineData("2026-10-15T13:00:00.1Z", 2026, 10, 15, 13, 0, 0, 1_000_000L, 0)]
    [InlineData("2026-10-15T13:00:00.10Z", 2026, 10, 15, 13, 0, 0, 1_000_000L, 0)]
    [InlineData("2026-10-15T13:00:00.5-03:00", 2026, 10, 15, 13, 0, 0, 5_000_000L, -180)]
    [InlineData("2026-10-15T13:00:00.1234567Z", 2026, 10, 15, 13, 0, 0, 1_234_567L, 0)]
    [InlineData("2026-10-15T13:00:00.0000001Z", 2026, 10, 15, 13, 0, 0, 1L, 0)]
    [InlineData("2026-10-15T13:00:00.1234567+05:30", 2026, 10, 15, 13, 0, 0, 1_234_567L, 330)]
    [InlineData("2024-02-29T00:00:00Z", 2024, 2, 29, 0, 0, 0, 0L, 0)]
    [InlineData("2026-10-15T00:00:00+14:00", 2026, 10, 15, 0, 0, 0, 0L, 840)]
    [InlineData("2026-10-15T00:00:00-14:00", 2026, 10, 15, 0, 0, 0, 0L, -840)]
    [InlineData("0001-01-01T00:00:00Z", 1, 1, 1, 0, 0, 0, 0L, 0)]
    [InlineData("9999-12-31T23:59:59.9999999Z", 9999, 12, 31, 23, 59, 59, 9_999_999L, 0)]
    public void Accepts_the_strict_grammar(string text, int year, int month, int day, int hour, int minute, int second, long subsecondTicks, int offsetMinutes)
    {
        Assert.True(ExprValue.TryParseDateTime(text, out var value));
        Assert.Equal(year, value.Year);
        Assert.Equal(month, value.Month);
        Assert.Equal(day, value.Day);
        Assert.Equal(hour, value.Hour);
        Assert.Equal(minute, value.Minute);
        Assert.Equal(second, value.Second);
        Assert.Equal(subsecondTicks, value.DateTime.Ticks % TimeSpan.TicksPerSecond);
        Assert.Equal(TimeSpan.FromMinutes(offsetMinutes), value.Offset);
    }

    [Theory]
    [InlineData("2026-10-15T13:00:00z")]
    [InlineData("2026-10-15 13:00:00Z")]
    [InlineData("2026-10-15T13:00:00+0300")]
    [InlineData("2026-1-15T03:00:00Z")]
    [InlineData("2026-10-5T03:00:00Z")]
    [InlineData("2026-10-15T3:00:00Z")]
    [InlineData("2026-10-15T03:0:00Z")]
    [InlineData("2026-10-15T03:00:0Z")]
    [InlineData("2026-10-15t13:00:00Z")]
    [InlineData("2026-10-15T13:00:00.12345678Z")]
    [InlineData("2026-10-15T13:00:00.123456789Z")]
    [InlineData("2026-10-15T13:00:00.12345670Z")]
    [InlineData("2026-10-15T13:00:00.00000000Z")]
    [InlineData("2026-10-15T13:00.1Z")]
    [InlineData("2026-10-15T13:00:00.Z")]
    [InlineData("2026-13-01T00:00:00Z")]
    [InlineData("2026-10-15T24:00:00Z")]
    [InlineData("2026-10-15T13:60:00Z")]
    [InlineData("2026-10-15T13:00:60Z")]
    [InlineData("2025-02-29T00:00:00Z")]
    [InlineData("2026-10-15T13:00:00+15:00")]
    [InlineData("2026-10-15T00:00:00+14:01")]
    [InlineData("2026-10-15T00:00:00-14:01")]
    [InlineData(" 2026-10-15T13:00:00Z")]
    [InlineData("2026-10-15T13:00:00Z ")]
    [InlineData("2026-10-15T13:00:00,1Z")]
    [InlineData("2026/10/15T13:00:00Z")]
    [InlineData("2026-10-15T13:00:00")]
    [InlineData("0001-01-01T00:00:00+01:00")]
    [InlineData("9999-12-31T23:00:00-01:00")]
    [InlineData("")]
    public void Rejects_text_outside_the_strict_grammar(string text) =>
        Assert.False(ExprValue.TryParseDateTime(text, out _));

    // In .NET, \d matches every Unicode decimal digit; the grammar takes ASCII digits only, as JavaScript's \d does (#68).
    [Theory]
    [InlineData("\u0662\u0660\u0662\u0666-10-15T13:00:00Z")] // Arabic-Indic year
    [InlineData("2026-\u0661\u0660-15T13:00:00Z")] // month
    [InlineData("2026-10-\u0661\u0665T13:00:00Z")] // day
    [InlineData("2026-10-15T\u0661\u0663:00:00Z")] // hour
    [InlineData("2026-10-15T13:\u0660\u0660:00Z")] // minute
    [InlineData("2026-10-15T13:00:\u0660\u0660Z")] // second
    [InlineData("2026-10-15T13:00:00.\u0661Z")] // fraction: once parsed silently as a wrong instant
    [InlineData("2026-10-15T13:00:00.1\u0967Z")] // Devanagari digit after an ASCII one
    [InlineData("2026-10-15T13:00:00-\u0660\u0663:00")] // offset hours
    [InlineData("2026-10-15T13:00:00-03:\u0660\u0660")] // offset minutes
    [InlineData("\uff12\uff10\uff12\uff16-10-15T13:00:00Z")] // full-width year
    public void Rejects_non_ascii_digits(string text) =>
        Assert.False(ExprValue.TryParseDateTime(text, out _));

    // In .NET, $ also matches before a final newline; JavaScript's does not, so the datetime grammar ends with \z (#81).
    // Date and time text, parsed with TryParseExact, reject the newline too.
    [Theory]
    [InlineData("2026-10-15T13:00:00Z\n")]
    [InlineData("2026-10-15T13:00Z\n")]
    [InlineData("2026-10-15T13:00:00.1234567-03:00\n")]
    [InlineData("2026-10-15\n")]
    [InlineData("09:00\n")]
    [InlineData("09:00:00\n")]
    public void Rejects_a_trailing_newline(string text)
    {
        Assert.False(ExprValue.TryParseDateTime(text, out _));
        Assert.False(ExprValue.TryParseDate(text, out _));
        Assert.False(ExprValue.TryParseTime(text, out _));
    }

    [Theory]
    [InlineData("2026-10-15", true, false, false)]
    [InlineData("09:00", false, true, false)]
    [InlineData("09:00:00", false, true, false)]
    [InlineData("2026-10-15T13:00:00Z", false, false, true)]
    [InlineData("2026-10-15T13:00Z", false, false, true)]
    [InlineData("2026-10-15T13:00:00-03:00", false, false, true)]
    public void Date_time_and_datetime_formats_stay_disjoint(string text, bool date, bool time, bool datetime)
    {
        Assert.Equal(date, ExprValue.TryParseDate(text, out _));
        Assert.Equal(time, ExprValue.TryParseTime(text, out _));
        Assert.Equal(datetime, ExprValue.TryParseDateTime(text, out _));
    }

    [Theory]
    [InlineData("2026-1-15T00:00:00Z")]
    [InlineData("2026-10-5T00:00:00Z")]
    [InlineData("2026-10-15T13:00:00.12345678Z")]
    [InlineData(" 2026-10-15T13:00:00Z")]
    [InlineData("2026-10-15T13:00:00,1Z")]
    [InlineData("2026/10/15T13:00:00Z")]
    [InlineData("2026-10-15T13:00:00z")]
    [InlineData("2026-10-15 13:00:00Z")]
    [InlineData("2026-10-15T13:00:00+0300")]
    [InlineData("2026-13-01T00:00:00Z")]
    public void Datetime_literals_outside_the_grammar_do_not_parse(string text)
    {
        using var document = JsonDocument.Parse($$"""{"kind":"literal","type":"datetime","value":"{{text}}"}""");

        Assert.False(ExpressionParser.ParseValue(document.RootElement).IsSuccess);
    }

    [Fact]
    public void Datetime_literal_with_a_trailing_newline_does_not_parse()
    {
        using var document = JsonDocument.Parse("""{"kind":"literal","type":"datetime","value":"2026-10-15T13:00:00Z\n"}""");

        Assert.False(ExpressionParser.ParseValue(document.RootElement).IsSuccess);
    }

    [Fact]
    public void Datetime_literal_without_seconds_parses()
    {
        using var document = JsonDocument.Parse("""{"kind":"literal","type":"datetime","value":"2026-10-15T13:00Z"}""");
        var parsed = ExpressionParser.ParseValue(document.RootElement);

        Assert.True(parsed.IsSuccess);
        var literal = Assert.IsType<LiteralNode>(parsed.Value);
        Assert.Equal("2026-10-15T13:00:00Z", literal.Value.ToCanonicalString());
    }
}
