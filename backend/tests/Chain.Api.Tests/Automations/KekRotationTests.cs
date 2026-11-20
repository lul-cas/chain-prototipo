using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Chain.Api.Automations;
using Chain.Api.Cli;
using Chain.Api.Tests.Infrastructure;
using Chain.Automations;
using Chain.Infrastructure;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Chain.Api.Tests.Automations;

/// <summary>
/// The KEK rotation's command, <c>automation-keks</c> (ADR-0017 §5.2, §5.7; card #77). Secrets are written by an API with the
/// ring <c>{k1}</c>, then the command runs with <c>{k1, k2}</c> and <c>k2</c> active, on the same database.
/// </summary>
[Collection(PostgresTestGroup.Name)]
public sealed class KekRotationTests(PostgresFixture postgres) : IAsyncLifetime, IDisposable
{
    private const string Secrets = "/api/admin/automation/secrets";
    private const string Canary = "canary-Kek-value-5d1e";
    private static readonly string K1 = Convert.ToBase64String(Enumerable.Repeat((byte)0x51, 32).ToArray());
    private static readonly string K2 = Convert.ToBase64String(Enumerable.Repeat((byte)0x52, 32).ToArray());

    private readonly ChainApiFactory _old = new(postgres.ConnectionString, keks: $"k1:{K1}", activeKek: "k1");
    private readonly List<IDisposable> _disposables = [];
    private HttpClient _admin = null!;

    public async Task InitializeAsync()
    {
        await _old.ResetDatabaseAsync();
        _admin = await _old.CreateReadyAdminAsync();
    }

    public Task DisposeAsync() => Task.CompletedTask;

    public void Dispose()
    {
        _admin?.Dispose();
        _old.Dispose();
        foreach (var disposable in _disposables)
        {
            disposable.Dispose();
        }
    }

    private ChainApiFactory Factory(string keks, string? active)
    {
        var factory = new ChainApiFactory(postgres.ConnectionString, keks: keks, activeKek: active);
        _disposables.Add(factory);
        return factory;
    }

    private ChainApiFactory? _new;

    /// <summary>The API after steps 2 to 4 of the procedure (§5.3): both keys, the new one active.</summary>
    private ChainApiFactory New => _new ??= Factory($"k1:{K1},k2:{K2}", "k2");

    private static async Task<(int Code, string Output)> RunAsync(IServiceProvider services, string verb, TextWriter? writer = null, CancellationToken cancellationToken = default)
    {
        using var output = writer ?? new StringWriter(CultureInfo.InvariantCulture);
        var code = await AutomationKeksCommand.RunAsync([AutomationKeksCommand.Name, verb], services, output, cancellationToken);
        return (code, output.ToString()!);
    }

    private async Task CreateSecretAsync(string name, string value)
    {
        var created = await _admin.PostAsJsonAsync(Secrets, new { name, value, allowedDestinations = Array.Empty<string>(), description = "Chave" });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
    }

    /// <summary>A secret's row: key id, version and times, and its value opened with <paramref name="ring"/>.</summary>
    private async Task<(string KeyId, int Version, string? RotatedAt, string UpdatedAt, string Value)> RowAsync(string name, KeyRing ring)
    {
        var row = (await _old.QueryAsync(
            "SELECT replace(encode(nonce, 'base64'), E'\\n', '') || '|' || replace(encode(ciphertext, 'base64'), E'\\n', '') || '|' "
            + "|| replace(encode(wrapped_data_key, 'base64'), E'\\n', '') || '|' || key_id || '|' || version || '|' || coalesce(rotated_at::text, '') || '|' || updated_at::text "
            + $"FROM chain.automation_secrets WHERE name = '{name}'")).Single().Split('|');
        var version = int.Parse(row[4], CultureInfo.InvariantCulture);
        var sealedSecret = new SealedSecret(Convert.FromBase64String(row[0]), Convert.FromBase64String(row[1]), Convert.FromBase64String(row[2]), row[3]);
        return (row[3], version, row[5].Length == 0 ? null : row[5], row[6], SecretEnvelope.Open(ring, name, version, sealedSecret));
    }

    private static KeyRing OnlyK2 => KeyRing.Parse($"k2:{K2}", "k2");

    [Fact]
    public async Task Rewrap_moves_every_secret_to_the_active_key_keeping_values_versions_and_times()
    {
        await CreateSecretAsync("crm_key", "crm-" + Canary);
        await CreateSecretAsync("erp_key", "first-" + Canary);
        var etag = (await _admin.GetAsync($"{Secrets}/erp_key")).Headers.ETag!.Tag;
        using (var rotate = new HttpRequestMessage(HttpMethod.Put, $"{Secrets}/erp_key/value") { Content = JsonContent.Create(new { value = "erp-" + Canary }) })
        {
            rotate.Headers.TryAddWithoutValidation("If-Match", etag);
            Assert.Equal(HttpStatusCode.OK, (await _admin.SendAsync(rotate)).StatusCode);
        }

        var before = await RowAsync("erp_key", KeyRing.Parse($"k1:{K1}", "k1"));

        var (code, output) = await RunAsync(New.Services, "rewrap");

        Assert.Equal(0, code);
        Assert.Contains("crm_key v1: k1 -> k2 (1/2)", output, StringComparison.Ordinal);
        Assert.Contains("erp_key v2: k1 -> k2 (2/2)", output, StringComparison.Ordinal);
        Assert.Contains("Moved: 2. Already on k2: 0. Failed: 0. Secrets per key: k2: 2.", output, StringComparison.Ordinal);
        var after = await RowAsync("erp_key", OnlyK2);
        Assert.Equal(("k2", before.Version, before.RotatedAt, before.UpdatedAt, "erp-" + Canary), after);
        Assert.Equal("crm-" + Canary, (await RowAsync("crm_key", OnlyK2)).Value);

        var runId = output[(output.LastIndexOf("Run: ", StringComparison.Ordinal) + 5)..].Trim().TrimEnd('.');
        var audit = await _old.QueryAsync(
            "SELECT action || '|' || coalesce(actor_id::text, '') || '|' || correlation_id || '|' || details FROM chain.audit_events "
            + "WHERE action IN ('admin.secret.rewrapped', 'admin.kek.rewrap_finished') ORDER BY occurred_at, action DESC");
        Assert.Equal(["admin.secret.rewrapped", "admin.secret.rewrapped", "admin.kek.rewrap_finished"], audit.Select(line => line.Split('|')[0]));
        Assert.All(audit, line => Assert.Equal(("", runId), (line.Split('|')[1], line.Split('|')[2]))); // no actor; the run's id
        var details = audit.Select(line => JsonDocument.Parse(line.Split('|', 4)[3]).RootElement).ToList();
        Assert.Equal(("k1", "k2", "operator"), (details[0].GetProperty("fromKeyId").GetString(), details[0].GetProperty("toKeyId").GetString(), details[0].GetProperty("principal").GetString()));
        Assert.Equal(("2", "0", "", "k2:2"), (details[2].GetProperty("moved").GetString(), details[2].GetProperty("current").GetString(), details[2].GetProperty("failed").GetString(), details[2].GetProperty("left").GetString()));

        foreach (var text in new[] { output, string.Join("\n", audit) })
        {
            Assert.DoesNotContain(Canary, text, StringComparison.Ordinal);
            Assert.DoesNotContain(K1, text, StringComparison.Ordinal);
            Assert.DoesNotContain(K2, text, StringComparison.Ordinal);
        }

        var (again, rerun) = await RunAsync(New.Services, "rewrap");
        Assert.Equal(0, again);
        Assert.Contains("Moved: 0. Already on k2: 2. Failed: 0.", rerun, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_secret_on_a_key_not_configured_is_reported_and_left_while_the_others_move()
    {
        await CreateSecretAsync("erp_key", "erp-" + Canary);
        await _old.QueryAsync(
            "UPDATE chain.automation_secrets SET key_id = 'k0' WHERE name = 'erp_key' RETURNING name"); // as if written under a key no longer configured
        await CreateSecretAsync("crm_key", "crm-" + Canary);

        var (status, statusOutput) = await RunAsync(New.Services, "status");
        Assert.Equal(1, status);
        Assert.Contains("Secrets per key: k0: 1 (not configured), k1: 1", statusOutput, StringComparison.Ordinal);
        Assert.Contains("Does not open: erp_key v1 on k0: its key is not configured.", statusOutput, StringComparison.Ordinal);

        var (code, output) = await RunAsync(New.Services, "rewrap");
        Assert.Equal(1, code);
        Assert.Contains("Not moved: erp_key v1 on k0: its key is not configured.", output, StringComparison.Ordinal);
        Assert.Contains("Moved: 1. Already on k2: 0. Failed: 1. Secrets per key: k0: 1, k2: 1.", output, StringComparison.Ordinal);
        Assert.Equal(["k0"], await _old.QueryAsync("SELECT key_id FROM chain.automation_secrets WHERE name = 'erp_key'"));
    }

    [Fact]
    public async Task Without_an_active_key_or_with_a_wrong_verb_it_stops_with_2()
    {
        await CreateSecretAsync("erp_key", "erp-" + Canary);
        var noActive = Factory($"k1:{K1},k2:{K2}", null);

        Assert.Equal(2, (await RunAsync(noActive.Services, "rewrap")).Code);
        Assert.Equal(["k1"], await _old.QueryAsync("SELECT key_id FROM chain.automation_secrets"));

        using var usage = new StringWriter(CultureInfo.InvariantCulture);
        Assert.Equal(2, await AutomationKeksCommand.RunAsync([AutomationKeksCommand.Name], New.Services, usage, CancellationToken.None));
        Assert.Equal(2, await AutomationKeksCommand.RunAsync([AutomationKeksCommand.Name, "rotate"], New.Services, usage, CancellationToken.None));
        Assert.Contains("Usage: automation-keks status | automation-keks rewrap", usage.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Status_shows_the_keys_with_their_check_values_and_the_secrets_per_key()
    {
        await CreateSecretAsync("crm_key", "crm-" + Canary);
        await CreateSecretAsync("erp_key", "erp-" + Canary);
        var ring = KeyRing.Parse($"k1:{K1},k2:{K2}", "k2");

        var (code, output) = await RunAsync(New.Services, "status");

        Assert.Equal(0, code);
        Assert.Contains($"Keys: k1 (check {ring.Find("k1")!.CheckValue}), k2 (check {ring.Find("k2")!.CheckValue}, active)", output, StringComparison.Ordinal);
        Assert.Contains("Secrets per key: k1: 2", output, StringComparison.Ordinal);
        Assert.Equal(["k1", "k1"], await _old.QueryAsync("SELECT key_id FROM chain.automation_secrets")); // read-only
    }

    [Fact]
    public async Task An_edit_with_an_If_Match_older_than_the_run_gets_412()
    {
        await CreateSecretAsync("erp_key", "erp-" + Canary);
        var etag = (await _admin.GetAsync($"{Secrets}/erp_key")).Headers.ETag!.Tag;

        Assert.Equal(0, (await RunAsync(New.Services, "rewrap")).Code);

        using var edit = new HttpRequestMessage(HttpMethod.Patch, $"{Secrets}/erp_key") { Content = JsonContent.Create(new { description = "Nova" }) };
        edit.Headers.TryAddWithoutValidation("If-Match", etag);
        await (await _admin.SendAsync(edit)).AssertProblemAsync(HttpStatusCode.PreconditionFailed, "version_mismatch");
    }

    [Fact]
    public async Task A_run_stopped_part_way_leaves_each_secret_whole_and_a_rerun_finishes()
    {
        await CreateSecretAsync("a_key", "a-" + Canary);
        await CreateSecretAsync("b_key", "b-" + Canary);
        var services = New.Services;
        using var stop = new CancellationTokenSource();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => RunAsync(services, "rewrap", new CancelOnMove(stop), stop.Token));

        Assert.Equal(["k2", "k1"], await _old.QueryAsync("SELECT key_id FROM chain.automation_secrets ORDER BY name"));
        var (code, output) = await RunAsync(services, "rewrap");
        Assert.Equal(0, code);
        Assert.Contains("Moved: 1. Already on k2: 1.", output, StringComparison.Ordinal);
        Assert.Equal("b-" + Canary, (await RowAsync("b_key", OnlyK2)).Value);
    }

    [Fact]
    public async Task A_value_rotated_during_the_move_is_kept_and_ends_on_the_active_key()
    {
        await CreateSecretAsync("erp_key", "erp-" + Canary);
        var fired = new StrongBox<int>(0);
        using var racing = New.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
            services.ConfigureDbContext<ChainDbContext>((provider, options) => options.AddInterceptors(new RotateDuringMove(provider, fired)))));

        var (code, output) = await RunAsync(racing.Services, "rewrap");

        Assert.Equal(1, fired.Value);
        Assert.Equal(0, code);
        Assert.Contains("Moved: 0. Already on k2: 1.", output, StringComparison.Ordinal); // the rotation sealed it with k2 already
        var row = await RowAsync("erp_key", OnlyK2);
        Assert.Equal(("k2", 2, "rotated-" + Canary), (row.KeyId, row.Version, row.Value)); // the rotation wasn't overwritten
    }

    [Fact]
    public void The_startup_line_names_the_keys_and_their_check_values_never_their_material()
    {
        var ring = KeyRing.Parse($"k1:{K1},k2:{K2}", "k2");
        var logger = new LinesLogger();

        KekStartupLog.Write(logger, ring);

        var line = Assert.Single(logger.Lines);
        Assert.Equal($"Automation KEKs: k1 (check {ring.Find("k1")!.CheckValue}), k2 (check {ring.Find("k2")!.CheckValue}). Active: k2.", line);
        Assert.DoesNotContain(K1, line, StringComparison.Ordinal);
    }

    /// <summary>Cancels the run after it reports the first secret it moved, as a Ctrl-C would.</summary>
    private sealed class CancelOnMove(CancellationTokenSource stop) : StringWriter(CultureInfo.InvariantCulture)
    {
        public override void WriteLine(string? value)
        {
            base.WriteLine(value);
            if (value?.Contains("->", StringComparison.Ordinal) == true)
            {
                stop.Cancel();
            }
        }
    }

    /// <summary>
    /// The race of ADR-0017 §5.2 (step 5): just before the move is saved, an admin's rotation seals the secret again, with the
    /// active key, and commits. The move's save then conflicts on the row version, and the command reads the row again.
    /// </summary>
    private sealed class RotateDuringMove(IServiceProvider provider, StrongBox<int> fired) : SaveChangesInterceptor
    {
        public override async ValueTask<InterceptionResult<int>> SavingChangesAsync(
            DbContextEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            var moving = eventData.Context!.ChangeTracker.Entries<Secret>().Any(entry => entry.State == EntityState.Modified);
            if (moving && Interlocked.Exchange(ref fired.Value, 1) == 0)
            {
                await using var scope = provider.GetRequiredService<IServiceScopeFactory>().CreateAsyncScope();
                var db = scope.ServiceProvider.GetRequiredService<ChainDbContext>();
                var secret = await db.AutomationSecrets.SingleAsync(s => s.Name == "erp_key", cancellationToken);
                secret.Rotate(scope.ServiceProvider.GetRequiredService<KeyRing>().Active!, "rotated-" + Canary, DateTimeOffset.UtcNow);
                await db.SaveChangesAsync(cancellationToken);
            }

            return await base.SavingChangesAsync(eventData, result, cancellationToken);
        }
    }

    private sealed class LinesLogger : ILogger
    {
        public List<string> Lines { get; } = [];

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
            Lines.Add(formatter(state, exception));
    }
}
