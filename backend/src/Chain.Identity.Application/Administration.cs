using System.Globalization;
using Chain.SharedKernel;
using System.Security.Cryptography;

namespace Chain.Identity.Application;

public enum AdminError
{
    NotFound,
    ValidationFailed,
    UsernameTaken,
    GroupNameTaken,
    LastAdmin,
    TokenLimitReached,
    CannotDeactivateSelf,
    GroupArchived,
    VersionMismatch,
}

/// <summary>Outcome of an administration use case: a value, or an error with optional validation details.</summary>
public sealed record AdminResult<T>(T? Value, AdminError? Error, IReadOnlyList<string> Details)
{
    public bool IsSuccess => Error is null;
}

public static class AdminResult
{
    public static AdminResult<T> Ok<T>(T value) => new(value, null, []);

    public static AdminResult<T> Fail<T>(AdminError error, params string[] details) => new(default, error, details);
}

public sealed record GroupRef(Guid Id, string Name);

public sealed record UserView(
    Guid Id, string Username, string DisplayName, bool IsAdmin, bool IsActive, bool IsLocked, bool MustChangePassword,
    DateTimeOffset CreatedAt, uint Version, IReadOnlyList<GroupRef> Groups);

public sealed record CreatedUser(UserView User, string TemporaryPassword);

public sealed record MemberView(Guid Id, string Username, string DisplayName, bool IsActive);

/// <param name="IsModeler">The group holds the Modeler grant, which archiving suspends without removing (admin-ui.md §8, S-A1).</param>
public sealed record GroupView(
    Guid Id, string Name, string? Description, bool IsArchived, bool IsModeler, int MemberCount, uint Version, IReadOnlyList<MemberView> Members);

/// <param name="IsModeler">As in <see cref="GroupView"/>.</param>
public sealed record GroupSummary(Guid Id, string Name, string? Description, bool IsArchived, bool IsModeler, int MemberCount);

public sealed record Page<T>(IReadOnlyList<T> Items, int Total);

public sealed record TokenView(Guid Id, string Label, string Prefix, DateTimeOffset CreatedAt, DateTimeOffset? LastUsedAt, DateTimeOffset? RevokedAt);

public sealed record CreatedToken(TokenView Token, string Value);

/// <param name="ActiveTokenCount">The tokens not revoked, which the list carries too although it leaves <paramref name="Tokens"/> empty (admin-ui.md §8, S-A3).</param>
public sealed record BotView(
    Guid Id, string Name, string DisplayName, bool IsActive, bool McpEnabled, int? McpCallsPerMinute, Guid? OwnerId, DateTimeOffset CreatedAt, uint Version,
    int ActiveTokenCount, IReadOnlyList<TokenView> Tokens, IReadOnlyList<GroupRef> Groups);

/// <summary>Server-generated temporary passwords (specs/modules/identity.md, I2).</summary>
public static class TemporaryPasswords
{
    public const int Length = 20;

    // No look-alike characters (0/O, 1/l/I), so the password can be read out or copied by hand.
    private const string Alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    public static string Create() => new(RandomNumberGenerator.GetItems<char>(Alphabet, Length));
}

/// <summary>Admin user management and groups (identity increment I2). Callers must already be authorized as admins.</summary>
public sealed class AdministrationService(IIdentityStore store, IPasswordHasher hasher, TimeProvider time)
{
    public const int MaxPageSize = 200;

    // Users

    public Task<Page<UserView>> ListUsersAsync(string? search, int limit, int offset, CancellationToken cancellationToken)
    {
        if (!ClientText.IsStorable(search))
        {
            // No stored name holds text PostgreSQL cannot store (I1), which it would also refuse in the pattern (card #153).
            return Task.FromResult(new Page<UserView>([], 0));
        }

        return store.InTransactionAsync(async ct =>
        {
            var now = time.GetUtcNow();
            var (users, total) = await store.ListUsersAsync(search?.Trim(), Math.Clamp(limit, 1, MaxPageSize), Math.Max(offset, 0), ct);
            return new Page<UserView>([.. users.Select(u => ToView(u, now, []))], total);
        }, cancellationToken);
    }

    public Task<AdminResult<UserView>> GetUserAsync(Guid id, CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
        {
            var user = await FindActorAsync(id, ActorKind.User, ct);
            return user is null
                ? AdminResult.Fail<UserView>(AdminError.NotFound)
                : AdminResult.Ok<UserView>(ToView(user, time.GetUtcNow(), await store.GetGroupsOfUserAsync(id, ct)));
        }, cancellationToken);

    public async Task<AdminResult<CreatedUser>> CreateUserAsync(
        Guid actorId, string? rawUsername, string? rawDisplayName, bool isAdmin, CancellationToken cancellationToken)
    {
        var errors = new List<string>();
        if (!Username.TryCreate(rawUsername, out var username))
        {
            errors.Add("invalid_username");
        }

        if (!DisplayName.TryCreate(rawDisplayName, out var displayName))
        {
            errors.Add("invalid_display_name");
        }

        if (errors.Count > 0)
        {
            return AdminResult.Fail<CreatedUser>(AdminError.ValidationFailed, [.. errors]);
        }

        try
        {
            return await store.InTransactionAsync(async ct =>
            {
                if (await store.FindUserByUsernameAsync(username.Value, ct) is not null)
                {
                    return AdminResult.Fail<CreatedUser>(AdminError.UsernameTaken);
                }

                var now = time.GetUtcNow();
                var temporaryPassword = TemporaryPasswords.Create();
                var user = User.CreateByAdmin(username, displayName, hasher.Hash(temporaryPassword), isAdmin, now);
                store.Add(user);
                Audit("admin.user.created", actorId, user.Id, now, ("username", user.Username), ("isAdmin", isAdmin.ToString()));
                await store.SaveChangesAsync(ct);
                return AdminResult.Ok<CreatedUser>(new CreatedUser(ToView(user, now, []), temporaryPassword));
            }, cancellationToken);
        }
        catch (UniqueConstraintViolationException)
        {
            return AdminResult.Fail<CreatedUser>(AdminError.UsernameTaken);
        }
    }

    public Task<AdminResult<UserView>> UpdateUserAsync(
        Guid actorId, Guid id, uint expectedVersion, string? rawDisplayName, bool? isAdmin, CancellationToken cancellationToken)
    {
        DisplayName displayName = default;
        if (rawDisplayName is not null && !DisplayName.TryCreate(rawDisplayName, out displayName))
        {
            return Task.FromResult(AdminResult.Fail<UserView>(AdminError.ValidationFailed, "invalid_display_name"));
        }

        return store.InTransactionAsync(async ct =>
        {
            if (isAdmin == false)
            {
                await store.AcquireLockAsync(IdentityLock.AdminSet, ct);
            }

            var user = await FindActorAsync(id, ActorKind.User, ct);
            if (user is null)
            {
                return AdminResult.Fail<UserView>(AdminError.NotFound);
            }

            if (store.VersionOf(user) != expectedVersion)
            {
                return AdminResult.Fail<UserView>(AdminError.VersionMismatch);
            }

            if (isAdmin == false && user.IsAdmin && user.IsActive && await store.CountActiveAdminsAsync(ct) <= 1)
            {
                return AdminResult.Fail<UserView>(AdminError.LastAdmin);
            }

            var now = time.GetUtcNow();
            store.ExpectVersion(user, expectedVersion);
            if (rawDisplayName is not null)
            {
                user.Rename(displayName, now);
            }

            if (isAdmin is { } admin)
            {
                user.SetAdmin(admin, now);
            }

            Audit("admin.user.updated", actorId, user.Id, now, ("displayName", user.DisplayName), ("isAdmin", user.IsAdmin.ToString()));
            await store.SaveChangesAsync(ct);
            return AdminResult.Ok<UserView>(ToView(user, now, await store.GetGroupsOfUserAsync(id, ct)));
        }, cancellationToken);
    }

    public Task<AdminResult<bool>> DeactivateUserAsync(Guid actorId, Guid id, CancellationToken cancellationToken)
    {
        if (actorId == id)
        {
            return Task.FromResult(AdminResult.Fail<bool>(AdminError.CannotDeactivateSelf));
        }

        return store.InTransactionAsync(async ct =>
        {
            await store.AcquireLockAsync(IdentityLock.AdminSet, ct);
            var user = await FindActorAsync(id, ActorKind.User, ct);
            if (user is null)
            {
                return AdminResult.Fail<bool>(AdminError.NotFound);
            }

            if (user.IsAdmin && user.IsActive && await store.CountActiveAdminsAsync(ct) <= 1)
            {
                return AdminResult.Fail<bool>(AdminError.LastAdmin);
            }

            var now = time.GetUtcNow();
            user.Deactivate(now);
            await store.RevokeAllSessionsAsync(user.Id, now, ct);
            Audit("admin.user.deactivated", actorId, user.Id, now);
            return AdminResult.Ok<bool>(true);
        }, cancellationToken);
    }

    public Task<AdminResult<bool>> ActivateUserAsync(Guid actorId, Guid id, CancellationToken cancellationToken) =>
        ChangeActorAsync(actorId, id, ActorKind.User, "admin.user.activated", (user, now) => user.Activate(now), cancellationToken);

    public Task<AdminResult<bool>> UnlockUserAsync(Guid actorId, Guid id, CancellationToken cancellationToken) =>
        ChangeActorAsync(actorId, id, ActorKind.User, "admin.user.unlocked", (user, now) => user.Unlock(now), cancellationToken);

    public Task<AdminResult<string>> ResetPasswordAsync(Guid actorId, Guid id, CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
        {
            var user = await FindActorAsync(id, ActorKind.User, ct);
            if (user is null)
            {
                return AdminResult.Fail<string>(AdminError.NotFound);
            }

            var now = time.GetUtcNow();
            var temporaryPassword = TemporaryPasswords.Create();
            user.ResetPassword(hasher.Hash(temporaryPassword), now);
            await store.RevokeAllSessionsAsync(user.Id, now, ct);
            Audit("admin.user.password_reset", actorId, user.Id, now);
            return AdminResult.Ok<string>(temporaryPassword);
        }, cancellationToken);

    // Groups

    public Task<IReadOnlyList<GroupSummary>> ListGroupsAsync(bool includeArchived, CancellationToken cancellationToken) =>
        store.InTransactionAsync(ct => store.ListGroupsAsync(includeArchived, ct), cancellationToken);

    public Task<AdminResult<GroupView>> GetGroupAsync(Guid id, CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
        {
            var group = await store.FindGroupAsync(id, ct);
            return group is null
                ? AdminResult.Fail<GroupView>(AdminError.NotFound)
                : AdminResult.Ok<GroupView>(await ToViewAsync(group, ct));
        }, cancellationToken);

    public async Task<AdminResult<GroupView>> CreateGroupAsync(Guid actorId, string? rawName, string? description, CancellationToken cancellationToken)
    {
        if (!GroupName.TryCreate(rawName, out var name))
        {
            return AdminResult.Fail<GroupView>(AdminError.ValidationFailed, "invalid_group_name");
        }

        if (description?.Trim().Length > Group.MaxDescriptionLength)
        {
            return AdminResult.Fail<GroupView>(AdminError.ValidationFailed, "description_too_long");
        }

        if (!ClientText.IsStorable(description))
        {
            return AdminResult.Fail<GroupView>(AdminError.ValidationFailed, "invalid_description");
        }

        try
        {
            return await store.InTransactionAsync(async ct =>
            {
                if (await store.GroupNameExistsAsync(name.Normalized, null, ct))
                {
                    return AdminResult.Fail<GroupView>(AdminError.GroupNameTaken);
                }

                var now = time.GetUtcNow();
                var group = Group.Create(name, description, now);
                store.Add(group);
                Audit("admin.group.created", actorId, group.Id, now, ("name", group.Name));
                await store.SaveChangesAsync(ct);
                return AdminResult.Ok<GroupView>(await ToViewAsync(group, ct));
            }, cancellationToken);
        }
        catch (UniqueConstraintViolationException)
        {
            return AdminResult.Fail<GroupView>(AdminError.GroupNameTaken);
        }
    }

    public async Task<AdminResult<GroupView>> UpdateGroupAsync(
        Guid actorId, Guid id, uint expectedVersion, string? rawName, string? description, CancellationToken cancellationToken)
    {
        GroupName name = default;
        if (rawName is not null && !GroupName.TryCreate(rawName, out name))
        {
            return AdminResult.Fail<GroupView>(AdminError.ValidationFailed, "invalid_group_name");
        }

        if (description?.Trim().Length > Group.MaxDescriptionLength)
        {
            return AdminResult.Fail<GroupView>(AdminError.ValidationFailed, "description_too_long");
        }

        if (!ClientText.IsStorable(description))
        {
            return AdminResult.Fail<GroupView>(AdminError.ValidationFailed, "invalid_description");
        }

        try
        {
            return await store.InTransactionAsync(async ct =>
            {
                var group = await store.FindGroupAsync(id, ct);
                if (group is null)
                {
                    return AdminResult.Fail<GroupView>(AdminError.NotFound);
                }

                if (store.VersionOf(group) != expectedVersion)
                {
                    return AdminResult.Fail<GroupView>(AdminError.VersionMismatch);
                }

                if (rawName is not null && await store.GroupNameExistsAsync(name.Normalized, id, ct))
                {
                    return AdminResult.Fail<GroupView>(AdminError.GroupNameTaken);
                }

                var now = time.GetUtcNow();
                store.ExpectVersion(group, expectedVersion);
                if (rawName is not null)
                {
                    group.Rename(name, now);
                }

                if (description is not null)
                {
                    group.Describe(description, now);
                }

                Audit("admin.group.updated", actorId, group.Id, now, ("name", group.Name));
                await store.SaveChangesAsync(ct);
                return AdminResult.Ok<GroupView>(await ToViewAsync(group, ct));
            }, cancellationToken);
        }
        catch (UniqueConstraintViolationException)
        {
            return AdminResult.Fail<GroupView>(AdminError.GroupNameTaken);
        }
    }

    public Task<AdminResult<bool>> ArchiveGroupAsync(Guid actorId, Guid id, bool archived, CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
        {
            var group = await store.FindGroupAsync(id, ct);
            if (group is null)
            {
                return AdminResult.Fail<bool>(AdminError.NotFound);
            }

            var now = time.GetUtcNow();
            if (archived)
            {
                group.Archive(now);
            }
            else
            {
                group.Unarchive(now);
            }

            Audit(archived ? "admin.group.archived" : "admin.group.unarchived", actorId, group.Id, now);
            return AdminResult.Ok<bool>(true);
        }, cancellationToken);

    public Task<AdminResult<bool>> AddMemberAsync(Guid actorId, Guid groupId, Guid userId, CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
        {
            var group = await store.FindGroupAsync(groupId, ct);
            if (group is null || await store.FindUserByIdAsync(userId, ct) is null)
            {
                return AdminResult.Fail<bool>(AdminError.NotFound);
            }

            if (group.IsArchived)
            {
                return AdminResult.Fail<bool>(AdminError.GroupArchived);
            }

            if (await store.FindMembershipAsync(groupId, userId, ct) is not null)
            {
                return AdminResult.Ok<bool>(false); // idempotent: already a member
            }

            var now = time.GetUtcNow();
            store.Add(GroupMember.Create(groupId, userId, now));
            Audit("admin.group.member_added", actorId, groupId, now, ("userId", userId.ToString()));
            return AdminResult.Ok<bool>(true);
        }, cancellationToken);

    public Task<AdminResult<bool>> RemoveMemberAsync(Guid actorId, Guid groupId, Guid userId, CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
        {
            if (await store.FindGroupAsync(groupId, ct) is null)
            {
                return AdminResult.Fail<bool>(AdminError.NotFound);
            }

            var membership = await store.FindMembershipAsync(groupId, userId, ct);
            if (membership is null)
            {
                return AdminResult.Ok<bool>(false); // idempotent: not a member
            }

            var now = time.GetUtcNow();
            store.Remove(membership);
            Audit("admin.group.member_removed", actorId, groupId, now, ("userId", userId.ToString()));
            return AdminResult.Ok<bool>(true);
        }, cancellationToken);

    /// <summary>Grants or revokes the Modeler capability on a group (idempotent; workflow-definition.md §5.4).</summary>
    public Task<AdminResult<bool>> SetModelerAsync(Guid actorId, Guid groupId, bool granted, CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
        {
            var group = await store.FindGroupAsync(groupId, ct);
            if (group is null)
            {
                return AdminResult.Fail<bool>(AdminError.NotFound);
            }

            var existing = await store.FindPlatformGrantAsync(groupId, PlatformCapability.Modeler, ct);
            if (granted == existing is not null)
            {
                return AdminResult.Ok(false); // idempotent: nothing to change
            }

            if (granted && group.IsArchived)
            {
                return AdminResult.Fail<bool>(AdminError.GroupArchived);
            }

            var now = time.GetUtcNow();
            if (granted)
            {
                store.Add(PlatformGrant.Create(groupId, PlatformCapability.Modeler));
            }
            else
            {
                store.Remove(existing!);
            }

            Audit(granted ? "admin.group.modeler_granted" : "admin.group.modeler_revoked", actorId, groupId, now);
            return AdminResult.Ok(true);
        }, cancellationToken);

    // Bots (identity.md I3)

    public Task<IReadOnlyList<BotView>> ListBotsAsync(CancellationToken cancellationToken) =>
        store.InTransactionAsync<IReadOnlyList<BotView>>(async ct =>
        {
            var bots = await store.ListBotsAsync(ct);
            var active = await store.CountActiveTokensByBotAsync(ct);
            return [.. bots.Select(bot => ToBotView(bot, active.GetValueOrDefault(bot.Id), [], []))];
        }, cancellationToken);

    public Task<AdminResult<BotView>> GetBotAsync(Guid id, CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
        {
            var bot = await FindActorAsync(id, ActorKind.Bot, ct);
            return bot is null ? AdminResult.Fail<BotView>(AdminError.NotFound) : AdminResult.Ok(await ToBotViewAsync(bot, ct));
        }, cancellationToken);

    public async Task<AdminResult<BotView>> CreateBotAsync(Guid actorId, string? rawName, string? rawDisplayName, CancellationToken cancellationToken)
    {
        var errors = new List<string>();
        if (!Username.TryCreate(rawName, out var name))
        {
            errors.Add("invalid_name");
        }

        if (!DisplayName.TryCreate(rawDisplayName, out var displayName))
        {
            errors.Add("invalid_display_name");
        }

        if (errors.Count > 0)
        {
            return AdminResult.Fail<BotView>(AdminError.ValidationFailed, [.. errors]);
        }

        try
        {
            return await store.InTransactionAsync(async ct =>
            {
                if (await store.FindUserByUsernameAsync(name.Value, ct) is not null)
                {
                    return AdminResult.Fail<BotView>(AdminError.UsernameTaken);
                }

                var now = time.GetUtcNow();
                var bot = User.CreateBot(name, displayName, actorId, now);
                store.Add(bot);
                Audit("admin.bot.created", actorId, bot.Id, now, ("name", bot.Username));
                await store.SaveChangesAsync(ct);
                return AdminResult.Ok(ToBotView(bot, 0, [], []));
            }, cancellationToken);
        }
        catch (UniqueConstraintViolationException)
        {
            return AdminResult.Fail<BotView>(AdminError.UsernameTaken);
        }
    }

    public Task<AdminResult<BotView>> UpdateBotAsync(Guid actorId, Guid id, uint expectedVersion, string? rawDisplayName, CancellationToken cancellationToken)
    {
        if (!DisplayName.TryCreate(rawDisplayName, out var displayName))
        {
            return Task.FromResult(AdminResult.Fail<BotView>(AdminError.ValidationFailed, "invalid_display_name"));
        }

        return store.InTransactionAsync(async ct =>
        {
            var bot = await FindActorAsync(id, ActorKind.Bot, ct);
            if (bot is null)
            {
                return AdminResult.Fail<BotView>(AdminError.NotFound);
            }

            if (store.VersionOf(bot) != expectedVersion)
            {
                return AdminResult.Fail<BotView>(AdminError.VersionMismatch);
            }

            var now = time.GetUtcNow();
            store.ExpectVersion(bot, expectedVersion);
            bot.Rename(displayName, now);
            Audit("admin.bot.updated", actorId, bot.Id, now, ("displayName", bot.DisplayName));
            await store.SaveChangesAsync(ct);
            return AdminResult.Ok(await ToBotViewAsync(bot, ct));
        }, cancellationToken);
    }

    public Task<AdminResult<bool>> SetBotActiveAsync(Guid actorId, Guid id, bool active, CancellationToken cancellationToken) =>
        ChangeActorAsync(
            actorId, id, ActorKind.Bot, active ? "admin.bot.activated" : "admin.bot.deactivated",
            (bot, now) =>
            {
                if (active)
                {
                    bot.Activate(now);
                }
                else
                {
                    bot.Deactivate(now);
                }
            },
            cancellationToken);

    /// <summary>Allows or stops the bot's tokens on the MCP endpoint (ADR-0015 §5, Q-M4).</summary>
    public Task<AdminResult<bool>> SetBotMcpEnabledAsync(Guid actorId, Guid id, bool enabled, CancellationToken cancellationToken) =>
        ChangeActorAsync(
            actorId, id, ActorKind.Bot, enabled ? "admin.bot.mcp_enabled" : "admin.bot.mcp_disabled",
            (bot, now) => bot.SetMcpEnabled(enabled, now),
            cancellationToken);

    /// <summary>The most an admin may give one bot (identity.md, MCP access).</summary>
    public const int MaxMcpCallsPerMinute = 600;

    /// <summary>
    /// Sets the bot's own MCP rate, 1 to <see cref="MaxMcpCallsPerMinute"/> calls a minute, or returns it to the default with null
    /// (identity.md, MCP access; mcp.md §5; card #83, N9b-3). It applies to the bot's next call.
    /// </summary>
    public Task<AdminResult<BotView>> SetBotMcpRateAsync(Guid actorId, Guid id, int? callsPerMinute, CancellationToken cancellationToken)
    {
        if (callsPerMinute is < 1 or > MaxMcpCallsPerMinute)
        {
            return Task.FromResult(AdminResult.Fail<BotView>(AdminError.ValidationFailed, "invalid_calls_per_minute"));
        }

        return store.InTransactionAsync(async ct =>
        {
            if (await FindActorAsync(id, ActorKind.Bot, ct) is not { } bot)
            {
                return AdminResult.Fail<BotView>(AdminError.NotFound);
            }

            var now = time.GetUtcNow();
            bot.SetMcpRate(callsPerMinute, now);
            Audit("admin.bot.mcp_rate_changed", actorId, bot.Id, now,
                ("callsPerMinute", callsPerMinute?.ToString(CultureInfo.InvariantCulture) ?? "default"));
            await store.SaveChangesAsync(ct);
            return AdminResult.Ok(await ToBotViewAsync(bot, ct));
        }, cancellationToken);
    }

    public Task<AdminResult<CreatedToken>> CreateTokenAsync(Guid actorId, Guid botId, string? rawLabel, CancellationToken cancellationToken)
    {
        var label = rawLabel?.Trim();
        if (string.IsNullOrEmpty(label) || label.Length > BotToken.MaxLabelLength || !ClientText.IsStorable(label))
        {
            return Task.FromResult(AdminResult.Fail<CreatedToken>(AdminError.ValidationFailed, "invalid_label"));
        }

        return store.InTransactionAsync(async ct =>
        {
            var bot = await FindActorAsync(botId, ActorKind.Bot, ct);
            if (bot is null)
            {
                return AdminResult.Fail<CreatedToken>(AdminError.NotFound);
            }

            if (await store.CountActiveTokensAsync(botId, ct) >= BotToken.MaxActivePerBot)
            {
                return AdminResult.Fail<CreatedToken>(AdminError.TokenLimitReached);
            }

            var (value, prefix, hash) = ApiTokens.Create();
            while (await store.FindTokenByPrefixAsync(prefix, ct) is not null)
            {
                (value, prefix, hash) = ApiTokens.Create(); // 40-bit prefixes: collisions are astronomically rare
            }

            var now = time.GetUtcNow();
            var token = BotToken.Create(botId, label, prefix, hash, actorId, now);
            store.Add(token);
            Audit("admin.bot.token_created", actorId, botId, now, ("tokenId", token.Id.ToString()), ("prefix", prefix), ("label", label));
            return AdminResult.Ok(new CreatedToken(ToTokenView(token), value));
        }, cancellationToken);
    }

    public Task<AdminResult<bool>> RevokeTokenAsync(Guid actorId, Guid botId, Guid tokenId, CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
        {
            var token = await store.FindTokenAsync(botId, tokenId, ct);
            if (token is null)
            {
                return AdminResult.Fail<bool>(AdminError.NotFound);
            }

            if (token.IsRevoked)
            {
                return AdminResult.Ok(false); // idempotent
            }

            var now = time.GetUtcNow();
            token.Revoke(now);
            Audit("admin.bot.token_revoked", actorId, botId, now, ("tokenId", token.Id.ToString()), ("prefix", token.Prefix));
            return AdminResult.Ok(true);
        }, cancellationToken);

    // Helpers

    private async Task<BotView> ToBotViewAsync(User bot, CancellationToken cancellationToken)
    {
        var tokens = await store.GetTokensAsync(bot.Id, cancellationToken);
        return ToBotView(bot, tokens.Count(token => token.RevokedAt is null), [.. tokens.Select(ToTokenView)], await store.GetGroupsOfUserAsync(bot.Id, cancellationToken));
    }

    private BotView ToBotView(User bot, int activeTokenCount, IReadOnlyList<TokenView> tokens, IReadOnlyList<GroupRef> groups) => new(
        bot.Id, bot.Username, bot.DisplayName, bot.IsActive, bot.McpEnabled, bot.McpCallsPerMinute, bot.OwnerId, bot.CreatedAt, store.VersionOf(bot), activeTokenCount,
        tokens, groups);

    private static TokenView ToTokenView(BotToken token) =>
        new(token.Id, token.Label, token.Prefix, token.CreatedAt, token.LastUsedAt, token.RevokedAt);

    private async Task<User?> FindActorAsync(Guid id, ActorKind kind, CancellationToken cancellationToken)
    {
        var actor = await store.FindUserByIdAsync(id, cancellationToken);
        return actor?.Kind == kind ? actor : null;
    }

    private Task<AdminResult<bool>> ChangeActorAsync(
        Guid actorId, Guid id, ActorKind kind, string action, Action<User, DateTimeOffset> change, CancellationToken cancellationToken) =>
        store.InTransactionAsync(async ct =>
        {
            var user = await FindActorAsync(id, kind, ct);
            if (user is null)
            {
                return AdminResult.Fail<bool>(AdminError.NotFound);
            }

            var now = time.GetUtcNow();
            change(user, now);
            Audit(action, actorId, user.Id, now);
            return AdminResult.Ok<bool>(true);
        }, cancellationToken);

    private UserView ToView(User user, DateTimeOffset now, IReadOnlyList<GroupRef> groups) => new(
        user.Id, user.Username, user.DisplayName, user.IsAdmin, user.IsActive, user.IsLockedAt(now), user.MustChangePassword,
        user.CreatedAt, store.VersionOf(user), groups);

    private async Task<GroupView> ToViewAsync(Group group, CancellationToken cancellationToken)
    {
        var members = await store.GetMembersAsync(group.Id, cancellationToken);
        var isModeler = await store.FindPlatformGrantAsync(group.Id, PlatformCapability.Modeler, cancellationToken) is not null;
        return new GroupView(group.Id, group.Name, group.Description, group.IsArchived, isModeler, members.Count, store.VersionOf(group), members);
    }

    private void Audit(string action, Guid actorId, Guid subjectId, DateTimeOffset now, params (string Key, string? Value)[] details) =>
        store.Audit(new AuditRecord(action, actorId, subjectId, details.ToDictionary(d => d.Key, d => d.Value)), now);
}
