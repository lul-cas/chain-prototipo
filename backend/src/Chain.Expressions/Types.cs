namespace Chain.Expressions;

// Static types of the language (expression-language.md §2), used by the publish-time type checker
// and the data catalog (workflow-definition.md §6).

public enum TypeKind
{
    Unknown, Text, Number, Boolean, Date, DateTime, Time, File, List, Record,
}

/// <summary>A field of an object type: its type, and whether it is always present when the object is.</summary>
public sealed record FieldType(ExprType Type, bool Definite);

/// <summary>
/// A static type. <see cref="Unknown"/> is compatible with everything; lists carry an element type and objects their fields.
/// Equality is structural.
/// </summary>
public sealed class ExprType : IEquatable<ExprType>
{
    private static readonly IReadOnlyDictionary<string, FieldType> NoFields = new Dictionary<string, FieldType>(StringComparer.Ordinal);

    private ExprType(TypeKind kind, ExprType? element, IReadOnlyDictionary<string, FieldType>? fields)
    {
        Kind = kind;
        Element = element;
        Fields = fields ?? NoFields;
    }

    public static ExprType Unknown { get; } = new(TypeKind.Unknown, null, null);

    public static ExprType Text { get; } = new(TypeKind.Text, null, null);

    public static ExprType Number { get; } = new(TypeKind.Number, null, null);

    public static ExprType Boolean { get; } = new(TypeKind.Boolean, null, null);

    public static ExprType Date { get; } = new(TypeKind.Date, null, null);

    public static ExprType DateTime { get; } = new(TypeKind.DateTime, null, null);

    public static ExprType Time { get; } = new(TypeKind.Time, null, null);

    public static ExprType File { get; } = new(TypeKind.File, null, null);

    public TypeKind Kind { get; }

    /// <summary>The element type of a list; null for other kinds.</summary>
    public ExprType? Element { get; }

    /// <summary>The fields of an object; empty for other kinds.</summary>
    public IReadOnlyDictionary<string, FieldType> Fields { get; }

    public bool IsUnknown => Kind == TypeKind.Unknown;

    public bool IsTemporal => Kind is TypeKind.Date or TypeKind.DateTime or TypeKind.Time;

    public bool IsScalar => Kind is TypeKind.Text or TypeKind.Number or TypeKind.Boolean or TypeKind.Date or TypeKind.DateTime or TypeKind.Time;

    public static ExprType ListOf(ExprType element)
    {
        ArgumentNullException.ThrowIfNull(element);
        return new(TypeKind.List, element, null);
    }

    public static ExprType ObjectOf(IReadOnlyDictionary<string, FieldType> fields)
    {
        ArgumentNullException.ThrowIfNull(fields);
        return new(TypeKind.Record, null, new Dictionary<string, FieldType>(fields, StringComparer.Ordinal));
    }

    /// <summary>
    /// The type of a key that may hold either value: equal types stay, lists merge their elements, objects merge field by
    /// field (a field missing on one side is no longer definite), and anything else is <see cref="Unknown"/> (§6.1).
    /// </summary>
    public static ExprType Merge(ExprType a, ExprType b)
    {
        ArgumentNullException.ThrowIfNull(a);
        ArgumentNullException.ThrowIfNull(b);
        if (a.Kind != b.Kind || a.IsUnknown)
        {
            return Unknown;
        }

        return a.Kind switch
        {
            TypeKind.List => ListOf(Merge(a.Element!, b.Element!)),
            TypeKind.Record => ObjectOf(MergeFields(a.Fields, b.Fields)),
            _ => a,
        };
    }

    private static Dictionary<string, FieldType> MergeFields(IReadOnlyDictionary<string, FieldType> a, IReadOnlyDictionary<string, FieldType> b)
    {
        var merged = new Dictionary<string, FieldType>(StringComparer.Ordinal);
        foreach (var name in a.Keys.Union(b.Keys, StringComparer.Ordinal))
        {
            merged[name] = (a.TryGetValue(name, out var left), b.TryGetValue(name, out var right)) switch
            {
                (true, true) => new FieldType(Merge(left!.Type, right!.Type), left.Definite && right.Definite),
                (true, false) => left! with { Definite = false },
                _ => right! with { Definite = false },
            };
        }

        return merged;
    }

    public bool Equals(ExprType? other) =>
        other is not null
        && Kind == other.Kind
        && Equals(Element, other.Element)
        && Fields.Count == other.Fields.Count
        && Fields.All(f => other.Fields.TryGetValue(f.Key, out var o) && f.Value == o);

    public override bool Equals(object? obj) => obj is ExprType other && Equals(other);

    public override int GetHashCode() => HashCode.Combine(Kind, Element, Fields.Count);

    /// <summary>The type's name as the catalog shows it: <c>text</c>, <c>list&lt;number&gt;</c>, <c>object</c>, <c>unknown</c>…</summary>
    public override string ToString() => Kind switch
    {
        TypeKind.List => $"list<{Element}>",
        TypeKind.DateTime => "datetime",
        TypeKind.Record => "object",
        _ => Kind.ToString().ToLowerInvariant(),
    };
}
