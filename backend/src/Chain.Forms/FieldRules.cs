using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Chain.Expressions;

namespace Chain.Forms;

/// <summary>Built-in text formats (ADR-0009 F-3; forms.md §F1).</summary>
public static partial class Formats
{
    public static readonly IReadOnlySet<string> Known = new HashSet<string>(StringComparer.Ordinal) { "email", "cpf", "cnpj", "phone", "cep" };

    public static bool IsValid(string format, string value) => format switch
    {
        "email" => value.Length <= 254 && Email().IsMatch(value),
        "cpf" => Cpf(value),
        "cnpj" => Cnpj(value),
        "phone" => Phone(value),
        "cep" => Cep().IsMatch(value),
        _ => false,
    };

    private static bool Cpf(string value)
    {
        if (!CpfShape().IsMatch(value))
        {
            return false;
        }

        var digits = Digits(value);
        return digits.Length == 11 && digits.Distinct().Count() > 1
            && CheckDigit(digits, 9, 10) == digits[9] && CheckDigit(digits, 10, 11) == digits[10];
    }

    private static bool Cnpj(string value)
    {
        if (!CnpjShape().IsMatch(value))
        {
            return false;
        }

        var digits = Digits(value);
        int[] first = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
        int[] second = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
        return digits.Length == 14 && digits.Distinct().Count() > 1
            && WeightedDigit(digits, first) == digits[12] && WeightedDigit(digits, second) == digits[13];
    }

    private static bool Phone(string value)
    {
        if (!PhoneShape().IsMatch(value))
        {
            return false;
        }

        var digits = Digits(value);
        if (value.TrimStart().StartsWith('+'))
        {
            if (!digits.StartsWith("55", StringComparison.Ordinal))
            {
                return false;
            }

            digits = digits[2..];
        }

        return digits.Length is 10 or 11;
    }

    private static string Digits(string value) => new([.. value.Where(char.IsAsciiDigit)]);

    /// <summary>CPF check digit over the first <paramref name="count"/> digits, weights starting at <paramref name="startWeight"/>.</summary>
    private static char CheckDigit(string digits, int count, int startWeight)
    {
        var sum = 0;
        for (var i = 0; i < count; i++)
        {
            sum += (digits[i] - '0') * (startWeight - i);
        }

        var rest = sum * 10 % 11;
        return (char)('0' + (rest == 10 ? 0 : rest));
    }

    private static char WeightedDigit(string digits, int[] weights)
    {
        var sum = 0;
        for (var i = 0; i < weights.Length; i++)
        {
            sum += (digits[i] - '0') * weights[i];
        }

        var rest = sum % 11;
        return (char)('0' + (rest < 2 ? 0 : 11 - rest));
    }

    // Whitespace that .NET and JavaScript both count. Their \s differ: only .NET's matches U+0085, only JavaScript's U+FEFF (#124).
    private const string Whitespace = @"\t\n\v\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000";

    // An email refuses whitespace in either reading, so U+0085 and U+FEFF too (#124).
    private const string EmailPart = "[^@" + Whitespace + @"\u0085\uFEFF]+";

    // \z: $ would also match before a trailing newline, which the browser's $ does not (#81).
    [GeneratedRegex("^" + EmailPart + "@" + EmailPart + @"\." + EmailPart + @"\z", RegexOptions.CultureInvariant, 100)]
    private static partial Regex Email();

    [GeneratedRegex(@"^[0-9]{3}\.?[0-9]{3}\.?[0-9]{3}-?[0-9]{2}\z", RegexOptions.CultureInvariant, 100)]
    private static partial Regex CpfShape();

    [GeneratedRegex(@"^[0-9]{2}\.?[0-9]{3}\.?[0-9]{3}/?[0-9]{4}-?[0-9]{2}\z", RegexOptions.CultureInvariant, 100)]
    private static partial Regex CnpjShape();

    // A phone's separators are whitespace both read alike, never U+0085 or U+FEFF (#124).
    // A phone's only separator is the plain space, besides its punctuation (owner, 2026-10-19, #124).
    [GeneratedRegex(@"^\+?[0-9() \-]{8,20}\z", RegexOptions.CultureInvariant, 100)]
    private static partial Regex PhoneShape();

    [GeneratedRegex(@"^[0-9]{5}-?[0-9]{3}\z", RegexOptions.CultureInvariant, 100)]
    private static partial Regex Cep();
}

/// <summary>
/// Modeler-written patterns (ADR-0009 F-3): a subset that behaves the same in .NET and browsers, matched against the
/// whole value, with a 100 ms timeout so a catastrophic pattern cannot slow the server.
/// </summary>
public static partial class Patterns
{
    public const int MaxLength = 500;
    public static readonly TimeSpan Timeout = TimeSpan.FromMilliseconds(100);

    /// <summary>Returns null when the pattern is acceptable, or the reason it is not.</summary>
    public static string? Check(string pattern)
    {
        if (pattern.Length > MaxLength)
        {
            return $"Patterns are limited to {MaxLength} characters.";
        }

        if (PatternSubset.FirstRefused(pattern) is { } refused)
        {
            return refused.Replacement is null
                ? $"Patterns may not use '{refused.Construct}' (forms.md F1)."
                : $"Patterns may not use '{refused.Construct}' (forms.md F1): write {refused.Replacement} instead.";
        }

        return Compiles(pattern) && Compiles(Anchored(pattern)) ? null : "The pattern does not compile.";
    }

    /// <summary>
    /// True when the whole value matches; a timeout counts as no match (<paramref name="timedOut"/> is set). A pattern that does
    /// not compile on its own matches no value, as in the browser; only a version published before FM005 checked it holds one.
    /// </summary>
    public static bool IsMatch(string pattern, string value, out bool timedOut)
    {
        timedOut = false;
        if (!Compiles(pattern))
        {
            return false;
        }

        try
        {
            return Regex.IsMatch(value, Anchored(pattern), RegexOptions.CultureInvariant, Timeout);
        }
        catch (RegexMatchTimeoutException)
        {
            timedOut = true;
            return false;
        }
    }

    // On its own as well as wrapped: unbalanced parentheses such as a)|(?:b compile only inside the wrap, where they split the
    // anchors (#125).
    private static bool Compiles(string pattern)
    {
        try
        {
            _ = new Regex(pattern, RegexOptions.CultureInvariant, Timeout);
            return true;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    // \z: $ would also match before a trailing newline, which the browser's pattern attribute does not (#81).
    private static string Anchored(string pattern) => $@"^(?:{EndAnchors(pattern)})\z";

    /// <summary>
    /// The pattern with every <c>$</c> that .NET reads as an anchor written as <c>\z</c>, so that it means the end of the value,
    /// as in the browser: .NET's <c>$</c> also matches before a final newline (#125). Escapes, character classes and comments
    /// are skipped as .NET's parser reads them, so <c>\$</c>, <c>[$]</c> and <c>(?#$)</c> stay as they are.
    /// </summary>
    private static string EndAnchors(string pattern)
    {
        var result = new StringBuilder(pattern.Length);
        var i = 0;
        while (i < pattern.Length)
        {
            var next = pattern[i] switch
            {
                '\\' => AfterEscape(pattern, i),
                '[' => AfterClass(pattern, i),
                '(' when pattern.AsSpan(i).StartsWith("(?#", StringComparison.Ordinal) => AfterComment(pattern, i),
                _ => i + 1,
            };
            if (pattern[i] == '$')
            {
                result.Append(@"\z");
            }
            else
            {
                result.Append(pattern, i, next - i);
            }

            i = next;
        }

        return result.ToString();
    }

    /// <summary>The index after the escape at <paramref name="i"/>. <c>\c</c> takes one more character: <c>\c\</c> is U+001C.</summary>
    private static int AfterEscape(string pattern, int i) =>
        Math.Min(pattern.Length, i + (i + 1 < pattern.Length && pattern[i + 1] == 'c' ? 3 : 2));

    /// <summary>
    /// The index after the character class at <paramref name="i"/>, read as .NET reads it: a <c>]</c> right after <c>[</c> or
    /// <c>[^</c> is literal, and <c>-[</c> after the first character opens a subtracted class, as in <c>[a-z-[aeiou]]</c>.
    /// </summary>
    private static int AfterClass(string pattern, int i)
    {
        i++;
        if (i < pattern.Length && pattern[i] == '^')
        {
            i++;
        }

        for (var first = true; i < pattern.Length; first = false)
        {
            switch (pattern[i])
            {
                case ']' when !first:
                    return i + 1;
                case '\\':
                    i = AfterEscape(pattern, i);
                    break;
                case '-' when !first && i + 1 < pattern.Length && pattern[i + 1] == '[':
                    i = AfterClass(pattern, i + 1);
                    break;
                default:
                    i++;
                    break;
            }
        }

        return pattern.Length;
    }

    /// <summary>The index after the comment at <paramref name="i"/>, which runs from <c>(?#</c> to the first <c>)</c>.</summary>
    private static int AfterComment(string pattern, int i)
    {
        var close = pattern.IndexOf(')', i + 3);
        return close < 0 ? pattern.Length : close + 1;
    }

}

/// <summary>
/// Date and time bounds: absolute ISO text, or <c>{ "system": "currentDate" | "currentDateTime", "offset": { amount, unit } }</c>
/// evaluated in the evaluation zone (ADR-0003 §2–§3a).
/// </summary>
public static class DateBounds
{
    private static readonly string[] DateUnits = ["days", "months", "years"];
    private static readonly string[] DateTimeUnits = ["days", "months", "years", "hours", "minutes"];

    public static bool TryParseDate(string text, out DateOnly date) =>
        DateOnly.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out date);

    public static bool TryParseTime(string text, out TimeOnly time) =>
        TimeOnly.TryParseExact(text, ["HH:mm", "HH:mm:ss"], CultureInfo.InvariantCulture, DateTimeStyles.None, out time);

    public static bool TryParseDateTime(string text, out DateTimeOffset value) =>
        ExprValue.TryParseDateTime(text, out value);

    /// <summary>Checks a bound's shape for a date, time or datetime field (FM004).</summary>
    public static bool IsValid(JsonElement bound, ComponentType type) => bound.ValueKind switch
    {
        JsonValueKind.String => type switch
        {
            ComponentType.Date => TryParseDate(bound.GetString()!, out _),
            ComponentType.Time => TryParseTime(bound.GetString()!, out _),
            ComponentType.Datetime => TryParseDateTime(bound.GetString()!, out _),
            _ => false,
        },
        JsonValueKind.Object => type != ComponentType.Time && IsValidRelative(bound, type),
        _ => false,
    };

    public static DateOnly ResolveDate(JsonElement bound, DateTimeOffset now, TimeSpan zone)
    {
        if (bound.ValueKind == JsonValueKind.String)
        {
            _ = TryParseDate(bound.GetString()!, out var absolute);
            return absolute;
        }

        var today = DateOnly.FromDateTime(now.ToOffset(zone).DateTime);
        return Offset(bound) is var (amount, unit) ? unit switch
        {
            "days" => today.AddDays(amount),
            "months" => today.AddMonths(amount),
            _ => today.AddYears(amount),
        } : today;
    }

    public static DateTimeOffset ResolveDateTime(JsonElement bound, DateTimeOffset now)
    {
        if (bound.ValueKind == JsonValueKind.String)
        {
            _ = TryParseDateTime(bound.GetString()!, out var absolute);
            return absolute;
        }

        return Offset(bound) is var (amount, unit) ? unit switch
        {
            "days" => now.AddDays(amount),
            "months" => now.AddMonths(amount),
            "years" => now.AddYears(amount),
            "hours" => now.AddHours(amount),
            _ => now.AddMinutes(amount),
        } : now;
    }

    public static TimeOnly ResolveTime(JsonElement bound)
    {
        _ = TryParseTime(bound.GetString() ?? string.Empty, out var time);
        return time;
    }

    private static bool IsValidRelative(JsonElement bound, ComponentType type)
    {
        var expected = type == ComponentType.Date ? "currentDate" : "currentDateTime";
        foreach (var property in bound.EnumerateObject())
        {
            if (property.Name is not ("system" or "offset"))
            {
                return false;
            }
        }

        if (!bound.TryGetProperty("system", out var system) || system.ValueKind != JsonValueKind.String || system.GetString() != expected)
        {
            return false;
        }

        if (!bound.TryGetProperty("offset", out var offset))
        {
            return true;
        }

        // The kinds are checked first: TryGetInt32 and GetString throw on other kinds, and a draft is any JSON (#238).
        var units = type == ComponentType.Date ? DateUnits : DateTimeUnits;
        return offset.ValueKind == JsonValueKind.Object
            && offset.TryGetProperty("amount", out var amount) && amount.ValueKind == JsonValueKind.Number
            && amount.TryGetInt32(out var n) && n is >= -10_000 and <= 10_000 // Math.Abs(int.MinValue) would overflow
            && offset.TryGetProperty("unit", out var unit) && unit.ValueKind == JsonValueKind.String && units.Contains(unit.GetString())
            && offset.EnumerateObject().Count() == 2;
    }

    private static (int Amount, string Unit)? Offset(JsonElement bound) =>
        bound.TryGetProperty("offset", out var offset)
            ? (offset.GetProperty("amount").GetInt32(), offset.GetProperty("unit").GetString()!)
            : null;
}
