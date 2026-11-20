using Chain.SharedKernel;
namespace Chain.Identity.Application;

public abstract record LoginResult
{
    public sealed record Succeeded(string SessionToken) : LoginResult;

    public sealed record InvalidCredentials : LoginResult;
}

public abstract record ChangePasswordResult
{
    public sealed record Succeeded : ChangePasswordResult;

    public sealed record InvalidCurrentPassword : ChangePasswordResult;

    public sealed record PolicyViolated(IReadOnlyList<string> Errors) : ChangePasswordResult;
}

/// <summary>The authenticated caller: a user with a session, or a bot with an API token (no session).</summary>
public sealed record AuthenticatedUser(
    Guid UserId, Guid? SessionId, string Username, string DisplayName, bool IsAdmin, bool MustChangePassword, ActorKind Kind);

/// <summary>Login, session validation, logout and password change (specs/modules/identity.md, I1).</summary>
public sealed class AuthenticationService(IIdentityStore store, IPasswordHasher hasher, TimeProvider time)
{
    /// <summary>Upper bound on password input, so huge payloads cannot be used to burn CPU in the hasher.</summary>
    public const int MaxPasswordInputLength = 1024;

    // Verified against when the user does not exist, so timing does not reveal valid usernames.
    private readonly Lazy<string> _dummyHash = new(() => hasher.Hash("chain-dummy-password-for-timing"));

    public Task<LoginResult> LoginAsync(string rawUsername, string password, CancellationToken cancellationToken) =>
        store.InTransactionAsync<LoginResult>(async ct =>
        {
            var now = time.GetUtcNow();
            var user = Username.TryCreate(rawUsername, out var username)
                ? await store.FindUserByUsernameAsync(username.Value, ct)
                : null;

            if (user is null || !user.IsActive || user.IsBot)
            {
                hasher.Verify(_dummyHash.Value, password);
                var reason = user is null ? "unknown_user" : user.IsBot ? "bot" : "inactive_user";
                return Fail(user, rawUsername, reason, now);
            }

            if (user.IsLockedAt(now))
            {
                return Fail(user, rawUsername, "locked", now);
            }

            var check = hasher.Verify(user.PasswordHash!, password);
            if (check == PasswordCheck.Failed)
            {
                var outcome = await store.RegisterFailedLoginAsync(user.Id, now, ct);
                if (outcome == FailedLoginOutcome.Locked)
                {
                    store.Audit(new AuditRecord("auth.lockout", null, user.Id, new Dictionary<string, string?>
                    {
                        ["lockedFor"] = LockoutPolicy.LockDuration.ToString(),
                    }), now);
                }

                return Fail(user, rawUsername, outcome == FailedLoginOutcome.AlreadyLocked ? "locked" : "wrong_password", now);
            }

            var upgradedHash = check == PasswordCheck.SuccessRehashNeeded ? hasher.Hash(password) : null;
            await store.RecordSuccessfulLoginAsync(user.Id, upgradedHash, now, ct);

            var token = SessionTokens.Create();
            var session = Session.Start(user.Id, SessionTokens.Hash(token), now);
            store.Add(session);
            store.Audit(new AuditRecord("auth.login.succeeded", user.Id, user.Id, new Dictionary<string, string?>
            {
                ["sessionId"] = session.Id.ToString(),
            }), now);
            await store.SaveChangesAsync(ct);
            return new LoginResult.Succeeded(token);
        }, cancellationToken);

    public Task<AuthenticatedUser?> AuthenticateAsync(string token, CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
        {
            if (string.IsNullOrEmpty(token) || token.Length > SessionTokens.MaxTokenLength)
            {
                return null;
            }

            var found = await store.FindSessionWithUserAsync(SessionTokens.Hash(token), ct);
            var now = time.GetUtcNow();
            if (found is not var (session, user) || !session.IsActiveAt(now) || !user.IsActive)
            {
                return null;
            }

            if (session.NeedsTouch(now))
            {
                await store.TouchSessionAsync(session.Id, now, ct);
            }

            return new AuthenticatedUser(user.Id, session.Id, user.Username, user.DisplayName, user.IsAdmin, user.MustChangePassword, user.Kind);
        }, cancellationToken);

    /// <summary>Authenticates a bot API token (identity.md I3). Failures are audited with the token prefix only.</summary>
    public Task<AuthenticatedUser?> AuthenticateBearerAsync(string? value, CancellationToken cancellationToken) =>
        AuthenticateTokenAsync(value, forMcp: false, cancellationToken);

    /// <summary>
    /// Authenticates a bot API token on the MCP endpoint (ADR-0015 §5): as <see cref="AuthenticateBearerAsync"/>, and the bot
    /// must also have MCP enabled.
    /// </summary>
    public Task<AuthenticatedUser?> AuthenticateMcpAsync(string? value, CancellationToken cancellationToken) =>
        AuthenticateTokenAsync(value, forMcp: true, cancellationToken);

    private Task<AuthenticatedUser?> AuthenticateTokenAsync(string? value, bool forMcp, CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
        {
            var now = time.GetUtcNow();
            if (!ApiTokens.TryGetPrefix(value, out var prefix))
            {
                return TokenFailed(null, "malformed", now);
            }

            var found = await store.FindTokenByPrefixAsync(prefix, ct);
            if (found is not var (token, bot) || !ApiTokens.Matches(value!, token.TokenHash))
            {
                return TokenFailed(prefix, "unknown", now);
            }

            if (token.IsRevoked || !bot.IsActive || !bot.IsBot)
            {
                return TokenFailed(prefix, token.IsRevoked ? "revoked" : "inactive_bot", now);
            }

            if (forMcp && !bot.McpEnabled)
            {
                return TokenFailed(prefix, "mcp_disabled", now);
            }

            if (token.NeedsTouch(now))
            {
                await store.TouchTokenAsync(token.Id, now, ct);
            }

            return new AuthenticatedUser(bot.Id, null, bot.Username, bot.DisplayName, false, false, ActorKind.Bot);
        }, cancellationToken);

    public Task<IReadOnlyList<GroupRef>> GetGroupsAsync(Guid userId, CancellationToken cancellationToken) =>
        store.InTransactionAsync(ct => store.GetGroupsOfUserAsync(userId, ct), cancellationToken);

    public Task LogoutAsync(AuthenticatedUser caller, CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
        {
            var now = time.GetUtcNow();
            if (caller.SessionId is not { } sessionId)
            {
                return false;
            }

            await store.RevokeSessionAsync(sessionId, now, ct);
            store.Audit(new AuditRecord("auth.logout", caller.UserId, caller.UserId, new Dictionary<string, string?>
            {
                ["sessionId"] = caller.SessionId.ToString(),
            }), now);
            await store.SaveChangesAsync(ct);
            return true;
        }, cancellationToken);

    public Task<ChangePasswordResult> ChangePasswordAsync(
        AuthenticatedUser caller, string currentPassword, string newPassword, CancellationToken cancellationToken) =>
        store.InTransactionAsync<ChangePasswordResult>(async ct =>
        {
            var user = await store.FindUserByIdAsync(caller.UserId, ct)
                ?? throw new InvalidOperationException("Authenticated user no longer exists.");

            if (user.IsBot || hasher.Verify(user.PasswordHash!, currentPassword) == PasswordCheck.Failed)
            {
                return new ChangePasswordResult.InvalidCurrentPassword();
            }

            var errors = PasswordPolicy.Validate(newPassword, Username.Create(user.Username));
            if (errors.Count > 0)
            {
                return new ChangePasswordResult.PolicyViolated(errors);
            }

            var now = time.GetUtcNow();
            user.ChangePassword(hasher.Hash(newPassword), now);
            await store.RevokeOtherSessionsAsync(user.Id, caller.SessionId ?? Guid.Empty, now, ct);
            store.Audit(new AuditRecord("auth.password.changed", caller.UserId, user.Id, new Dictionary<string, string?>()), now);
            await store.SaveChangesAsync(ct);
            return new ChangePasswordResult.Succeeded();
        }, cancellationToken);

    private AuthenticatedUser? TokenFailed(string? prefix, string reason, DateTimeOffset now)
    {
        store.Audit(new AuditRecord("auth.token.failed", null, null, new Dictionary<string, string?>
        {
            ["prefix"] = prefix,
            ["reason"] = reason,
        }), now);
        return null;
    }

    /// <summary>
    /// Audits the failure with the username as typed, cut to its maximum length, or null when it is text PostgreSQL cannot store
    /// (identity.md I1, card #129).
    /// </summary>
    private LoginResult.InvalidCredentials Fail(User? user, string rawUsername, string reason, DateTimeOffset now)
    {
        store.Audit(new AuditRecord("auth.login.failed", null, user?.Id, new Dictionary<string, string?>
        {
            ["username"] = !ClientText.IsStorable(rawUsername) ? null
                : rawUsername.Length > Username.MaxLength ? rawUsername[..Username.MaxLength] : rawUsername,
            ["reason"] = reason,
        }), now);
        return new LoginResult.InvalidCredentials();
    }
}
