using Chain.Identity.Application;

namespace Chain.Api.Cli;

/// <summary>
/// <c>dotnet Chain.Api.dll bootstrap-admin --username &lt;name&gt;</c>: creates the environment's first admin (ADR-0006 §4).
/// The password comes from <see cref="PasswordVariable"/> or, if unset, the first line of standard input.
/// </summary>
public static class BootstrapAdminCommand
{
    public const string Name = "bootstrap-admin";
    public const string PasswordVariable = "CHAIN_BOOTSTRAP_PASSWORD";

    public static async Task<int> RunAsync(
        string[] args,
        IServiceProvider services,
        TextReader input,
        TextWriter output,
        Func<string, string?> getEnvironmentVariable)
    {
        ArgumentNullException.ThrowIfNull(args);
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(input);
        ArgumentNullException.ThrowIfNull(output);
        ArgumentNullException.ThrowIfNull(getEnvironmentVariable);

        var usernameIndex = Array.IndexOf(args, "--username");
        if (usernameIndex < 0 || usernameIndex + 1 >= args.Length)
        {
            await output.WriteLineAsync($"Usage: {Name} --username <name>  (password via {PasswordVariable} or stdin)");
            return 2;
        }

        var password = getEnvironmentVariable(PasswordVariable);
        if (string.IsNullOrEmpty(password))
        {
            password = await input.ReadLineAsync();
        }

        if (string.IsNullOrEmpty(password))
        {
            await output.WriteLineAsync($"No password provided. Set {PasswordVariable} or pipe it on stdin.");
            return 2;
        }

        await using var scope = services.CreateAsyncScope();
        var result = await scope.ServiceProvider.GetRequiredService<BootstrapAdminService>()
            .BootstrapAsync(args[usernameIndex + 1], password, CancellationToken.None);

        var (exitCode, message) = result switch
        {
            BootstrapResult.Created => (0, "Admin created. The password must be changed at first login."),
            BootstrapResult.AdminAlreadyExists => (1, "An admin already exists; nothing was changed."),
            BootstrapResult.InvalidUsername => (2, "Invalid username: use 3-64 characters from a-z, 0-9, '.', '_' and '-'."),
            BootstrapResult.PolicyViolated violated => (2, "Password rejected: " + string.Join(", ", violated.Errors)),
            _ => (1, "Unexpected result."),
        };

        await output.WriteLineAsync(message);
        return exitCode;
    }
}
