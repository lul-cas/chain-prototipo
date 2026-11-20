using System.Reflection;

namespace Chain.Identity.Tests;

/// <summary>Boundary rules of ADR-0007 §3: domain and application code stay free of frameworks and I/O.</summary>
public sealed class ArchitectureTests
{
    public static TheoryData<string> InnerAssemblies => new()
    {
        typeof(User).Assembly.GetName().Name!,                                    // Chain.Identity (domain)
        typeof(Chain.Workflows.Definitions.WorkflowValidator).Assembly.GetName().Name!, // Chain.Workflows (domain)
        typeof(Application.AuthenticationService).Assembly.GetName().Name!,      // Chain.Identity.Application
        typeof(Chain.Workflows.Application.WorkflowModelingService).Assembly.GetName().Name!, // Chain.Workflows.Application
        typeof(Chain.SharedKernel.AuditRecord).Assembly.GetName().Name!,          // Chain.SharedKernel
        typeof(Chain.Forms.FormValidator).Assembly.GetName().Name!,               // Chain.Forms
        typeof(Chain.Expressions.Evaluator).Assembly.GetName().Name!,             // Chain.Expressions
        typeof(Chain.Forms.Application.FormModelingService).Assembly.GetName().Name!, // Chain.Forms.Application
        typeof(Chain.Automations.Destination).Assembly.GetName().Name!,           // Chain.Automations
        typeof(Chain.Automations.Application.AutomationAdminService).Assembly.GetName().Name!, // Chain.Automations.Application
    };

    [Theory]
    [MemberData(nameof(InnerAssemblies))]
    public void Inner_layers_do_not_reference_persistence_or_web_frameworks(string assemblyName)
    {
        var references = Assembly.Load(assemblyName).GetReferencedAssemblies().Select(a => a.Name!).ToList();

        Assert.DoesNotContain(references, name => name.StartsWith("Microsoft.EntityFrameworkCore", StringComparison.Ordinal));
        Assert.DoesNotContain(references, name => name.StartsWith("Npgsql", StringComparison.Ordinal));
        Assert.DoesNotContain(references, name => name.StartsWith("Microsoft.AspNetCore", StringComparison.Ordinal));
        Assert.DoesNotContain(references, name => name.StartsWith("Chain.Infrastructure", StringComparison.Ordinal));
        Assert.DoesNotContain(references, name => name.StartsWith("Chain.Api", StringComparison.Ordinal));
    }

    [Fact]
    public void Workflow_application_does_not_depend_on_identity_internals()
    {
        var references = typeof(Chain.Workflows.Application.WorkflowModelingService).Assembly.GetReferencedAssemblies().Select(a => a.Name!);

        Assert.DoesNotContain("Chain.Identity", references);
        Assert.DoesNotContain("Chain.Identity.Application", references);
    }

    [Fact]
    public void Workflow_application_reads_forms_and_automations_through_their_domain_only()
    {
        var references = typeof(Chain.Workflows.Application.WorkflowModelingService).Assembly.GetReferencedAssemblies().Select(a => a.Name!).ToList();

        Assert.Contains("Chain.Automations", references);
        Assert.DoesNotContain("Chain.Automations.Application", references);
        Assert.DoesNotContain("Chain.Forms.Application", references);
    }

    [Fact]
    public void Forms_module_does_not_depend_on_other_modules()
    {
        var references = typeof(Chain.Forms.Application.FormModelingService).Assembly.GetReferencedAssemblies()
            .Concat(typeof(Chain.Forms.FormValidator).Assembly.GetReferencedAssemblies())
            .Select(a => a.Name!).ToList();

        Assert.DoesNotContain(references, name => name.StartsWith("Chain.Workflows", StringComparison.Ordinal));
        Assert.DoesNotContain(references, name => name.StartsWith("Chain.Identity", StringComparison.Ordinal));
    }

    [Fact]
    public void Mcp_adapter_reaches_chain_only_through_application_services()
    {
        var references = typeof(Chain.Mcp.McpRegistration).Assembly.GetReferencedAssemblies().Select(a => a.Name!).ToList();

        Assert.Contains("Chain.Workflows.Application", references);
        Assert.DoesNotContain(references, name => name.StartsWith("Chain.Infrastructure", StringComparison.Ordinal));
        Assert.DoesNotContain(references, name => name.StartsWith("Chain.Api", StringComparison.Ordinal));
        Assert.DoesNotContain(references, name => name.StartsWith("Chain.Identity", StringComparison.Ordinal));
        Assert.DoesNotContain(references, name => name.StartsWith("Microsoft.EntityFrameworkCore", StringComparison.Ordinal));
        Assert.DoesNotContain(references, name => name.StartsWith("Npgsql", StringComparison.Ordinal));
    }

    [Fact]
    public void Automations_module_does_not_depend_on_other_modules()
    {
        var references = typeof(Chain.Automations.Application.AutomationAdminService).Assembly.GetReferencedAssemblies()
            .Concat(typeof(Chain.Automations.Destination).Assembly.GetReferencedAssemblies())
            .Select(a => a.Name!).ToList();

        Assert.DoesNotContain(references, name => name.StartsWith("Chain.Workflows", StringComparison.Ordinal));
        Assert.DoesNotContain(references, name => name.StartsWith("Chain.Identity", StringComparison.Ordinal));
        Assert.DoesNotContain(references, name => name.StartsWith("Chain.Forms", StringComparison.Ordinal));
    }

    [Fact]
    public void Domain_does_not_depend_on_the_application_layer()
    {
        var references = typeof(User).Assembly.GetReferencedAssemblies().Select(a => a.Name!);

        Assert.DoesNotContain("Chain.Identity.Application", references);
    }
}
