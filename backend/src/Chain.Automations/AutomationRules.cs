using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Chain.Automations;

/// <summary>
/// The rules of automation documents: the structural rules AU001–AU012 (automation.md §5.3) and the reference rules AU101–AU106
/// checked at publish (§5.4). Each returns every finding.
/// </summary>
public static partial class AutomationRules
{
    public const int MaxFields = 50;
    public const int MaxPathLength = 2000;
    public const int MaxQueryNameLength = 100;
    public const int MaxHeaders = 30;
    public const int MaxOutputPathSegments = 20;
    public const int MaxIdempotencyHeaderLength = 100;

    private const string SecretOpening = "{{secret:";
    private const int MaxTypeNameLength = 100;

    private static readonly string[] Methods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
    private static readonly string[] ScalarTypes = ["text", "number", "boolean", "date", "datetime", "time"];
    private static readonly JsonSerializerOptions SerializerOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    /// <summary>The headers ADR-0012 Part 3 §3 treats as credentials, whose values hold a placeholder (AU013).</summary>
    private static readonly HashSet<string> CredentialHeaders = new(["Authorization", "Cookie", "X-Api-Key"], StringComparer.OrdinalIgnoreCase);

    /// <summary>Set by the HTTP client, never by a definition (AU006).</summary>
    private static readonly HashSet<string> ReservedHeaders =
        new(["Host", "Content-Length", "Transfer-Encoding", "Connection", "Upgrade", "TE", "Trailer"], StringComparer.OrdinalIgnoreCase);

    // Structural rules (§5.3)

    public static IReadOnlyList<AutomationIssue> Validate(AutomationDocument document)
    {
        ArgumentNullException.ThrowIfNull(document);
        var issues = new List<AutomationIssue>();
        var execution = EffectiveExecution.Of(document.Execution);
        var inputs = CheckFields(document.Inputs.Select(input => (input.Key, input.Type)).ToList(), "inputs", issues);
        CheckFields(document.Outputs.Select(output => (output.Key, output.Type)).ToList(), "outputs", issues);
        CheckMethod(document.Request, issues);
        CheckPath(document.Request.Path, inputs, issues);
        CheckQuery(document.Request.Query, inputs, issues);
        CheckHeaders(document.Request.Headers, execution, issues);
        CheckPlaceholders(document, issues);
        CheckAuth(document.Request, issues);
        CheckLiteralCredentials(document.Request, issues);
        CheckBody(document.Request.Body, inputs, issues);
        CheckOutputs(document, issues);
        CheckExecution(execution, issues);
        CheckIdempotency(document.Execution?.Idempotency, issues);
        return issues;
    }

    /// <summary>AU001 and AU002. Returns the type of each well-formed key, first occurrence first.</summary>
    private static Dictionary<string, string> CheckFields(List<(string Key, string Type)> fields, string list, List<AutomationIssue> issues)
    {
        var types = new Dictionary<string, string>(StringComparer.Ordinal);
        if (fields.Count > MaxFields)
        {
            issues.Add(new("AU001", $"An automation has at most {MaxFields} {list}.", list));
        }

        for (var i = 0; i < fields.Count; i++)
        {
            var (key, type) = fields[i];
            var at = $"{list}[{i}]";
            if (!KeyFormat().IsMatch(key))
            {
                issues.Add(new("AU001", "A key is a letter followed by up to 63 letters, digits or underscores.", $"{at}.key"));
            }
            else if (!types.TryAdd(key, type))
            {
                issues.Add(new("AU001", $"The key '{key}' is used more than once in {list}.", $"{at}.key"));
            }

            if (!IsTypeName(type))
            {
                issues.Add(new("AU002", $"'{type}' is not a type: use text, number, boolean, date, datetime, time, object, unknown or list<T>.", $"{at}.type"));
            }
        }

        return types;
    }

    private static bool IsTypeName(string type) => type switch
    {
        "text" or "number" or "boolean" or "date" or "datetime" or "time" or "object" or "unknown" => true,
        _ => type.Length <= MaxTypeNameLength && type.StartsWith("list<", StringComparison.Ordinal) && type.EndsWith('>') && IsTypeName(type[5..^1]),
    };

    /// <summary>AU003.</summary>
    private static void CheckMethod(AutomationRequest request, List<AutomationIssue> issues)
    {
        if (!Methods.Contains(request.Method, StringComparer.Ordinal))
        {
            issues.Add(new("AU003", "The method is GET, POST, PUT, PATCH or DELETE.", "request.method"));
        }
        else if (request.Method is "GET" or "DELETE" && request.Body is not null)
        {
            issues.Add(new("AU003", $"A {request.Method} request has no body.", "request.body"));
        }
    }

    /// <summary>
    /// AU004. Besides the rules of §5.3, the literal text must be a URL path (RFC 3986 path characters and percent-encoded bytes,
    /// but no encoded '.', '/' or '\', which a server could decode to climb past the destination's prefix).
    /// </summary>
    private static void CheckPath(string path, Dictionary<string, string> inputs, List<AutomationIssue> issues)
    {
        void Fail(string message) => issues.Add(new("AU004", message, "request.path"));

        if (!path.StartsWith('/') || path.Length > MaxPathLength)
        {
            Fail($"The path starts with '/' and has at most {MaxPathLength} characters.");
        }

        if (path.Split('/').Contains(".."))
        {
            Fail("The path has no '..' segment.");
        }

        for (var i = 0; i < path.Length; i++)
        {
            var c = path[i];
            if (c == '{')
            {
                var end = path.IndexOf('}', i + 1);
                var key = end < 0 ? null : path[(i + 1)..end];
                if (key is null || !KeyFormat().IsMatch(key))
                {
                    Fail("Braces in the path hold an input key, as in {cpf}.");
                    return;
                }

                CheckTemplate(key, inputs, "AU004", "request.path", "a path", issues);
                i = end;
            }
            else if (c == '%')
            {
                if (i + 2 >= path.Length || !char.IsAsciiHexDigit(path[i + 1]) || !char.IsAsciiHexDigit(path[i + 2]))
                {
                    Fail("A '%' in the path starts a percent-encoded byte, as in %20.");
                    return;
                }

                if (path.Substring(i + 1, 2).ToUpperInvariant() is "2E" or "2F" or "5C")
                {
                    Fail("The path cannot percent-encode '.', '/' or '\\'.");
                    return;
                }

                i += 2;
            }
            else if (!IsPathCharacter(c))
            {
                Fail(c switch
                {
                    '?' => "The path has no '?': put parameters in request.query.",
                    '#' => "The path has no '#' fragment.",
                    _ when char.IsControl(c) => "The path has no control characters.",
                    _ => $"'{TextElementAt(path, i)}' cannot appear in a path; percent-encode it (RFC 3986).",
                });
                return;
            }
        }
    }

    /// <summary>
    /// The text element (grapheme cluster) that holds <c>text[index]</c>, so a message quotes a character whole: an emoji, a
    /// flag or a letter with its combining accent, never half of a surrogate pair (#127).
    /// </summary>
    private static string TextElementAt(string text, int index)
    {
        var start = 0;
        var length = StringInfo.GetNextTextElementLength(text, start);
        while (start + length <= index)
        {
            start += length;
            length = StringInfo.GetNextTextElementLength(text, start);
        }

        return text.Substring(start, length);
    }

    /// <summary>RFC 3986 <c>pchar</c> or <c>/</c>, without the percent sign: unreserved, sub-delims, ':' and '@'.</summary>
    private static bool IsPathCharacter(char c) =>
        char.IsAsciiLetterOrDigit(c) || c is '-' or '.' or '_' or '~' or '!' or '$' or '&' or '\'' or '(' or ')' or '*' or '+' or ',' or ';' or '=' or ':' or '@' or '/';

    /// <summary>A <c>{key}</c> template names a scalar input (AU004, AU005).</summary>
    private static void CheckTemplate(string key, Dictionary<string, string> inputs, string code, string at, string where, List<AutomationIssue> issues)
    {
        if (!inputs.TryGetValue(key, out var type))
        {
            issues.Add(new(code, $"'{{{key}}}' is not an input.", at));
        }
        else if (!ScalarTypes.Contains(type, StringComparer.Ordinal))
        {
            issues.Add(new(code, $"'{{{key}}}' is a {type} input; only text, number, boolean, date, datetime and time inputs fit in {where}.", at));
        }
    }

    /// <summary>AU005. A value is a literal, or exactly one <c>{key}</c>; braces around a key anywhere else are refused as ambiguous.</summary>
    private static void CheckQuery(IReadOnlyDictionary<string, string> query, Dictionary<string, string> inputs, List<AutomationIssue> issues)
    {
        foreach (var (name, value) in query)
        {
            var at = $"request.query.{name}";
            if (name.Length is 0 or > MaxQueryNameLength)
            {
                issues.Add(new("AU005", $"A query name has 1 to {MaxQueryNameLength} characters.", at));
            }

            if (name.Contains(SecretOpening, StringComparison.Ordinal) || value.Contains(SecretOpening, StringComparison.Ordinal))
            {
                issues.Add(new("AU005", "Secrets cannot appear in the query.", at));
            }

            if (WholeTemplate().Match(value) is { Success: true } template)
            {
                CheckTemplate(template.Groups[1].Value, inputs, "AU005", at, "a query", issues);
            }
            else if (InputReference().IsMatch(value))
            {
                issues.Add(new("AU005", "A query value is literal text or exactly one {input}.", at));
            }
        }
    }

    /// <summary>AU006. Names are also unique ignoring case, since HTTP header names are case-insensitive.</summary>
    private static void CheckHeaders(IReadOnlyDictionary<string, string> headers, EffectiveExecution execution, List<AutomationIssue> issues)
    {
        if (headers.Count > MaxHeaders)
        {
            issues.Add(new("AU006", $"An automation sets at most {MaxHeaders} headers.", "request.headers"));
        }

        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (name, value) in headers)
        {
            var at = $"request.headers.{name}";
            if (!IsToken(name))
            {
                issues.Add(new("AU006", "A header name is an HTTP token (RFC 9110).", at));
            }
            else if (ReservedHeaders.Contains(name) || name.StartsWith("Proxy-", StringComparison.OrdinalIgnoreCase))
            {
                issues.Add(new("AU006", $"The HTTP client sets '{name}'; a definition cannot.", at));
            }
            else if (execution.IdempotencyMode == "header" && string.Equals(name, execution.IdempotencyHeader, StringComparison.OrdinalIgnoreCase))
            {
                issues.Add(new("AU006", $"'{name}' carries the idempotency key (execution.idempotency).", at));
            }

            if (!seen.Add(name))
            {
                issues.Add(new("AU006", $"The header '{name}' is set more than once.", at));
            }

            if (!IsHeaderValue(value))
            {
                issues.Add(new("AU006", "A header value holds only visible ASCII characters, spaces and tabs (RFC 9110).", at));
            }

            if (InputReference().IsMatch(value))
            {
                issues.Add(new("AU006", "Header values cannot use inputs in this version (automation.md AU-4).", at));
            }
        }
    }

    /// <summary>AU007: placeholders are complete, and only in header values and basic-auth fields.</summary>
    private static void CheckPlaceholders(AutomationDocument document, List<AutomationIssue> issues)
    {
        foreach (var (name, value) in document.Request.Headers)
        {
            CheckPlaceholderSyntax(value, $"request.headers.{name}", issues);
        }

        if (document.Request.Auth is { } auth)
        {
            CheckPlaceholderSyntax(auth.Username, "request.auth.username", issues);
            CheckPlaceholderSyntax(auth.Password, "request.auth.password", issues);
        }

        FindPlaceholdersElsewhere(JsonSerializer.SerializeToElement(document, SerializerOptions), string.Empty, issues);
    }

    private static void CheckPlaceholderSyntax(string text, string at, List<AutomationIssue> issues)
    {
        var start = 0;
        while ((start = text.IndexOf(SecretOpening, start, StringComparison.Ordinal)) >= 0)
        {
            var placeholder = PlaceholderAt().Match(text, start);
            if (!placeholder.Success)
            {
                issues.Add(new("AU007", "Write a secret as {{secret:name}}, with a secret's name.", at));
                return;
            }

            start += placeholder.Length;
        }
    }

    private static void FindPlaceholdersElsewhere(JsonElement node, string at, List<AutomationIssue> issues)
    {
        switch (node.ValueKind)
        {
            case JsonValueKind.Object:
                foreach (var property in node.EnumerateObject())
                {
                    var child = at.Length == 0 ? property.Name : $"{at}.{property.Name}";
                    if (property.Name.Contains(SecretOpening, StringComparison.Ordinal))
                    {
                        issues.Add(new("AU007", "Secrets appear only in header values and basic-auth fields.", child));
                    }

                    FindPlaceholdersElsewhere(property.Value, child, issues);
                }

                break;
            case JsonValueKind.Array:
                var index = 0;
                foreach (var item in node.EnumerateArray())
                {
                    FindPlaceholdersElsewhere(item, $"{at}[{index++}]", issues);
                }

                break;
            case JsonValueKind.String when node.GetString()!.Contains(SecretOpening, StringComparison.Ordinal) && !AllowsSecrets(at):
                issues.Add(new("AU007", "Secrets appear only in header values and basic-auth fields.", at));
                break;
        }
    }

    private static bool AllowsSecrets(string at) =>
        at is "request.auth.username" or "request.auth.password" || at.StartsWith("request.headers.", StringComparison.Ordinal);

    /// <summary>
    /// AU008. An <c>Authorization</c> header beside <c>auth</c> would send two credentials, so the pair is refused. Servers split
    /// the credentials at the first ':' (RFC 7617), so the username has none; the ':' of <c>{{secret:</c> does not count, and a
    /// secret's value is checked when the step runs (automation-contract.md §3). Neither holds a control character, C0, DEL or
    /// C1, as <see cref="char.IsControl(char)"/> reads them (RFC 7617; owner decision, card #128).
    /// </summary>
    private static void CheckAuth(AutomationRequest request, List<AutomationIssue> issues)
    {
        if (request.Auth is not { } auth)
        {
            return;
        }

        if (auth.Type != "basic")
        {
            issues.Add(new("AU008", "Authentication is basic.", "request.auth.type"));
        }

        if (auth.Username.Length == 0 || auth.Password.Length == 0)
        {
            issues.Add(new("AU008", "Basic authentication has a username and a password.", "request.auth"));
        }

        if (auth.Username.Replace(SecretOpening, string.Empty, StringComparison.Ordinal).Contains(':', StringComparison.Ordinal))
        {
            issues.Add(new("AU008", "The username has no ':' (RFC 7617).", "request.auth.username"));
        }

        if (auth.Username.Any(char.IsControl))
        {
            issues.Add(new("AU008", "The username has no control characters (RFC 7617).", "request.auth.username"));
        }

        if (auth.Password.Any(char.IsControl))
        {
            issues.Add(new("AU008", "The password has no control characters (RFC 7617).", "request.auth.password"));
        }

        if (request.Headers.Keys.Any(name => string.Equals(name, "Authorization", StringComparison.OrdinalIgnoreCase)))
        {
            issues.Add(new("AU008", "Use auth or an Authorization header, not both.", "request.auth"));
        }
    }

    /// <summary>
    /// AU013: no credential written out (owner decision Q-AS4 (c), card #235). A basic-auth password, and the value of a header
    /// that carries credentials, hold a <c>{{secret:</c> placeholder; a malformed one is AU007's alone, and an empty password
    /// AU008's. ADR-0012 keeps credentials out of definitions, and a literal one would travel in the payload too.
    /// </summary>
    private static void CheckLiteralCredentials(AutomationRequest request, List<AutomationIssue> issues)
    {
        foreach (var (name, value) in request.Headers)
        {
            if (CredentialHeaders.Contains(name) && !value.Contains(SecretOpening, StringComparison.Ordinal))
            {
                issues.Add(new("AU013", $"The header '{name}' holds a {{{{secret:…}}}} credential, not a literal one (ADR-0012).", $"request.headers.{name}"));
            }
        }

        if (request.Auth is { Password.Length: > 0 } auth && !auth.Password.Contains(SecretOpening, StringComparison.Ordinal))
        {
            issues.Add(new("AU013", "The password holds a {{secret:…}} credential, not a literal one (ADR-0012).", "request.auth.password"));
        }
    }

    /// <summary>AU009.</summary>
    private static void CheckBody(RequestBody? body, Dictionary<string, string> inputs, List<AutomationIssue> issues)
    {
        if (body is null)
        {
            return;
        }

        if (body.Type != "json")
        {
            issues.Add(new("AU009", "The body type is json.", "request.body.type"));
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < (body.Keys?.Count ?? 0); i++)
        {
            var key = body.Keys![i];
            if (!inputs.ContainsKey(key))
            {
                issues.Add(new("AU009", $"'{key}' is not an input.", $"request.body.keys[{i}]"));
            }
            else if (!seen.Add(key))
            {
                issues.Add(new("AU009", $"'{key}' is listed more than once.", $"request.body.keys[{i}]"));
            }
        }
    }

    /// <summary>AU010, and the response type (json or none) that body outputs depend on.</summary>
    private static void CheckOutputs(AutomationDocument document, List<AutomationIssue> issues)
    {
        if (document.Response.Type is not ("json" or "none"))
        {
            issues.Add(new("AU010", "The response type is json or none.", "response.type"));
        }

        for (var i = 0; i < document.Outputs.Count; i++)
        {
            var output = document.Outputs[i];
            var at = $"outputs[{i}]";
            switch (output.Source)
            {
                case "body":
                    if (output.Path is not { Count: > 0 and <= MaxOutputPathSegments } path)
                    {
                        issues.Add(new("AU010", $"A body output reads a path of 1 to {MaxOutputPathSegments} segments.", $"{at}.path"));
                    }
                    else if (!path.All(IsOutputPathSegment))
                    {
                        issues.Add(new("AU010", "A path segment is a property name or an array index from 0.", $"{at}.path"));
                    }

                    if (document.Response.Type != "json")
                    {
                        issues.Add(new("AU010", "Outputs read from the body need response type json.", $"{at}.source"));
                    }

                    break;
                case "status":
                    if (output.Type != "number")
                    {
                        issues.Add(new("AU010", "The status is a number output.", $"{at}.type"));
                    }

                    if (output.Path is not null)
                    {
                        issues.Add(new("AU010", "A status output has no path.", $"{at}.path"));
                    }

                    break;
                default:
                    issues.Add(new("AU010", "An output's source is body or status.", $"{at}.source"));
                    break;
            }
        }
    }

    private static bool IsOutputPathSegment(JsonElement segment) => segment.ValueKind switch
    {
        JsonValueKind.String => segment.GetString()!.Length > 0,
        JsonValueKind.Number => segment.TryGetInt32(out var index) && index >= 0,
        _ => false,
    };

    /// <summary>AU011. Without <c>follow</c>, <c>max</c> stays 0, so a document never states a limit it does not apply.</summary>
    private static void CheckExecution(EffectiveExecution execution, List<AutomationIssue> issues)
    {
        if (execution.TimeoutSeconds is < 1 or > 300)
        {
            issues.Add(new("AU011", "timeoutSeconds is 1 to 300.", "execution.timeoutSeconds"));
        }

        if (execution.MaxAttempts is < 1 or > 10)
        {
            issues.Add(new("AU011", "maxAttempts is 1 to 10.", "execution.retry.maxAttempts"));
        }

        if (execution.InitialDelaySeconds is < 1 or > 60)
        {
            issues.Add(new("AU011", "initialDelaySeconds is 1 to 60.", "execution.retry.initialDelaySeconds"));
        }

        if (execution.FollowRedirects ? execution.MaxRedirects is < 1 or > 3 : execution.MaxRedirects != 0)
        {
            issues.Add(new("AU011", "redirects.max is 1 to 3 when follow is true, and 0 otherwise.", "execution.redirects.max"));
        }
    }

    /// <summary>AU012. A header beside mode <c>none</c> is refused rather than ignored.</summary>
    private static void CheckIdempotency(IdempotencyPolicy? policy, List<AutomationIssue> issues)
    {
        if (policy is null)
        {
            return;
        }

        switch (policy.Mode)
        {
            case "header" when policy.Header is { } header && (header.Length > MaxIdempotencyHeaderLength || !IsToken(header)):
                issues.Add(new("AU012", $"The idempotency header is an HTTP token of at most {MaxIdempotencyHeaderLength} characters.", "execution.idempotency.header"));
                return;
            case "header":
                return;
            case "none" when policy.Header is not null:
                issues.Add(new("AU012", "With mode none, no idempotency header is sent.", "execution.idempotency.header"));
                return;
            case "none":
                return;
            default:
                issues.Add(new("AU012", "The idempotency mode is header or none.", "execution.idempotency.mode"));
                return;
        }
    }

    /// <summary>
    /// AU006: what the HTTP client sends as a header value, visible ASCII, spaces and tabs (RFC 9110 field values without obs-text).
    /// Elixir checks the payload the same way (automation-contract.md §3). Placeholders are visible ASCII, so they pass.
    /// </summary>
    private static bool IsHeaderValue(string text) => text.All(c => c is '\t' or (>= ' ' and <= '~'));

    /// <summary>An RFC 9110 token: one or more <c>tchar</c>.</summary>
    private static bool IsToken(string text) =>
        text.Length > 0 && text.All(c => char.IsAsciiLetterOrDigit(c) || c is '!' or '#' or '$' or '%' or '&' or '\'' or '*' or '+' or '-' or '.' or '^' or '_' or '`' or '|' or '~');

    // Reference rules (§5.4)

    /// <summary>
    /// AU101–AU106 against the current destination (null when it does not exist) and the allowed destinations of each secret,
    /// by name. Without a destination only AU101 and AU102 apply.
    /// </summary>
    public static IReadOnlyList<AutomationIssue> CheckReferences(
        AutomationDocument document, Destination? destination, IReadOnlyDictionary<string, IReadOnlyList<string>> secrets)
    {
        ArgumentNullException.ThrowIfNull(document);
        ArgumentNullException.ThrowIfNull(secrets);
        var issues = new List<AutomationIssue>();
        if (destination is null)
        {
            issues.Add(new("AU101", document.Request.Destination.Length == 0
                ? "Choose a destination."
                : $"The destination '{document.Request.Destination}' does not exist.", "request.destination"));
        }

        var used = SecretsOf(document);
        foreach (var name in used)
        {
            if (!secrets.TryGetValue(name, out var allowed))
            {
                issues.Add(new("AU102", $"The secret '{name}' does not exist.", "request"));
            }
            else if (destination is not null)
            {
                issues.AddRange(CheckSecret(document, name, allowed));
            }
        }

        if (destination is not null)
        {
            issues.AddRange(CheckDestination(document, destination));
        }

        return issues;
    }

    /// <summary>
    /// AU103 for one secret: if the document uses <paramref name="secret"/>, its destination must be in
    /// <paramref name="allowedDestinations"/>. It is the only reference rule a change of a secret's allowed destinations can break,
    /// so such a change is checked with it against the published versions that use the secret (automation.md §4.2, card #206).
    /// </summary>
    public static IReadOnlyList<AutomationIssue> CheckSecret(AutomationDocument document, string secret, IReadOnlyList<string> allowedDestinations)
    {
        ArgumentNullException.ThrowIfNull(document);
        ArgumentNullException.ThrowIfNull(allowedDestinations);
        var destination = document.Request.Destination;
        return SecretsOf(document).Contains(secret, StringComparer.Ordinal) && !allowedDestinations.Contains(destination, StringComparer.Ordinal)
            ? [new("AU103", $"The secret '{secret}' is not allowed for the destination '{destination}'.", "request")]
            : [];
    }

    /// <summary>
    /// AU104–AU106: what the destination's settings require of the document. These are the only reference rules a change of the
    /// destination can break, so a change is checked with them against the published versions that call it (automation.md §3.2).
    /// </summary>
    public static IReadOnlyList<AutomationIssue> CheckDestination(AutomationDocument document, Destination destination)
    {
        ArgumentNullException.ThrowIfNull(document);
        ArgumentNullException.ThrowIfNull(destination);
        var issues = new List<AutomationIssue>();
        if (destination.Scheme == "http" && SecretsOf(document).Count > 0 && !destination.AllowSecretsOverHttp)
        {
            issues.Add(new("AU104", $"'{destination.Name}' uses plain http and does not allow secrets over it.", "request.destination"));
        }

        if (!WithinPrefix(document.Request.Path, destination.PathPrefix))
        {
            issues.Add(new("AU105", $"The path must stay within '{destination.PathPrefix}', the destination's prefix.", "request.path"));
        }

        CheckHost(document.Request.Host, destination.Host, issues);
        return issues;
    }

    /// <summary>The secrets a document references, by well-formed placeholder, each once in ordinal order.</summary>
    public static IReadOnlyList<string> SecretsOf(AutomationDocument document)
    {
        ArgumentNullException.ThrowIfNull(document);
        var names = new SortedSet<string>(StringComparer.Ordinal);
        var texts = document.Request.Headers.Values.Concat(document.Request.Auth is { } auth ? [auth.Username, auth.Password] : []);
        foreach (var text in texts)
        {
            foreach (Match placeholder in Placeholder().Matches(text))
            {
                names.Add(placeholder.Groups[1].Value);
            }
        }

        return [.. names];
    }

    /// <summary>
    /// AU105: the path equals the prefix (with or without its final '/'), or its literal text before the first '{' continues
    /// the prefix after a '/'. A prefix of "/" admits every path.
    /// </summary>
    private static bool WithinPrefix(string path, string? prefix)
    {
        var root = prefix?.TrimEnd('/');
        if (string.IsNullOrEmpty(root))
        {
            return true;
        }

        var brace = path.IndexOf('{', StringComparison.Ordinal);
        var literal = brace < 0 ? path : path[..brace];
        return path == prefix || path == root || literal.StartsWith(root + "/", StringComparison.Ordinal);
    }

    /// <summary>AU106: a wildcard destination needs a proper subdomain it matches; an exact one takes no host or its own.</summary>
    private static void CheckHost(string? host, string destinationHost, List<AutomationIssue> issues)
    {
        if (destinationHost.StartsWith("*.", StringComparison.Ordinal))
        {
            var suffix = destinationHost[1..];
            if (host is null || host.StartsWith('*') || !Destination.IsValidHost(host) || !host.EndsWith(suffix, StringComparison.Ordinal))
            {
                issues.Add(new("AU106", $"The destination covers '{destinationHost}': name one of its subdomains as the host.", "request.host"));
            }
        }
        else if (host is not null && host != destinationHost)
        {
            issues.Add(new("AU106", $"The host is the destination's, '{destinationHost}', or absent.", "request.host"));
        }
    }

    [GeneratedRegex(@"^[a-zA-Z][a-zA-Z0-9_]{0,63}\z", RegexOptions.CultureInvariant)] // \z: $ would also match before a trailing newline
    private static partial Regex KeyFormat();

    /// <summary>Braces around a key-shaped name: template syntax.</summary>
    [GeneratedRegex(@"\{[a-zA-Z][a-zA-Z0-9_]{0,63}\}", RegexOptions.CultureInvariant)]
    private static partial Regex InputReference();

    [GeneratedRegex(@"^\{([a-zA-Z][a-zA-Z0-9_]{0,63})\}\z", RegexOptions.CultureInvariant)]
    private static partial Regex WholeTemplate();

    [GeneratedRegex(@"\{\{secret:([a-z0-9][a-z0-9_.-]{0,63})\}\}", RegexOptions.CultureInvariant)]
    private static partial Regex Placeholder();

    [GeneratedRegex(@"\G\{\{secret:[a-z0-9][a-z0-9_.-]{0,63}\}\}", RegexOptions.CultureInvariant)]
    private static partial Regex PlaceholderAt();
}
