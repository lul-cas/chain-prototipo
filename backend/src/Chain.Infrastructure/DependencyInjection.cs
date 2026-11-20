using Chain.Forms;
using Chain.SharedKernel;
using Chain.Identity.Application;
using Chain.Infrastructure.Engine;
using Chain.Infrastructure.Files;
using Chain.Infrastructure.Identity;
using Chain.Workflows.Application.Engine;
using Chain.Workflows.Application.Files;
using Chain.Infrastructure.Workflows;
using Chain.Workflows.Application;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Chain.Infrastructure;

public static class DependencyInjection
{
    public static IServiceCollection AddChainInfrastructure(this IServiceCollection services, IConfiguration configuration)
    {
        var connectionString = configuration.GetConnectionString("Chain")
            ?? throw new InvalidOperationException("Connection string 'Chain' is not configured.");

        services.AddDbContext<ChainDbContext>(options => options
            .UseNpgsql(connectionString, npgsql => npgsql.MigrationsHistoryTable("__ef_migrations_history", ChainDbContext.Schema))
            .UseSnakeCaseNamingConvention());

        services.TryAddSingleton(TimeProvider.System);
        services.AddSingleton(new FileSettings(
            configuration.GetValue("Chain:Files:MaxBytes", FileRules.MaxBytes),
            configuration.GetValue("Chain:Files:MaxFiles", FileRules.MaxFiles),
            configuration.GetValue("Chain:Files:PendingTtlHours", 24)));
        services.AddSingleton<Chain.Identity.Application.IPasswordHasher, AspNetPasswordHasher>();
        services.AddScoped<IIdentityStore, IdentityStore>();
        services.AddScoped<AuthenticationService>();
        services.AddScoped<BootstrapAdminService>();
        services.AddScoped<AdministrationService>();
        services.AddScoped<IWorkflowStore, WorkflowStore>();
        services.AddScoped<IModelingAuthorization, ModelingAuthorization>();
        services.AddScoped<IGroupDirectory, GroupDirectory>();
        services.AddScoped<WorkflowModelingService>();
        services.AddScoped<IInstanceStore, InstanceStore>();
        services.AddScoped<IActorDirectory, ActorDirectory>();
        services.AddScoped<InstanceAccess>();
        services.AddScoped<InstanceService>();
        services.AddScoped<IFileStore, FileStore>();
        services.AddScoped<Chain.Forms.Application.IKnownFileSource, FileStore>();
        services.AddScoped<IFileContentStore, PostgresFileContentStore>();
        services.AddScoped<FileService>();
        services.TryAddSingleton(EvaluationZone.Default);
        services.AddScoped<Chain.Forms.Application.IFormStore, Chain.Infrastructure.Forms.FormStore>();
        services.AddScoped<IFormDirectory, Chain.Infrastructure.Forms.FormDirectory>();
        services.AddScoped<IFormVersionSource, Chain.Infrastructure.Forms.FormVersionSource>();
        services.AddScoped<Chain.Forms.Application.FormModelingService>();

        // Automation secrets (automation.md §4.1): a malformed KEK configuration throws here and stops the API at startup.
        services.AddSingleton(Chain.Automations.KeyRing.Parse(configuration["Chain:Automation:Keks"], configuration["Chain:Automation:ActiveKek"]));
        services.AddScoped<Chain.Automations.Application.IAutomationStore, Chain.Infrastructure.Automations.AutomationStore>();
        services.AddScoped<Chain.Automations.Application.AutomationAdminService>();
        services.AddScoped<Chain.Automations.Application.KekRotationService>();
        services.AddScoped<Chain.Automations.Application.AutomationModelingService>();
        services.AddScoped<IAutomationDirectory, Chain.Infrastructure.Automations.AutomationDirectory>();
        return services;
    }
}
