using Chain.SharedKernel;
using Chain.Identity;
using Chain.Identity.Application;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Chain.Infrastructure.Identity;

internal sealed class IdentityStore(ChainDbContext db) : StoreBase(db), IIdentityStore
{
    // Arbitrary constants identifying advisory-lock critical sections.
    private const long BootstrapLockKey = 7_301_202_610_150_001;
    private const long AdminSetLockKey = 7_301_202_610_150_002;

    public Task AcquireLockAsync(IdentityLock identityLock, CancellationToken cancellationToken)
    {
        var key = identityLock switch
        {
            IdentityLock.Bootstrap => BootstrapLockKey,
            IdentityLock.AdminSet => AdminSetLockKey,
            _ => throw new ArgumentOutOfRangeException(nameof(identityLock)),
        };
        return Db.Database.ExecuteSqlAsync($"SELECT pg_advisory_xact_lock({key})", cancellationToken);
    }

    public Task<int> CountActiveAdminsAsync(CancellationToken cancellationToken) =>
        Db.Users.CountAsync(u => u.IsAdmin && u.IsActive, cancellationToken);

    public async Task<(IReadOnlyList<User> Users, int Total)> ListUsersAsync(string? search, int limit, int offset, CancellationToken cancellationToken)
    {
        var query = Db.Users.AsNoTracking().Where(u => u.Kind == ActorKind.User);
        if (!string.IsNullOrEmpty(search))
        {
            var pattern = "%" + EscapeLike(search) + "%";
            query = query.Where(u => EF.Functions.ILike(u.Username, pattern, "\\") || EF.Functions.ILike(u.DisplayName, pattern, "\\"));
        }

        var total = await query.CountAsync(cancellationToken);
        var users = await query.OrderBy(u => u.Username).Skip(offset).Take(limit).ToListAsync(cancellationToken);
        return (users, total);
    }

    public async Task<IReadOnlyList<GroupRef>> GetGroupsOfUserAsync(Guid userId, CancellationToken cancellationToken) =>
        await (from member in Db.GroupMembers
               join grp in Db.Groups on member.GroupId equals grp.Id
               where member.UserId == userId
               orderby grp.Name
               select new GroupRef(grp.Id, grp.Name)).ToListAsync(cancellationToken);

    public Task RevokeAllSessionsAsync(Guid userId, DateTimeOffset now, CancellationToken cancellationToken) =>
        Db.Sessions.Where(s => s.UserId == userId && s.RevokedAt == null)
            .ExecuteUpdateAsync(set => set.SetProperty(s => s.RevokedAt, now), cancellationToken);

    public Task<Group?> FindGroupAsync(Guid id, CancellationToken cancellationToken) =>
        Db.Groups.SingleOrDefaultAsync(g => g.Id == id, cancellationToken);

    public Task<bool> GroupNameExistsAsync(string normalizedName, Guid? excludingGroupId, CancellationToken cancellationToken) =>
        Db.Groups.AnyAsync(g => g.NormalizedName == normalizedName && g.Id != excludingGroupId, cancellationToken);

    public async Task<IReadOnlyList<GroupSummary>> ListGroupsAsync(bool includeArchived, CancellationToken cancellationToken) =>
        await Db.Groups.AsNoTracking()
            .Where(g => includeArchived || !g.IsArchived)
            .OrderBy(g => g.Name)
            .Select(g => new GroupSummary(
                g.Id,
                g.Name,
                g.Description,
                g.IsArchived,
                Db.PlatformGrants.Any(p => p.GroupId == g.Id && p.Capability == PlatformCapability.Modeler),
                Db.GroupMembers.Count(m => m.GroupId == g.Id)))
            .ToListAsync(cancellationToken);

    public async Task<IReadOnlyList<MemberView>> GetMembersAsync(Guid groupId, CancellationToken cancellationToken) =>
        await (from member in Db.GroupMembers
               join user in Db.Users on member.UserId equals user.Id
               where member.GroupId == groupId
               orderby user.Username
               select new MemberView(user.Id, user.Username, user.DisplayName, user.IsActive)).ToListAsync(cancellationToken);

    public Task<GroupMember?> FindMembershipAsync(Guid groupId, Guid userId, CancellationToken cancellationToken) =>
        Db.GroupMembers.SingleOrDefaultAsync(m => m.GroupId == groupId && m.UserId == userId, cancellationToken);

    public async Task<IReadOnlyList<User>> ListBotsAsync(CancellationToken cancellationToken) =>
        await Db.Users.Where(u => u.Kind == ActorKind.Bot).OrderBy(u => u.Username).ToListAsync(cancellationToken);

    public async Task<(BotToken Token, User Bot)?> FindTokenByPrefixAsync(string prefix, CancellationToken cancellationToken)
    {
        var found = await (
            from token in Db.BotTokens.AsNoTracking()
            join bot in Db.Users.AsNoTracking() on token.BotId equals bot.Id
            where token.Prefix == prefix
            select new { token, bot }).SingleOrDefaultAsync(cancellationToken);

        return found is null ? null : (found.token, found.bot);
    }

    public Task<BotToken?> FindTokenAsync(Guid botId, Guid tokenId, CancellationToken cancellationToken) =>
        Db.BotTokens.SingleOrDefaultAsync(t => t.BotId == botId && t.Id == tokenId, cancellationToken);

    public async Task<IReadOnlyList<BotToken>> GetTokensAsync(Guid botId, CancellationToken cancellationToken) =>
        await Db.BotTokens.AsNoTracking().Where(t => t.BotId == botId).OrderBy(t => t.CreatedAt).ToListAsync(cancellationToken);

    public Task<int> CountActiveTokensAsync(Guid botId, CancellationToken cancellationToken) =>
        Db.BotTokens.CountAsync(t => t.BotId == botId && t.RevokedAt == null, cancellationToken);

    public async Task<IReadOnlyDictionary<Guid, int>> CountActiveTokensByBotAsync(CancellationToken cancellationToken) =>
        await Db.BotTokens.AsNoTracking()
            .Where(t => t.RevokedAt == null)
            .GroupBy(t => t.BotId)
            .Select(g => new { BotId = g.Key, Count = g.Count() })
            .ToDictionaryAsync(g => g.BotId, g => g.Count, cancellationToken);

    public Task TouchTokenAsync(Guid tokenId, DateTimeOffset now, CancellationToken cancellationToken) =>
        Db.BotTokens.Where(t => t.Id == tokenId)
            .ExecuteUpdateAsync(set => set.SetProperty(t => t.LastUsedAt, now), cancellationToken);

    public Task<bool> AnyAdminAsync(CancellationToken cancellationToken) =>
        Db.Users.AnyAsync(u => u.IsAdmin, cancellationToken);

    public Task<User?> FindUserByUsernameAsync(string username, CancellationToken cancellationToken) =>
        Db.Users.SingleOrDefaultAsync(u => u.Username == username, cancellationToken);

    public Task<User?> FindUserByIdAsync(Guid id, CancellationToken cancellationToken) =>
        Db.Users.SingleOrDefaultAsync(u => u.Id == id, cancellationToken);

    public async Task<(Session Session, User User)?> FindSessionWithUserAsync(string tokenHash, CancellationToken cancellationToken)
    {
        var found = await (
            from session in Db.Sessions.AsNoTracking()
            join user in Db.Users.AsNoTracking() on session.UserId equals user.Id
            where session.TokenHash == tokenHash
            select new { session, user }).SingleOrDefaultAsync(cancellationToken);

        return found is null ? null : (found.session, found.user);
    }

    public async Task<FailedLoginOutcome> RegisterFailedLoginAsync(Guid userId, DateTimeOffset now, CancellationToken cancellationToken)
    {
        // One atomic statement (ADR-0008 §6). PostgreSQL evaluates every SET expression against the old row,
        // and concurrent updates of the same row are serialized and re-check the WHERE clause.
        var lockUntil = now.Add(LockoutPolicy.LockDuration);
        var max = LockoutPolicy.MaxFailedAttempts;
        var rows = await Db.Database.SqlQuery<DateTimeOffset?>($"""
            UPDATE chain.users SET
                failed_login_count = CASE WHEN failed_login_count + 1 >= {max} THEN 0 ELSE failed_login_count + 1 END,
                locked_until = CASE WHEN failed_login_count + 1 >= {max} THEN {lockUntil} ELSE locked_until END
            WHERE id = {userId} AND (locked_until IS NULL OR locked_until <= {now})
            RETURNING locked_until AS "Value"
            """).ToListAsync(cancellationToken);

        return rows switch
        {
            [] => FailedLoginOutcome.AlreadyLocked,
            [var lockedUntil] when lockedUntil > now => FailedLoginOutcome.Locked,
            _ => FailedLoginOutcome.Counted,
        };
    }

    public Task RecordSuccessfulLoginAsync(Guid userId, string? upgradedPasswordHash, DateTimeOffset now, CancellationToken cancellationToken) =>
        upgradedPasswordHash is null
            ? Db.Users.Where(u => u.Id == userId).ExecuteUpdateAsync(set => set
                .SetProperty(u => u.FailedLoginCount, 0)
                .SetProperty(u => u.LockedUntil, (DateTimeOffset?)null), cancellationToken)
            : Db.Users.Where(u => u.Id == userId).ExecuteUpdateAsync(set => set
                .SetProperty(u => u.FailedLoginCount, 0)
                .SetProperty(u => u.LockedUntil, (DateTimeOffset?)null)
                .SetProperty(u => u.PasswordHash, upgradedPasswordHash)
                .SetProperty(u => u.UpdatedAt, now), cancellationToken);

    public Task TouchSessionAsync(Guid sessionId, DateTimeOffset now, CancellationToken cancellationToken) =>
        Db.Sessions.Where(s => s.Id == sessionId)
            .ExecuteUpdateAsync(set => set.SetProperty(s => s.LastSeenAt, now), cancellationToken);

    public Task RevokeSessionAsync(Guid sessionId, DateTimeOffset now, CancellationToken cancellationToken) =>
        Db.Sessions.Where(s => s.Id == sessionId && s.RevokedAt == null)
            .ExecuteUpdateAsync(set => set.SetProperty(s => s.RevokedAt, now), cancellationToken);

    public Task RevokeOtherSessionsAsync(Guid userId, Guid keepSessionId, DateTimeOffset now, CancellationToken cancellationToken) =>
        Db.Sessions.Where(s => s.UserId == userId && s.Id != keepSessionId && s.RevokedAt == null)
            .ExecuteUpdateAsync(set => set.SetProperty(s => s.RevokedAt, now), cancellationToken);

    public void Add(User user) => Db.Users.Add(user);

    public void Add(Session session) => Db.Sessions.Add(session);

    public void Add(Group group) => Db.Groups.Add(group);

    public void Add(GroupMember membership) => Db.GroupMembers.Add(membership);

    public void Remove(GroupMember membership) => Db.GroupMembers.Remove(membership);

    public void Add(BotToken token) => Db.BotTokens.Add(token);

    public Task<PlatformGrant?> FindPlatformGrantAsync(Guid groupId, PlatformCapability capability, CancellationToken cancellationToken) =>
        Db.PlatformGrants.SingleOrDefaultAsync(g => g.GroupId == groupId && g.Capability == capability, cancellationToken);

    public void Add(PlatformGrant grant) => Db.PlatformGrants.Add(grant);

    public void Remove(PlatformGrant grant) => Db.PlatformGrants.Remove(grant);

    private static string EscapeLike(string value) =>
        value.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("%", "\\%", StringComparison.Ordinal).Replace("_", "\\_", StringComparison.Ordinal);

}
