using Chain.Api;
using Chain.Api.Admin;
using Chain.Api.Auth;
using Chain.Api.Automations;
using Chain.Api.Engine;
using Chain.Api.Files;
using Chain.Api.Forms;
using Chain.Api.Cli;
using Chain.Api.Health;
using Chain.Api.Http;
using Chain.Api.Workflows;
using Chain.Forms;
using Chain.Infrastructure;
using Chain.Mcp;

var builder = WebApplication.CreateBuilder(args);

// docker-compose.yml's development KEK and result token are published: refused outside Development (automation.md §4.1).
DevelopmentValuesGuard.Refuse(builder.Configuration, builder.Environment);
builder.Services.AddChainInfrastructure(builder.Configuration);
// The way each request came in, for timeline events and audit (workflow-engine.md §8, card #83).
builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<Chain.SharedKernel.IRequestChannel, HttpRequestChannel>();
// A request an endpoint cannot bind throws, in every environment, so UseUnreadableRequestProblems answers it (card #180).
builder.Services.Configure<RouteHandlerOptions>(options => options.ThrowOnBadRequest = true);
builder.Services.AddHostedService<MigrationsHostedService>();
builder.Services.AddHostedService<IdempotencyCleanupService>();
builder.Services.AddSingleton<Chain.Mcp.IMcpCallLog, McpCallLogStore>(); // mcp.md §6.1 (card #83, N9b-2)
if (!builder.Environment.IsEnvironment("Testing"))
{
    // Tests run these passes directly, on the test clock.
    builder.Services.AddHostedService<PendingFileCleanupService>();
    builder.Services.AddHostedService<AutomationWatchdogService>();
    builder.Services.AddHostedService<McpCallCleanupService>();
}

var maxUploadBytes = builder.Configuration.GetValue("Chain:Files:MaxBytes", FileRules.MaxBytes) + (1024 * 1024);
builder.Services.Configure<Microsoft.AspNetCore.Http.Features.FormOptions>(options =>
{
    options.MultipartBodyLengthLimit = maxUploadBytes;
    options.ValueLengthLimit = 1024 * 1024;
    options.MultipartHeadersLengthLimit = 16 * 1024;
});
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = maxUploadBytes);
builder.Services.AddHealthChecks()
    .AddCheck<PostgresHealthCheck>("postgres", tags: ["ready"]);
builder.Services
    .AddAuthentication(ChainAuthentication.SchemeName)
    .AddPolicyScheme(ChainAuthentication.SchemeName, null, options => options.ForwardDefaultSelector = ChainAuthentication.SelectScheme)
    .AddScheme<Microsoft.AspNetCore.Authentication.AuthenticationSchemeOptions, SessionAuthenticationHandler>(SessionAuthenticationHandler.SchemeName, null)
    .AddScheme<Microsoft.AspNetCore.Authentication.AuthenticationSchemeOptions, McpAuthenticationHandler>(McpAuthenticationHandler.SchemeName, null)
    .AddScheme<Microsoft.AspNetCore.Authentication.AuthenticationSchemeOptions, AutomationResultAuthenticationHandler>(AutomationResultAuthenticationHandler.SchemeName, null);
builder.Services.AddAuthorizationBuilder()
    .AddPolicy(AdminEndpoints.AdminPolicy, policy => policy.RequireAuthenticatedUser().RequireClaim(CallerClaims.IsAdminClaim, bool.TrueString))
    .AddPolicy(McpAuthenticationHandler.Policy, policy => policy.RequireAuthenticatedUser().RequireClaim(CallerClaims.ChannelClaim, CallerClaims.McpChannel))
    .AddPolicy(AutomationResultAuthenticationHandler.Policy, policy => policy.RequireAuthenticatedUser()
        .RequireClaim(CallerClaims.ChannelClaim, AutomationResultAuthenticationHandler.Channel));
builder.Services.AddChainMcp(builder.Configuration);
// The MCP rate: the default, which a bot's own setting overrides, counted for every process (mcp.md §5, card #83).
var mcpCallsPerMinute = builder.Configuration.GetValue("Chain:Mcp:CallsPerMinute", 60);
if (mcpCallsPerMinute < 1)
{
    throw new InvalidOperationException("Chain:Mcp:CallsPerMinute must be at least 1.");
}

builder.Services.AddSingleton<Chain.Mcp.IMcpRateLimiter>(provider => new McpRateLimiterStore(
    provider.GetRequiredService<IServiceScopeFactory>(), provider.GetRequiredService<TimeProvider>(), mcpCallsPerMinute));

var app = builder.Build();

if (args is [BootstrapAdminCommand.Name, ..])
{
    await MigrationsHostedService.MigrateIfEnabledAsync(app.Services, app.Configuration);
    return await BootstrapAdminCommand.RunAsync(args, app.Services, Console.In, Console.Out, Environment.GetEnvironmentVariable);
}

if (args is [AutomationKeksCommand.Name, ..])
{
    await MigrationsHostedService.MigrateIfEnabledAsync(app.Services, app.Configuration);
    return await AutomationKeksCommand.RunAsync(args, app.Services, Console.Out, CancellationToken.None);
}

KekStartupLog.Write(app.Logger, app.Services.GetRequiredService<Chain.Automations.KeyRing>());

app.UseInternalListener(app.Configuration);
app.UseConcurrencyConflictHandling();
app.UseFileTooLarge();
app.UseOriginCheck(app.Configuration);
app.UseMcpBodyLimit();
app.UseAuthentication();
app.UsePasswordChangeGate();
app.UseAuthorization();
app.UseUnreadableRequestProblems();
app.UseMcpUtf8Check();

// Liveness: the process is up. Dependencies are deliberately not checked.
app.MapHealthChecks("/health/live", new() { Predicate = _ => false });

// Readiness: the service can do useful work (database reachable).
app.MapHealthChecks("/health/ready", new() { Predicate = check => check.Tags.Contains("ready") });

app.MapAuthEndpoints();
app.MapAdminEndpoints();
app.MapBotEndpoints();
app.MapWorkflowEndpoints();
app.MapInstanceEndpoints();
app.MapFormEndpoints();
app.MapFileEndpoints();
app.MapAutomationEndpoints();
app.MapChainMcp().RequireAuthorization(McpAuthenticationHandler.Policy);
app.MapAutomationResultEndpoints();

await app.RunAsync();
return 0;
