using System.Globalization;
using System.Text.RegularExpressions;

namespace Chain.Expressions;

internal static partial class IsoDateTime
{
    public static bool TryParse(string text, out DateTimeOffset value)
    {
        value = default;
        Match match;
        try
        {
            match = Pattern().Match(text);
        }
        catch (RegexMatchTimeoutException)
        {
            return false;
        }

        if (!match.Success)
        {
            return false;
        }

        var year = Read(match.Groups["year"].ValueSpan);
        var month = Read(match.Groups["month"].ValueSpan);
        var day = Read(match.Groups["day"].ValueSpan);
        var hour = Read(match.Groups["hour"].ValueSpan);
        var minute = Read(match.Groups["minute"].ValueSpan);
        if (year is < 1 or > 9999 || month is < 1 or > 12 || hour > 23 || minute > 59 || day < 1 || day > DateTime.DaysInMonth(year, month))
        {
            return false;
        }

        var second = 0;
        if (match.Groups["second"].Success)
        {
            second = Read(match.Groups["second"].ValueSpan);
            if (second > 59)
            {
                return false;
            }
        }

        var fractionTicks = match.Groups["fraction"].Success ? FractionTicks(match.Groups["fraction"].ValueSpan) : 0L;
        var sign = 1;
        var offsetHours = 0;
        var offsetMinutes = 0;
        var offset = match.Groups["offset"].ValueSpan;
        if (!offset.SequenceEqual("Z"))
        {
            sign = offset[0] == '-' ? -1 : 1;
            offsetHours = Read(offset[1..3]);
            offsetMinutes = Read(offset[4..6]);
            if (offsetMinutes > 59 || offsetHours > 14 || (offsetHours == 14 && offsetMinutes != 0))
            {
                return false;
            }
        }

        try
        {
            var clock = new DateTime(year, month, day, hour, minute, second, DateTimeKind.Unspecified).AddTicks(fractionTicks);
            value = new DateTimeOffset(clock, new TimeSpan(sign * offsetHours, sign * offsetMinutes, 0));
            return true;
        }
        catch (ArgumentOutOfRangeException)
        {
            value = default;
            return false;
        }
    }

    private static int Read(ReadOnlySpan<char> text) => int.Parse(text, NumberStyles.None, CultureInfo.InvariantCulture);

    private static long FractionTicks(ReadOnlySpan<char> digits)
    {
        var ticks = 0L;
        foreach (var digit in digits)
        {
            ticks = (ticks * 10) + (digit - '0');
        }

        for (var i = digits.Length; i < 7; i++)
        {
            ticks *= 10;
        }

        return ticks;
    }

    // \z: $ would also match before a trailing newline, which JavaScript's $ does not (#81).
    [GeneratedRegex(@"^(?<year>[0-9]{4})-(?<month>[0-9]{2})-(?<day>[0-9]{2})T(?<hour>[0-9]{2}):(?<minute>[0-9]{2})(?::(?<second>[0-9]{2})(?:\.(?<fraction>[0-9]{1,7}))?)?(?<offset>Z|[+-][0-9]{2}:[0-9]{2})\z", RegexOptions.CultureInvariant, 100)]
    private static partial Regex Pattern();
}
