namespace Chain.Forms;

/// <summary>The first construct of a pattern the allowlist refuses, and what to write instead when something does the same.</summary>
public sealed record RefusedConstruct(string Construct, string? Replacement);

/// <summary>
/// The pattern allowlist of forms.md F1 (FM005; owner decision on card #149): only constructs that .NET and JavaScript read
/// alike. Literals and escaped punctuation; <c>\t</c>, <c>\n</c>, <c>\r</c>, <c>\xHH</c> and <c>\uHHHH</c>; classes and
/// ranges, negated or not; the quantifiers and their lazy forms; groups, non-capturing groups and alternation; <c>^</c>,
/// <c>$</c> and lookahead. The designer runs the same scan (<c>pattern-subset.ts</c>) over the same vectors. A pattern this
/// accepts may still not compile, which <see cref="Patterns.Check"/> checks apart.
/// </summary>
public static class PatternSubset
{
    private static readonly Dictionary<char, string> Replacements = new()
    {
        ['d'] = "[0-9]",
        ['D'] = "[^0-9]",
        ['w'] = "[a-zA-Z0-9_]",
        ['W'] = "[^a-zA-Z0-9_]",
        ['s'] = "[ \\t\\n\\r]",
        ['S'] = "[^ \\t\\n\\r]",
        ['A'] = "^",
        ['z'] = "$",
        ['Z'] = "$",
        ['e'] = "\\x1B",
        ['f'] = "\\x0C",
        ['v'] = "\\x0B",
        ['0'] = "\\x00",
    };

    /// <summary>Null when every construct is allowed; otherwise the first one that isn't, as written.</summary>
    public static RefusedConstruct? FirstRefused(string pattern)
    {
        ArgumentNullException.ThrowIfNull(pattern);
        var lookaheads = new Stack<bool>(); // for each open group, whether it is a lookahead
        var repeatable = false; // whether a quantifier may follow
        var i = 0;
        while (i < pattern.Length)
        {
            var c = pattern[i];
            switch (c)
            {
                case '\\':
                    var (escapeLength, refusedEscape) = Escape(pattern, i);
                    if (refusedEscape is not null)
                    {
                        return refusedEscape;
                    }

                    i += escapeLength;
                    repeatable = true;
                    break;
                case '[':
                    var (classRefused, classEnd) = Class(pattern, i);
                    if (classRefused is not null)
                    {
                        return classRefused;
                    }

                    i = classEnd;
                    repeatable = true;
                    break;
                case '(':
                    if (i + 1 < pattern.Length && pattern[i + 1] == '?')
                    {
                        var kind = i + 2 < pattern.Length ? pattern[i + 2] : '\0';
                        if (kind is not (':' or '=' or '!'))
                        {
                            var construct = kind == '<' && i + 3 < pattern.Length && pattern[i + 3] is '=' or '!' ? pattern.Substring(i, 4) : pattern.Substring(i, Math.Min(3, pattern.Length - i));
                            return new RefusedConstruct(construct, null);
                        }

                        lookaheads.Push(kind is '=' or '!');
                        i += 3;
                    }
                    else
                    {
                        lookaheads.Push(false);
                        i++;
                    }

                    repeatable = false;
                    break;
                case ')':
                    // A lone ) is left to the compile check, which refuses it.
                    repeatable = !(lookaheads.Count > 0 && lookaheads.Pop());
                    i++;
                    break;
                case '|' or '^' or '$':
                    repeatable = false;
                    i++;
                    break;
                case '.':
                    return new RefusedConstruct(".", "[^\\n]");
                case '*' or '+' or '?':
                    if (!repeatable)
                    {
                        return new RefusedConstruct(c.ToString(), null);
                    }

                    i = Lazy(pattern, i + 1);
                    repeatable = false;
                    break;
                case '{':
                    if (Quantifier(pattern, i) is not { } end || !repeatable)
                    {
                        return new RefusedConstruct("{", "\\{");
                    }

                    i = Lazy(pattern, end);
                    repeatable = false;
                    break;
                case ']' or '}':
                    return new RefusedConstruct(c.ToString(), $"\\{c}");
                default:
                    repeatable = true;
                    i++;
                    break;
            }
        }

        return null;
    }

    /// <summary>The escape at <paramref name="i"/>: its length, or why it is refused.</summary>
    private static (int Length, RefusedConstruct? Refused) Escape(string pattern, int i)
    {
        if (i + 1 >= pattern.Length)
        {
            return (1, null); // a trailing \ doesn't compile, which the compile check refuses
        }

        var next = pattern[i + 1];
        switch (next)
        {
            case 't' or 'n' or 'r':
                return (2, null);
            case 'x':
                return Hex(pattern, i + 2, 2) ? (4, null) : (2, new RefusedConstruct("\\x", null));
            case 'u':
                return Hex(pattern, i + 2, 4) ? (6, null) : (2, new RefusedConstruct("\\u", null));
        }

        if (next is >= '!' and <= '~' && !char.IsAsciiLetterOrDigit(next))
        {
            return (2, null); // escaped punctuation
        }

        var replacement = Replacements.TryGetValue(next, out var known) ? known : !char.IsAsciiLetterOrDigit(next) ? next.ToString() : null;
        return (2, new RefusedConstruct($"\\{next}", replacement));
    }

    /// <summary>The class at <paramref name="i"/>: why it is refused, or the index after its <c>]</c>.</summary>
    private static (RefusedConstruct? Refused, int End) Class(string pattern, int i)
    {
        var j = i + 1;
        if (j < pattern.Length && pattern[j] == '^')
        {
            j++;
        }

        if (j < pattern.Length && pattern[j] == ']')
        {
            return (new RefusedConstruct(pattern[i..(j + 1)], null), j);
        }

        while (j < pattern.Length && pattern[j] != ']')
        {
            switch (pattern[j])
            {
                case '\\':
                    var (length, refused) = Escape(pattern, j);
                    if (refused is not null)
                    {
                        return (refused, j);
                    }

                    j += length;
                    break;
                case '[':
                    return (new RefusedConstruct("[", "\\["), j);
                default:
                    j++;
                    break;
            }
        }

        return (null, j + 1); // an unclosed class doesn't compile, which the compile check refuses
    }

    /// <summary>The index after a quantifier <c>{n}</c>, <c>{n,}</c> or <c>{n,m}</c> at <paramref name="i"/>; null when there is none.</summary>
    private static int? Quantifier(string pattern, int i)
    {
        var j = i + 1;
        var digits = Digits(pattern, j);
        if (digits == 0)
        {
            return null;
        }

        j += digits;
        if (j < pattern.Length && pattern[j] == ',')
        {
            j++;
            j += Digits(pattern, j);
        }

        return j < pattern.Length && pattern[j] == '}' ? j + 1 : null;
    }

    private static int Digits(string pattern, int i)
    {
        var j = i;
        while (j < pattern.Length && char.IsAsciiDigit(pattern[j]))
        {
            j++;
        }

        return j - i;
    }

    /// <summary>After a quantifier, the lazy <c>?</c> when there is one.</summary>
    private static int Lazy(string pattern, int i) => i < pattern.Length && pattern[i] == '?' ? i + 1 : i;

    private static bool Hex(string pattern, int i, int count) =>
        i + count <= pattern.Length && pattern.Substring(i, count).All(char.IsAsciiHexDigit);
}
