using System.Text.Json;
using System.Text.Json.Nodes;
using Chain.Expressions;
using Chain.SharedKernel;

namespace Chain.Forms;

/// <summary>
/// The outcome of processing a submission: per-field errors and the values to store, with null for each top-level key that an
/// empty answer clears (forms.md §F2).
/// </summary>
public sealed record SubmissionResult(IReadOnlyList<FieldError> Errors, JsonObject Values)
{
    /// <summary>The new files the submission attaches; files sent again are already attached (forms.md F4, card #69).</summary>
    public IReadOnlyList<Guid> FileIds { get; init; } = [];
}

/// <summary>
/// The outcome of checking an admin's corrected value for one top-level field (workflow-engine.md §16.3): per-field errors, or
/// the value to store. A null <see cref="Value"/> without errors means the field stores nothing for it, like an empty answer.
/// </summary>
public sealed record CorrectionResult(IReadOnlyList<FieldError> Errors, JsonNode? Value);

/// <summary>Validation only, without instance data (kept for callers that need just the errors).</summary>
public static class SubmissionValidator
{
    public static IReadOnlyList<FieldError> Validate(FormDocument form, JsonElement submission, DateTimeOffset now, TimeSpan zone) =>
        SubmissionProcessor.Process(form, submission, SubmissionProcessor.EmptyObject, now, zone).Errors;
}

/// <summary>
/// Processes a submission against a pinned form version on the server (ADR-0009 §3; forms.md §F1–§F2): conditions decide
/// visibility and requirement, values are validated, hidden and read-only values are dropped, computed values are filled in,
/// and an empty value sent for a visible, editable top-level field clears it (card #86).
/// </summary>
public static class SubmissionProcessor
{
    public static readonly JsonElement EmptyObject = JsonDocument.Parse("{}").RootElement;

    public static SubmissionResult Process(
        FormDocument form, JsonElement submission, JsonElement instanceData, DateTimeOffset now, TimeSpan zone,
        Guid? actorId = null, IReadOnlyDictionary<Guid, FileBinding>? files = null, int maxFiles = FileRules.MaxFiles)
    {
        ArgumentNullException.ThrowIfNull(form);
        var run = new Run(instanceData, submission, now, zone, actorId, files, maxFiles);
        var values = new JsonObject();
        run.Object(form.Components, submission, prefix: string.Empty, values, current: instanceData);
        run.Compute(values);
        return new SubmissionResult(run.Errors, values) { FileIds = run.FileIds };
    }

    /// <summary>
    /// Checks an admin's corrected value for the top-level <paramref name="field"/> (workflow-engine.md §16.3): the field's type
    /// and own rules at every depth, with the submission's error codes and canonical temporal values. A correction is not a
    /// submission: conditions are not evaluated, so every field is checked as visible and only fields that are required without
    /// a <c>visibleWhen</c> are required; computed fields are not recomputed. Computed and file values must stay as they are in
    /// <paramref name="current"/> (<c>computed_field</c>, <c>file_field</c>), and read-only values are ignored.
    /// </summary>
    public static CorrectionResult Correct(FormComponent field, JsonElement value, JsonElement? current, DateTimeOffset now, TimeSpan zone)
    {
        ArgumentNullException.ThrowIfNull(field);
        var run = new Run(EmptyObject, EmptyObject, now, zone, actorId: null, files: null, FileRules.MaxFiles) { Correcting = true };
        var output = new JsonObject();
        run.Object([field], JsonSerializer.SerializeToElement(new Dictionary<string, JsonElement> { [field.Key!] = value }), string.Empty, output,
            current is { } stored ? JsonSerializer.SerializeToElement(new Dictionary<string, JsonElement> { [field.Key!] = stored }) : null);
        return new CorrectionResult(run.Errors, run.Errors.Count == 0 ? output[field.Key!]?.DeepClone() : null);
    }

    private sealed class Run(
        JsonElement instanceData, JsonElement submission, DateTimeOffset now, TimeSpan zone,
        Guid? actorId, IReadOnlyDictionary<Guid, FileBinding>? files, int maxFiles)
    {
        private readonly EvaluationContext _context = new(Overlay(instanceData, submission), now, zone);
        private readonly List<(FormComponent Field, string Path, JsonObject Target)> _computed = [];
        private readonly HashSet<Guid> _used = [];

        /// <summary>How many dynamic lists hold the object being read: their rows have no identity to merge stored values by.</summary>
        private int _listDepth;

        public List<FieldError> Errors { get; } = [];

        public List<Guid> FileIds { get; } = [];

        /// <summary>An admin correction (workflow-engine.md §16.3) rather than a submission; see <see cref="Correct"/>.</summary>
        public bool Correcting { get; init; }

        /// <param name="current">The stored value at the same path.</param>
        /// <param name="keepStored">
        /// A group outside any dynamic list keeps the stored values of its hidden and read-only fields, since the group is written
        /// whole and such fields never change data (forms.md §F2 "Groups and lists"; owner decision Q2 B, card #137).
        /// </param>
        public void Object(IReadOnlyList<FormComponent> components, JsonElement value, string prefix, JsonObject output, JsonElement? current = null, bool keepStored = false)
        {
            if (value.ValueKind != JsonValueKind.Object)
            {
                Error(prefix, "type_mismatch");
                return;
            }

            var fields = components.Where(c => c.ProducesValue && c.Key is not null).ToDictionary(c => c.Key!, StringComparer.Ordinal);
            var unstorableKey = false;
            foreach (var property in value.EnumerateObject().Where(p => !fields.ContainsKey(p.Name)))
            {
                if (ClientText.IsStorable(property.Name))
                {
                    Error(Path(prefix, property.Name), "unknown_field");
                }
                else
                {
                    unstorableKey = true;
                }
            }

            if (unstorableKey)
            {
                // The error can't echo a key PostgreSQL cannot store, as results are stored for replay: the object holding it is
                // invalid instead (forms.md §F1, card #129).
                Error(prefix, "invalid_value");
            }

            foreach (var field in fields.Values)
            {
                var path = Path(prefix, field.Key!);
                var stored = Child(current, field.Key!);
                if (!Correcting && !Holds(field.VisibleWhen, path, onError: true))
                {
                    Keep(field, stored, output, keepStored);
                    continue; // hidden: not validated, not stored
                }

                var sent = value.TryGetProperty(field.Key!, out var fieldValue);
                var present = sent && fieldValue.ValueKind != JsonValueKind.Null;
                if (field.Type == ComponentType.Computed)
                {
                    if (Correcting)
                    {
                        KeepAsStored(field, present ? fieldValue : null, stored, path, output, "computed_field");
                    }
                    else
                    {
                        _computed.Add((field, path, output));
                    }

                    continue;
                }

                if (field.ReadOnly)
                {
                    Keep(field, stored, output, keepStored && !Correcting);
                    continue; // prefilled on the server; client values are ignored
                }

                var required = Correcting
                    ? (field.Validate?.Required ?? false) && field.VisibleWhen is null
                    : (field.Validate?.Required ?? false) || Holds(field.RequiredWhen, path, onError: true, absent: false);
                var before = Errors.Count;
                Field(field, present ? fieldValue : null, path, required, output, stored);
                if (sent && prefix.Length == 0 && Errors.Count == before && !output.ContainsKey(field.Key!))
                {
                    output[field.Key!] = null; // an empty answer clears the stored value (forms.md §F2 "Empty values"; card #86)
                }
            }
        }

        /// <summary>Fills computed fields in document order from the stored values (later ones see earlier ones).</summary>
        public void Compute(JsonObject values)
        {
            foreach (var (field, path, target) in _computed)
            {
                try
                {
                    var tree = ExpressionParser.ParseValue(field.Expression!.Value);
                    if (!tree.IsSuccess)
                    {
                        Error(path, "expression_error");
                        continue;
                    }

                    var context = new EvaluationContext(Overlay(instanceData, JsonSerializer.SerializeToElement(values)), now, zone);
                    var result = Evaluator.Evaluate(tree.Value!, context);
                    var json = ToJson(result);
                    if (json is not null)
                    {
                        target[field.Key!] = json;
                    }
                    else if (result is ExprValue.MissingValue)
                    {
                        if (ReferenceEquals(target, values))
                        {
                            // A missing result clears the stored value, as an empty answer does (forms.md §F2; owner decision
                            // Q1 B, card #137). Inside a group or a row, leaving the key out of what is written clears it.
                            target[field.Key!] = null;
                        }
                    }
                    else
                    {
                        Error(path, "expression_error");
                    }
                }
                catch (ExpressionException)
                {
                    Error(path, "expression_error");
                }
            }
        }

        /// <summary>Evaluates an optional condition; an evaluation error is reported and counts as <paramref name="onError"/>.</summary>
        private bool Holds(JsonElement? condition, string path, bool onError, bool absent = true)
        {
            if (condition is not { } tree)
            {
                return absent;
            }

            try
            {
                var parsed = ExpressionParser.ParseCondition(tree);
                if (parsed.IsSuccess)
                {
                    return Evaluator.Evaluate(parsed.Condition!, _context);
                }
            }
            catch (ExpressionException)
            {
            }

            Error(path, "expression_error");
            return onError;
        }

        private void Field(FormComponent field, JsonElement? value, string path, bool required, JsonObject output, JsonElement? current)
        {
            var rules = field.Validate ?? new FieldValidation();
            switch (field.Type)
            {
                case ComponentType.Group:
                    var group = new JsonObject();
                    Object(field.Components!, value ?? EmptyObject, path, group, current, keepStored: _listDepth == 0 && !Correcting);
                    output[field.Key!] = group;
                    return;
                case ComponentType.DynamicList:
                    List(field, value, path, rules, output, current);
                    return;
                case ComponentType.Checklist:
                    if (Checklist(field, value, path, rules, required))
                    {
                        output[field.Key!] = JsonNode.Parse(value!.Value.GetRawText());
                    }

                    return;
                case ComponentType.File when Correcting:
                    KeepAsStored(field, value, current, path, output, "file_field"); // files are not corrected (card #69)
                    return;
                case ComponentType.File:
                    FileField(field, value, path, required, output);
                    return;
            }

            if (IsEmpty(field.Type, value))
            {
                if (required)
                {
                    Error(path, "required");
                }

                return;
            }

            var v = value!.Value;
            var before = Errors.Count;
            string? canonical = null;
            switch (field.Type)
            {
                case ComponentType.Text or ComponentType.Textarea:
                    Text(v, path, rules);
                    break;
                case ComponentType.Number:
                    Number(v, path, rules);
                    break;
                case ComponentType.Checkbox when v.ValueKind is not (JsonValueKind.True or JsonValueKind.False):
                    Error(path, "type_mismatch");
                    break;
                case ComponentType.Select or ComponentType.Radio:
                    if (v.ValueKind != JsonValueKind.String)
                    {
                        Error(path, "type_mismatch");
                    }
                    else if (!field.Options!.Any(o => o.Value == v.GetString()))
                    {
                        Error(path, "invalid_option");
                    }

                    break;
                case ComponentType.Date or ComponentType.Time or ComponentType.Datetime:
                    canonical = CanonicalTemporal(field.Type, v, path, rules);
                    break;
            }

            if (Errors.Count == before)
            {
                output[field.Key!] = canonical is null ? JsonNode.Parse(v.GetRawText()) : JsonValue.Create(canonical);
            }
        }

        private void Text(JsonElement value, string path, FieldValidation rules)
        {
            if (value.ValueKind != JsonValueKind.String)
            {
                Error(path, "type_mismatch");
                return;
            }

            var text = value.GetString()!;
            if (!ClientText.IsStorable(text))
            {
                Error(path, "invalid_value"); // text PostgreSQL cannot store (cards #93, #129)
                return;
            }

            if (text.Length < rules.MinLength)
            {
                Error(path, "too_short");
            }

            if (text.Length > rules.MaxLength)
            {
                Error(path, "too_long");
            }

            var formatOk = rules.Format is not { } format || Formats.IsValid(format, text);
            var patternOk = rules.Pattern is not { } pattern || Patterns.IsMatch(pattern, text, out _);
            if (!formatOk || !patternOk)
            {
                Error(path, "invalid_format");
            }
        }

        private void Number(JsonElement value, string path, FieldValidation rules)
        {
            if (value.ValueKind != JsonValueKind.Number || !value.TryGetDecimal(out var number))
            {
                Error(path, "type_mismatch");
                return;
            }

            var min = rules.Min is { } m && m.TryGetDecimal(out var parsedMin) ? parsedMin : (decimal?)null;
            var max = rules.Max is { } x && x.TryGetDecimal(out var parsedMax) ? parsedMax : (decimal?)null;
            if (number < min)
            {
                Error(path, "too_small");
            }

            if (number > max)
            {
                Error(path, "too_large");
            }

            if (rules.DecimalDigits is { } digits && number.Scale > digits && decimal.Round(number, digits) != number)
            {
                Error(path, "too_many_decimals");
            }

            if (rules.Step is { } step && (number - (min ?? 0)) % step != 0)
            {
                Error(path, "invalid_step");
            }
        }

        private string? CanonicalTemporal(ComponentType type, JsonElement value, string path, FieldValidation rules)
        {
            var text = value.ValueKind == JsonValueKind.String ? value.GetString()! : string.Empty;
            switch (type)
            {
                case ComponentType.Date when ExprValue.TryParseDate(text, out var date):
                    Compare(date, rules.Min is { } min ? DateBounds.ResolveDate(min, now, zone) : null, rules.Max is { } max ? DateBounds.ResolveDate(max, now, zone) : null, path);
                    return new ExprValue.DateValue(date).ToCanonicalString();
                case ComponentType.Time when ExprValue.TryParseTime(text, out var time):
                    Compare(time, rules.Min is { } tmin ? DateBounds.ResolveTime(tmin) : null, rules.Max is { } tmax ? DateBounds.ResolveTime(tmax) : null, path);
                    return new ExprValue.TimeValue(time).ToCanonicalString();
                case ComponentType.Datetime when ExprValue.TryParseDateTime(text, out var instant):
                    Compare(instant, rules.Min is { } dmin ? DateBounds.ResolveDateTime(dmin, now) : null, rules.Max is { } dmax ? DateBounds.ResolveDateTime(dmax, now) : null, path);
                    return new ExprValue.DateTimeValue(instant).ToCanonicalString();
                default:
                    Error(path, "type_mismatch");
                    return null;
            }
        }

        private void Compare<T>(T value, T? min, T? max, string path)
            where T : struct, IComparable<T>
        {
            if (min is { } lower && value.CompareTo(lower) < 0)
            {
                Error(path, "too_early");
            }

            if (max is { } upper && value.CompareTo(upper) > 0)
            {
                Error(path, "too_late");
            }
        }

        /// <summary>Returns true when the checklist value is valid and should be stored; an empty one stores nothing.</summary>
        private bool Checklist(FormComponent field, JsonElement? value, string path, FieldValidation rules, bool required)
        {
            if (value is null)
            {
                if (required)
                {
                    Error(path, "required");
                }

                return false;
            }

            if (value.Value.ValueKind != JsonValueKind.Array || value.Value.EnumerateArray().Any(e => e.ValueKind != JsonValueKind.String))
            {
                Error(path, "type_mismatch");
                return false;
            }

            var before = Errors.Count;
            var selected = value.Value.EnumerateArray().Select(e => e.GetString()!).ToList();
            if (selected.Count == 0 && required)
            {
                Error(path, "required");
            }

            if (selected.Any(s => !field.Options!.Any(o => o.Value == s)))
            {
                Error(path, "invalid_option");
            }

            Counts(selected.Count, rules.MinSelected, rules.MaxSelected, path);
            return Errors.Count == before && selected.Count > 0;
        }

        private void FileField(FormComponent field, JsonElement? value, string path, bool required, JsonObject output)
        {
            if (value is null)
            {
                if (required)
                {
                    Error(path, "required");
                }

                return;
            }

            if (value.Value.ValueKind != JsonValueKind.Array)
            {
                Error(path, "type_mismatch");
                return;
            }

            var items = value.Value.EnumerateArray().ToList();
            if (items.Count == 0)
            {
                if (required)
                {
                    Error(path, "required");
                }

                return;
            }

            var before = Errors.Count;
            var cap = Math.Min(field.Validate?.MaxFiles ?? maxFiles, maxFiles);
            if (items.Count > cap)
            {
                Error(path, "too_many");
            }

            var stored = new JsonArray();
            var accepted = new List<Guid>();
            var accept = field.Validate?.Accept;
            foreach (var item in items)
            {
                if (item.ValueKind != JsonValueKind.Object || !item.TryGetProperty("fileId", out var raw) || raw.ValueKind != JsonValueKind.String
                    || !Guid.TryParse(raw.GetString(), out var id))
                {
                    Error(path, "type_mismatch");
                    continue;
                }

                // A new file is pending and the actor's own; a file already attached to this instance may be sent again (card #69).
                if (files is null || actorId is null || !_used.Add(id) || !files.TryGetValue(id, out var binding)
                    || !(binding.AttachedToThisInstance || (binding.IsPending && binding.UploadedBy == actorId)))
                {
                    Error(path, "file_invalid");
                    continue;
                }

                if (accept is { Count: > 0 } && !accept.Contains(binding.ContentType, StringComparer.Ordinal))
                {
                    Error(path, "file_type_not_allowed");
                    continue;
                }

                if (binding.IsPending)
                {
                    accepted.Add(id); // a file sent again stays bound to its first submission
                }

                stored.Add(new JsonObject
                {
                    ["fileId"] = id.ToString("D"),
                    ["name"] = binding.Name,
                    ["size"] = binding.Size,
                    ["contentType"] = binding.ContentType,
                });
            }

            if (Errors.Count == before)
            {
                output[field.Key!] = stored;
                FileIds.AddRange(accepted);
            }
        }

        private void List(FormComponent field, JsonElement? value, string path, FieldValidation rules, JsonObject output, JsonElement? current)
        {
            if (value is null)
            {
                return;
            }

            if (value.Value.ValueKind != JsonValueKind.Array)
            {
                Error(path, "type_mismatch");
                return;
            }

            var rows = value.Value.EnumerateArray().ToList();
            Counts(rows.Count, rules.MinRows, rules.MaxRows, path);
            var stored = current is { ValueKind: JsonValueKind.Array } list ? list.EnumerateArray().ToList() : [];
            var array = new JsonArray();
            _listDepth++;
            for (var i = 0; i < rows.Count; i++)
            {
                var row = new JsonObject();
                Object(field.Components!, rows[i], $"{path}[{i}]", row, i < stored.Count ? stored[i] : null);
                array.Add(row);
            }

            _listDepth--;

            output[field.Key!] = array;
        }

        /// <summary>
        /// A correction leaves computed and file values as stored (workflow-engine.md §16.3): the corrected value must equal the
        /// stored one at the same path (rows by position), and may be left out only where nothing is stored.
        /// </summary>
        private void KeepAsStored(FormComponent field, JsonElement? value, JsonElement? stored, string path, JsonObject output, string code)
        {
            var unchanged = (value, stored) switch
            {
                ({ } given, { } kept) => JsonElement.DeepEquals(given, kept),
                (null, null) => true,
                _ => false,
            };
            if (!unchanged)
            {
                Error(path, code);
            }
            else if (value is { } kept)
            {
                output[field.Key!] = JsonNode.Parse(kept.GetRawText());
            }
        }

        /// <summary>Writes a hidden or read-only field's stored value back, when its group keeps it (see <c>keepStored</c>).</summary>
        private static void Keep(FormComponent field, JsonElement? stored, JsonObject output, bool keep)
        {
            if (keep && stored is { } value)
            {
                output[field.Key!] = JsonNode.Parse(value.GetRawText());
            }
        }

        private static JsonElement? Child(JsonElement? parent, string key) =>
            parent is { ValueKind: JsonValueKind.Object } obj && obj.TryGetProperty(key, out var child) && child.ValueKind != JsonValueKind.Null
                ? child
                : null;

        private void Counts(int count, int? min, int? max, string path)
        {
            if (count < min)
            {
                Error(path, "too_few");
            }

            if (count > max)
            {
                Error(path, "too_many");
            }
        }

        private static bool IsEmpty(ComponentType type, JsonElement? value) =>
            value is not { } v
            || (v.ValueKind == JsonValueKind.String && v.GetString()!.Length == 0)
            || (type == ComponentType.Checkbox && v.ValueKind == JsonValueKind.False);

        private void Error(string path, string code) => Errors.Add(new FieldError(path, code));

        private static string Path(string prefix, string key) => prefix.Length == 0 ? key : $"{prefix}.{key}";

        /// <summary>Instance data with the submitted top-level values on top (submitted values win; forms.md §F2).</summary>
        private static JsonElement Overlay(JsonElement data, JsonElement top)
        {
            var merged = data.ValueKind == JsonValueKind.Object ? JsonNode.Parse(data.GetRawText())!.AsObject() : [];
            if (top.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in top.EnumerateObject())
                {
                    merged[property.Name] = JsonNode.Parse(property.Value.GetRawText());
                }
            }

            return JsonSerializer.SerializeToElement(merged);
        }

        private static JsonValue? ToJson(ExprValue value) => value switch
        {
            ExprValue.NumberValue number => JsonValue.Create(number.Value),
            ExprValue.TextValue text => JsonValue.Create(text.Value),
            ExprValue.BoolValue flag => JsonValue.Create(flag.Value),
            ExprValue.DateValue or ExprValue.DateTimeValue or ExprValue.TimeValue => JsonValue.Create(value.ToCanonicalString()),
            _ => null,
        };
    }
}
