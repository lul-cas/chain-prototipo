using System.Net.Http.Headers;
using Chain.Infrastructure;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Testcontainers.PostgreSql;

namespace Chain.Api.Tests.Infrastructure;

/// <summary>One PostgreSQL container shared by all database-backed API tests.</summary>
public sealed class PostgresFixture : IAsyncLifetime
{
    private readonly PostgreSqlContainer _container = new PostgreSqlBuilder("postgres:17.11-alpine").Build();

    public string ConnectionString => _container.GetConnectionString();

    public Task InitializeAsync() => _container.StartAsync();

    public Task DisposeAsync() => _container.DisposeAsync().AsTask();
}

[CollectionDefinition(Name)]
public sealed class PostgresTestGroup : ICollectionFixture<PostgresFixture>
{
    public const string Name = "postgres";
}

/// <summary>
/// The API wired to the test container, with a controllable clock, a known frontend origin and a test-only key-encryption key
/// for automation secrets (automation.md §4.1). <paramref name="keks"/> and <paramref name="activeKek"/> override that key,
/// <paramref name="settings"/> sets any other configuration value, and <paramref name="environment"/> replaces <c>Testing</c>.
/// </summary>
public sealed class ChainApiFactory(
    string connectionString,
    string? keks = ChainApiFactory.TestKeks,
    string? activeKek = ChainApiFactory.TestKekId,
    IReadOnlyDictionary<string, string>? settings = null,
    string environment = "Testing")
    : WebApplicationFactory<Program>
{
    public const string FrontendOrigin = "https://chain.test";

    /// <summary>A fixed KEK for tests only; never use it anywhere else.</summary>
    public const string TestKekId = "test";
    public const string TestKeks = "test:QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=";

    /// <summary>The bearer token Elixir would present on the result call (automation-contract.md §4.1); tests only.</summary>
    public const string TestResultToken = "test-only-automation-result-token-not-real0";

    /// <summary>The internal listener's port (automation-contract.md §4.1).</summary>
    public const int InternalPort = 8081;

    public FakeTimeProvider Time { get; } = new(new DateTimeOffset(2026, 10, 15, 12, 0, 0, TimeSpan.Zero));

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment(environment);
        builder.UseSetting("ConnectionStrings:Chain", connectionString);
        builder.UseSetting("Chain:ApplyMigrationsOnStartup", "true");
        builder.UseSetting("Chain:AllowedOrigins:0", FrontendOrigin);
        builder.UseSetting("Chain:Automation:Keks", keks ?? string.Empty);
        builder.UseSetting("Chain:Automation:ActiveKek", activeKek ?? string.Empty);
        builder.UseSetting("Chain:Automation:InternalPort", InternalPort.ToString(System.Globalization.CultureInfo.InvariantCulture));
        builder.UseSetting("Chain:Automation:ResultTokenSha256", "e7a934acab862539704658e84b1374365298a2d597ed7578c527cc95e00643b2"); // SHA-256 of TestResultToken
        foreach (var (key, value) in settings ?? new Dictionary<string, string>())
        {
            builder.UseSetting(key, value);
        }

        builder.ConfigureTestServices(services => services.AddSingleton<TimeProvider>(Time));
    }

    /// <summary>A browser-like client: HTTPS, cookies kept, the frontend's Origin header on every request.</summary>
    public HttpClient CreateBrowser(bool handleCookies = true)
    {
        var client = CreateClient(new WebApplicationFactoryClientOptions
        {
            BaseAddress = new Uri("https://localhost"),
            HandleCookies = handleCookies,
            AllowAutoRedirect = false,
        });
        client.DefaultRequestHeaders.Add("Origin", FrontendOrigin);
        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        return client;
    }

    /// <summary>Removes all identity data so each test starts from an empty database.</summary>
    public async Task ResetDatabaseAsync()
    {
        using var scope = Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ChainDbContext>();
        await db.Database.ExecuteSqlRawAsync("TRUNCATE chain.mcp_calls, chain.automation_results, chain.automation_work_requests, chain.automation_versions, chain.automation_definitions, chain.automation_secrets, chain.automation_destinations, chain.file_contents, chain.files, chain.instance_incidents, chain.instance_submissions, chain.form_versions, chain.form_definitions, chain.idempotency_keys, chain.instance_events, chain.instance_participants, chain.instance_tasks, chain.instances, chain.workflow_grants, chain.workflow_versions, chain.workflow_definitions, chain.platform_grants, chain.bot_tokens, chain.group_members, chain.groups, chain.sessions, chain.audit_events, chain.users CASCADE");
    }
}
