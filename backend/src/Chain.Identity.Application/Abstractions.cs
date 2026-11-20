using Chain.SharedKernel;

namespace Chain.Identity.Application;

public enum PasswordCheck { Failed, Success, SuccessRehashNeeded }

public interface IPasswordHasher
{
    string Hash(string password);

    PasswordCheck Verify(string hash, string password);
}


/// <summary>Outcome of the atomic failed-login update (ADR-0008 §6).</summary>
public enum FailedLoginOutcome
{
    /// <summary>The failure was counted; the account is still unlocked.</summary>
    Counted,

    /// <summary>This failure reached the limit and locked the account.</summary>
    Locked,

    /// <summary>The account was already locked; nothing was counted.</summary>
    AlreadyLocked,
}

/// <summary>Named critical sections, implemented as transaction-scoped database advisory locks.</summary>
public enum IdentityLock
{
    /// <summary>Creating the first admin.</summary>
    Bootstrap,

    /// <summary>Any change that can reduce the number of active admins.</summary>
    AdminSet,
}



/// <summary>Persistence for identity. Every use case runs inside <see cref="InTransactionAsync{T}"/> (ADR-0008 §1).</summary>
public interface IIdentityStore
{
    /// <summary>
    /// Runs <paramref name="work"/> in one database transaction. Tracked changes are saved and the transaction is
    /// committed when the work completes; any exception rolls everything back.
    /// </summary>
    Task<T> InTransactionAsync<T>(Func<CancellationToken, Task<T>> work, CancellationToken cancellationToken);

    /// <summary>Takes a transaction-scoped lock, serializing concurrent holders until commit or rollback.</summary>
    Task AcquireLockAsync(IdentityLock identityLock, CancellationToken cancellationToken);

    Task<int> CountActiveAdminsAsync(CancellationToken cancellationToken);

    Task<(IReadOnlyList<User> Users, int Total)> ListUsersAsync(string? search, int limit, int offset, CancellationToken cancellationToken);

    Task<IReadOnlyList<GroupRef>> GetGroupsOfUserAsync(Guid userId, CancellationToken cancellationToken);

    Task RevokeAllSessionsAsync(Guid userId, DateTimeOffset now, CancellationToken cancellationToken);

    Task<Group?> FindGroupAsync(Guid id, CancellationToken cancellationToken);

    Task<bool> GroupNameExistsAsync(string normalizedName, Guid? excludingGroupId, CancellationToken cancellationToken);

    Task<IReadOnlyList<GroupSummary>> ListGroupsAsync(bool includeArchived, CancellationToken cancellationToken);

    Task<IReadOnlyList<MemberView>> GetMembersAsync(Guid groupId, CancellationToken cancellationToken);

    Task<GroupMember?> FindMembershipAsync(Guid groupId, Guid userId, CancellationToken cancellationToken);

    Task<IReadOnlyList<User>> ListBotsAsync(CancellationToken cancellationToken);

    Task<(BotToken Token, User Bot)?> FindTokenByPrefixAsync(string prefix, CancellationToken cancellationToken);

    Task<BotToken?> FindTokenAsync(Guid botId, Guid tokenId, CancellationToken cancellationToken);

    Task<IReadOnlyList<BotToken>> GetTokensAsync(Guid botId, CancellationToken cancellationToken);

    Task<int> CountActiveTokensAsync(Guid botId, CancellationToken cancellationToken);

    /// <summary>The tokens not revoked, by bot; a bot without any is absent.</summary>
    Task<IReadOnlyDictionary<Guid, int>> CountActiveTokensByBotAsync(CancellationToken cancellationToken);

    Task TouchTokenAsync(Guid tokenId, DateTimeOffset now, CancellationToken cancellationToken);

    /// <summary>The optimistic-concurrency version (<c>xmin</c>) of a loaded aggregate.</summary>
    uint VersionOf(object aggregate);

    /// <summary>Makes the next save fail with <see cref="ConcurrencyConflictException"/> unless the row still has this version.</summary>
    void ExpectVersion(object aggregate, uint version);

    Task<bool> AnyAdminAsync(CancellationToken cancellationToken);

    Task<User?> FindUserByUsernameAsync(string username, CancellationToken cancellationToken);

    Task<User?> FindUserByIdAsync(Guid id, CancellationToken cancellationToken);

    Task<(Session Session, User User)?> FindSessionWithUserAsync(string tokenHash, CancellationToken cancellationToken);

    Task<FailedLoginOutcome> RegisterFailedLoginAsync(Guid userId, DateTimeOffset now, CancellationToken cancellationToken);

    /// <summary>Atomically clears the failure count and lock, optionally storing an upgraded password hash.</summary>
    Task RecordSuccessfulLoginAsync(Guid userId, string? upgradedPasswordHash, DateTimeOffset now, CancellationToken cancellationToken);

    Task TouchSessionAsync(Guid sessionId, DateTimeOffset now, CancellationToken cancellationToken);

    Task RevokeSessionAsync(Guid sessionId, DateTimeOffset now, CancellationToken cancellationToken);

    Task RevokeOtherSessionsAsync(Guid userId, Guid keepSessionId, DateTimeOffset now, CancellationToken cancellationToken);

    void Add(User user);

    void Add(Session session);

    void Add(Group group);

    void Add(GroupMember membership);

    void Remove(GroupMember membership);

    void Add(BotToken token);

    Task<PlatformGrant?> FindPlatformGrantAsync(Guid groupId, PlatformCapability capability, CancellationToken cancellationToken);

    void Add(PlatformGrant grant);

    void Remove(PlatformGrant grant);

    void Audit(AuditRecord record, DateTimeOffset now);

    /// <summary>Persists tracked changes; throws <see cref="ConcurrencyConflictException"/> on a stale version.</summary>
    Task SaveChangesAsync(CancellationToken cancellationToken);
}
