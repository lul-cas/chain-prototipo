using System.Text.Json;
using System.Text.Json.Nodes;
using Chain.Expressions;
using Chain.Forms;
using Chain.SharedKernel;
using Chain.Workflows.Definitions;

namespace Chain.Workflows.Application.Engine;

/// <summary>
/// Checks an admin data correction against the pinned version's data catalog (workflow-engine.md §16.3). A key must be one a
/// reachable step can write, and its new value one that at least one of those writers could have produced: a form field with
/// its own rules (<see cref="SubmissionProcessor.Correct"/>), or a sub-workflow or automation output of its type. Values come
/// back normalized, as a submission would store them.
/// </summary>
/// <param name="forms">The pinned form of each step that has one, by node id.</param>
/// <param name="untypedInputs">Q-N10: the keys a child without a start form received as inputs; they take any value.</param>
internal sealed class DataCorrection(
    DataCatalog catalog, IReadOnlyDictionary<string, FormDocument> forms, IReadOnlySet<string> untypedInputs, DateTimeOffset now, TimeSpan zone)
{
    public (List<FieldErrorView> Errors, List<KeyValuePair<string, JsonNode?>> Changes) Check(JsonElement changes, JsonElement data)
    {
        var errors = new List<FieldErrorView>();
        var accepted = new List<KeyValuePair<string, JsonNode?>>();
        if (changes.EnumerateObject().Any(p => !ClientText.IsStorable(p.Name)))
        {
            // The error can't echo a key PostgreSQL cannot store, as results are stored for replay (§16.3, card #129).
            errors.Add(new FieldErrorView(string.Empty, "invalid_value"));
        }

        foreach (var property in changes.EnumerateObject().Where(p => ClientText.IsStorable(p.Name)))
        {
            var before = errors.Count;
            var current = data.TryGetProperty(property.Name, out var stored) && stored.ValueKind != JsonValueKind.Null ? stored : (JsonElement?)null;
            var value = Corrected(property.Name, property.Value, current, errors);
            if (errors.Count == before && value is not null && !ClientText.IsStorableJson(value.ToJsonString()))
            {
                // No form field checked it (a child's input, a key of unknown type, a sub-workflow or automation output): stored as sent.
                errors.Add(new FieldErrorView(property.Name, "invalid_value"));
            }

            if (errors.Count == before)
            {
                accepted.Add(new(property.Name, value));
            }
        }

        return (errors, accepted);
    }

    /// <summary>The value to store (null removes the key), or errors.</summary>
    private JsonNode? Corrected(string key, JsonElement value, JsonElement? current, List<FieldErrorView> errors)
    {
        var writers = Writers(key);
        if (writers.Any(w => w.Field is { Type: ComponentType.Computed }))
        {
            return Fail(errors, key, "computed_field"); // Q-N6: correct the inputs instead
        }

        var removal = value.ValueKind == JsonValueKind.Null;
        if (untypedInputs.Contains(key))
        {
            return removal ? null : JsonNode.Parse(value.GetRawText());
        }

        if (writers.Count == 0)
        {
            return Fail(errors, key, "unknown_field");
        }

        if (writers.Any(w => w.Field is { Type: ComponentType.File } || IsFiles(w.Writer.Type)))
        {
            // Files are not corrected (card #69): only the stored value is accepted.
            var unchanged = removal ? current is null : current is { } stored && JsonElement.DeepEquals(value, stored);
            return unchanged ? (removal ? null : JsonNode.Parse(value.GetRawText())) : Fail(errors, key, "file_field");
        }

        if (removal)
        {
            return writers.Any(w => w.Field is { } field && (field.Validate?.Required ?? false) && field.VisibleWhen is null)
                ? Fail(errors, key, "required")
                : null;
        }

        var type = writers.Select(w => w.Writer.Type).Aggregate(ExprType.Merge);
        if (type.IsUnknown)
        {
            // Writers disagree (TC-3), or an output reads keys its child doesn't know (TC-5): keep the current value's type.
            return current is not { } stored ? Fail(errors, key, "untyped_key")
                : Kind(value) != Kind(stored) ? Fail(errors, key, "type_mismatch")
                : JsonNode.Parse(value.GetRawText());
        }

        IReadOnlyList<FieldError>? rejected = null;
        foreach (var (writer, field) in writers)
        {
            if (field is not null)
            {
                var result = SubmissionProcessor.Correct(field, value, current, now, zone);
                if (result.Errors.Count == 0)
                {
                    return result.Value; // null: an empty answer, which the form doesn't store
                }

                rejected ??= result.Errors;
            }
            else if (Normalized(value, writer.Type) is (true, var normalized))
            {
                return normalized;
            }
        }

        if (rejected is null)
        {
            return Fail(errors, key, "type_mismatch");
        }

        errors.AddRange(rejected.Select(e => new FieldErrorView(e.Key, e.Code))); // the first form writer's findings
        return null;
    }

    /// <summary>The key's writers in document order, with each one's form field; read-only fields never write.</summary>
    private List<(KeyWriter Writer, FormComponent? Field)> Writers(string key)
    {
        var result = new List<(KeyWriter, FormComponent?)>();
        foreach (var writer in catalog.Writers.GetValueOrDefault(key) ?? [])
        {
            if (!forms.TryGetValue(writer.NodeId, out var form))
            {
                result.Add((writer, null)); // a sub-workflow or automation output
            }
            else if (form.Components.FirstOrDefault(c => c.ProducesValue && c.Key == key) is { ReadOnly: false } field)
            {
                result.Add((writer, field));
            }
        }

        return result;
    }

    /// <summary>A value of <paramref name="type"/>, with temporal text in canonical form; false when it doesn't have the type.</summary>
    private static (bool Fits, JsonNode? Value) Normalized(JsonElement value, ExprType type)
    {
        switch (type.Kind)
        {
            case TypeKind.Unknown:
                return (true, JsonNode.Parse(value.GetRawText()));
            case TypeKind.Text when value.ValueKind == JsonValueKind.String:
            case TypeKind.Number when value.ValueKind == JsonValueKind.Number:
            case TypeKind.Boolean when value.ValueKind is JsonValueKind.True or JsonValueKind.False:
                return (true, JsonNode.Parse(value.GetRawText()));
            case TypeKind.Date or TypeKind.Time or TypeKind.DateTime when value.ValueKind == JsonValueKind.String:
                var text = value.GetString()!;
                ExprValue? temporal = type.Kind switch
                {
                    TypeKind.Date when ExprValue.TryParseDate(text, out var date) => new ExprValue.DateValue(date),
                    TypeKind.Time when ExprValue.TryParseTime(text, out var time) => new ExprValue.TimeValue(time),
                    TypeKind.DateTime when ExprValue.TryParseDateTime(text, out var instant) => new ExprValue.DateTimeValue(instant),
                    _ => null,
                };
                return temporal is null ? (false, null) : (true, JsonValue.Create(temporal.ToCanonicalString()));
            case TypeKind.List when value.ValueKind == JsonValueKind.Array:
                var items = new JsonArray();
                foreach (var item in value.EnumerateArray())
                {
                    if (Normalized(item, type.Element!) is not (true, var normalized))
                    {
                        return (false, null);
                    }

                    items.Add(normalized);
                }

                return (true, items);
            case TypeKind.Record when value.ValueKind == JsonValueKind.Object && type.Fields.Count == 0:
                // An object with no declared fields, such as an automation's object output, takes any object (§16.3, card #76).
                return (true, JsonNode.Parse(value.GetRawText()));
            case TypeKind.Record when value.ValueKind == JsonValueKind.Object:
                var record = new JsonObject();
                foreach (var property in value.EnumerateObject().Where(p => p.Value.ValueKind != JsonValueKind.Null))
                {
                    if (!type.Fields.TryGetValue(property.Name, out var field) || Normalized(property.Value, field.Type) is not (true, var normalized))
                    {
                        return (false, null);
                    }

                    record[property.Name] = normalized;
                }

                return type.Fields.Any(f => f.Value.Definite && !record.ContainsKey(f.Key)) ? (false, null) : (true, record);
            default:
                return (false, null); // the wrong kind, or files (card #69)
        }
    }

    private static bool IsFiles(ExprType type) =>
        type.Kind == TypeKind.File || (type.Kind == TypeKind.List && type.Element!.Kind == TypeKind.File);

    /// <summary>The ADR-0003 kind of a JSON value, for keys the catalog can't type.</summary>
    private static JsonValueKind Kind(JsonElement value) => value.ValueKind == JsonValueKind.False ? JsonValueKind.True : value.ValueKind;

    private static JsonNode? Fail(List<FieldErrorView> errors, string key, string code)
    {
        errors.Add(new FieldErrorView(key, code));
        return null;
    }
}
