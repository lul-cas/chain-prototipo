using Chain.SharedKernel;

namespace Chain.Automations;

/// <summary>The editable fields of a destination; null means the default (automation.md §3.1).</summary>
public sealed record DestinationSettings(
    string? Description, string? Scheme, string? Host, int? Port, string? PathPrefix, bool Internal, bool AllowSecretsOverHttp,
    long? MaxRequestBytes, long? MaxResponseBytes);

/// <summary>A value, or the rule codes it broke.</summary>
public sealed record Validated<T>(IReadOnlyList<string> Errors, T? Value)
    where T : class;

/// <summary>
/// An entry of the egress allow-list (ADR-0012 Part 2; automation.md §3.1): where automations may send requests. An automation
/// calls exactly one destination, and a secret is injected only towards the destinations it lists.
/// </summary>
public sealed class Destination
{
    public const long DefaultMaxBytes = 1_048_576;
    public const long MinMaxBytes = 1024;
    public const long MaxMaxBytes = 10_485_760;
    public const int MaxDescriptionLength = 500;
    public const int MaxPathPrefixLength = 500;

    private Destination()
    {
    }

    public string Name { get; private set; } = string.Empty;
    public string? Description { get; private set; }
    public string Scheme { get; private set; } = "https";
    public string Host { get; private set; } = string.Empty;
    public int? Port { get; private set; }
    public string? PathPrefix { get; private set; }
    public bool Internal { get; private set; }
    public bool AllowSecretsOverHttp { get; private set; }
    public long MaxRequestBytes { get; private set; }
    public long MaxResponseBytes { get; private set; }
    public DateTimeOffset CreatedAt { get; private set; }
    public Guid CreatedBy { get; private set; }
    public DateTimeOffset UpdatedAt { get; private set; }

    public static Validated<Destination> Create(string? name, DestinationSettings settings, Guid createdBy, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(settings);
        var errors = new List<string>();
        if (!Names.IsValid(name))
        {
            errors.Add("invalid_name");
        }

        errors.AddRange(Validate(settings));
        if (errors.Count > 0)
        {
            return new Validated<Destination>(errors, null);
        }

        var destination = new Destination { Name = name!, CreatedAt = now, CreatedBy = createdBy };
        destination.Apply(settings, now);
        return new Validated<Destination>([], destination);
    }

    /// <summary>Replaces the settings; the name never changes. A rejected update changes nothing.</summary>
    public IReadOnlyList<string> Update(DestinationSettings settings, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(settings);
        var errors = Validate(settings);
        if (errors.Count == 0)
        {
            Apply(settings, now);
        }

        return errors;
    }

    private void Apply(DestinationSettings settings, DateTimeOffset now)
    {
        Description = string.IsNullOrWhiteSpace(settings.Description) ? null : settings.Description;
        Scheme = settings.Scheme ?? "https";
        Host = settings.Host!;
        Port = settings.Port;
        PathPrefix = settings.PathPrefix;
        Internal = settings.Internal;
        AllowSecretsOverHttp = settings.AllowSecretsOverHttp;
        MaxRequestBytes = settings.MaxRequestBytes ?? DefaultMaxBytes;
        MaxResponseBytes = settings.MaxResponseBytes ?? DefaultMaxBytes;
        UpdatedAt = now;
    }

    private static List<string> Validate(DestinationSettings settings)
    {
        var errors = new List<string>();
        var scheme = settings.Scheme ?? "https";
        if (settings.Description is { Length: > MaxDescriptionLength })
        {
            errors.Add("description_too_long");
        }
        else if (!ClientText.IsStorable(settings.Description))
        {
            errors.Add("invalid_description");
        }

        if (scheme is not ("https" or "http"))
        {
            errors.Add("invalid_scheme");
        }
        else if (scheme == "http" && !settings.Internal)
        {
            errors.Add("http_requires_internal"); // ADR-0012 decision 10
        }

        if (settings.AllowSecretsOverHttp && scheme != "http")
        {
            errors.Add("secrets_over_http_requires_http");
        }

        if (!IsValidHost(settings.Host))
        {
            errors.Add("invalid_host");
        }

        if (settings.Port is < 1 or > 65535)
        {
            errors.Add("invalid_port");
        }

        if (settings.PathPrefix is { } prefix && !IsValidPathPrefix(prefix))
        {
            errors.Add("invalid_path_prefix");
        }

        if (settings.MaxRequestBytes is < MinMaxBytes or > MaxMaxBytes)
        {
            errors.Add("invalid_max_request_bytes");
        }

        if (settings.MaxResponseBytes is < MinMaxBytes or > MaxMaxBytes)
        {
            errors.Add("invalid_max_response_bytes");
        }

        return errors;
    }

    /// <summary>
    /// A lowercase DNS name in ASCII form, or <c>*.</c> followed by one with at least two labels. IP literals, user info, ports
    /// and paths are rejected: a top label of digits only would read as an address.
    /// </summary>
    internal static bool IsValidHost(string? host)
    {
        if (string.IsNullOrEmpty(host) || host.Length > 253)
        {
            return false;
        }

        var wildcard = host.StartsWith("*.", StringComparison.Ordinal);
        var labels = (wildcard ? host[2..] : host).Split('.');
        if (wildcard && labels.Length < 2)
        {
            return false; // *.com would cover a whole top-level domain
        }

        foreach (var label in labels)
        {
            if (label.Length is 0 or > 63 || label[0] == '-' || label[^1] == '-'
                || !label.All(c => c is (>= 'a' and <= 'z') or (>= '0' and <= '9') or '-'))
            {
                return false;
            }
        }

        return !labels[^1].All(char.IsAsciiDigit);
    }

    /// <summary>Starts with <c>/</c>; no <c>..</c>, <c>?</c>, <c>#</c>, percent-encoded <c>/</c> or whitespace.</summary>
    private static bool IsValidPathPrefix(string prefix) =>
        prefix.Length is > 0 and <= MaxPathPrefixLength
        && prefix[0] == '/'
        && !prefix.Contains("..", StringComparison.Ordinal)
        && !prefix.Contains('?', StringComparison.Ordinal)
        && !prefix.Contains('#', StringComparison.Ordinal)
        && !prefix.Contains("%2f", StringComparison.OrdinalIgnoreCase)
        && !prefix.Any(c => char.IsWhiteSpace(c) || char.IsControl(c));
}
