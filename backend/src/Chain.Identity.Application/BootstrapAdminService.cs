using Chain.SharedKernel;
namespace Chain.Identity.Application;

public abstract record BootstrapResult
{
    public sealed record Created(Guid UserId) : BootstrapResult;

    public sealed record AdminAlreadyExists : BootstrapResult;

    public sealed record InvalidUsername : BootstrapResult;

    public sealed record PolicyViolated(IReadOnlyList<string> Errors) : BootstrapResult;
}

/// <summary>Creates the first admin of an environment, exactly once (ADR-0006 §4).</summary>
public sealed class BootstrapAdminService(IIdentityStore store, IPasswordHasher hasher, TimeProvider time)
{
    public async Task<BootstrapResult> BootstrapAsync(string rawUsername, string password, CancellationToken cancellationToken)
    {
        if (!Username.TryCreate(rawUsername, out var username))
        {
            return new BootstrapResult.InvalidUsername();
        }

        var errors = PasswordPolicy.Validate(password, username);
        if (errors.Count > 0)
        {
            return new BootstrapResult.PolicyViolated(errors);
        }

        return await store.InTransactionAsync<BootstrapResult>(async ct =>
        {
            await store.AcquireLockAsync(IdentityLock.Bootstrap, ct);
            if (await store.AnyAdminAsync(ct))
            {
                return new BootstrapResult.AdminAlreadyExists();
            }

            var now = time.GetUtcNow();
            var admin = User.CreateBootstrapAdmin(username, hasher.Hash(password), now);
            store.Add(admin);
            store.Audit(new AuditRecord("auth.admin.bootstrapped", null, admin.Id, new Dictionary<string, string?>
            {
                ["username"] = admin.Username,
            }), now);
            return new BootstrapResult.Created(admin.Id);
        }, cancellationToken);
    }
}
