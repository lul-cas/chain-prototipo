using System.Globalization;
using System.Text.Json;

namespace Chain.SharedKernel;

/// <summary>
/// The guard for client text that PostgreSQL cannot store (identity.md I1; cards #93, #129): the NUL character, which
/// <c>text</c> and <c>jsonb</c> refuse, and an unpaired UTF-16 surrogate, which is not Unicode text. Validators and parsers call
/// it before anything reaches the database, and report a failure with the code of their field.
/// </summary>
public static class ClientText
{
    /// <summary>What a parser says when a document fails <see cref="IsStorableJson"/>.</summary>
    public const string UnstorableMessage = "Text cannot contain the NUL character (\\u0000) or an unpaired surrogate.";

    /// <summary>True when <paramref name="text"/> holds neither NUL nor an unpaired surrogate. Null stores nothing, so it passes.</summary>
    public static bool IsStorable(string? text) =>
        text is null || (!text.Contains('\0', StringComparison.Ordinal) && SurrogatesArePaired(text));

    /// <summary>
    /// True when valid JSON text spells neither NUL nor an unpaired surrogate, in any string or property name. JSON spells them as
    /// <c>\u</c> escapes whose backslash is not itself escaped; the characters themselves are checked too.
    /// </summary>
    public static bool IsStorableJson(string json)
    {
        ArgumentNullException.ThrowIfNull(json);
        return IsStorable(json) && EscapesAreStorable(json, allowNul: false);
    }

    /// <summary>
    /// True when every string and property name of <paramref name="json"/> can be read as Unicode text: no unpaired surrogate
    /// (<c>\ud800</c>) and no bytes that are not UTF-8, which System.Text.Json reads only by throwing. NUL is Unicode, so callers
    /// that store the text still check it.
    /// </summary>
    public static bool IsUnicode(JsonElement json)
    {
        if (json.ValueKind == JsonValueKind.Undefined)
        {
            return true; // no value, so no text
        }

        string text;
        try
        {
            text = json.GetRawText(); // throws when the bytes are not UTF-8
        }
        catch (InvalidOperationException)
        {
            return false;
        }

        return SurrogatesArePaired(text) && EscapesAreStorable(text, allowNul: true);
    }

    /// <summary>True when every surrogate in <paramref name="text"/> is half of a high-low pair.</summary>
    private static bool SurrogatesArePaired(ReadOnlySpan<char> text)
    {
        for (var i = 0; i < text.Length; i++)
        {
            if (char.IsHighSurrogate(text[i]) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]))
            {
                i++;
            }
            else if (char.IsSurrogate(text[i]))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Checks the <c>\uXXXX</c> escapes of valid JSON text: an escaped high surrogate must be followed by an escaped low one, a low
    /// one must follow a high one, and NUL is refused unless <paramref name="allowNul"/>. Other escapes, such as <c>\\</c>, are
    /// skipped whole, so an escaped backslash followed by <c>u0000</c> is text, not NUL.
    /// </summary>
    private static bool EscapesAreStorable(ReadOnlySpan<char> json, bool allowNul)
    {
        var i = 0;
        while (i < json.Length)
        {
            if (json[i] != '\\')
            {
                i++;
                continue;
            }

            if (!TryReadEscape(json, i, out var unit))
            {
                i += 2; // a two-character escape such as \\ or \"
                continue;
            }

            i += 6;
            if (char.IsHighSurrogate(unit))
            {
                if (!TryReadEscape(json, i, out var low) || !char.IsLowSurrogate(low))
                {
                    return false;
                }

                i += 6;
            }
            else if (char.IsLowSurrogate(unit) || (unit == '\0' && !allowNul))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>Reads the code unit of the <c>\uXXXX</c> escape that starts at <paramref name="start"/>.</summary>
    private static bool TryReadEscape(ReadOnlySpan<char> json, int start, out char unit)
    {
        unit = '\0';
        if (start + 6 > json.Length || json[start] != '\\' || json[start + 1] != 'u'
            || !ushort.TryParse(json.Slice(start + 2, 4), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var value))
        {
            return false;
        }

        unit = (char)value;
        return true;
    }
}
