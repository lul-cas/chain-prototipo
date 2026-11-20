namespace Chain.SharedKernel;

/// <summary>Raised when an optimistic-concurrency check fails (ADR-0008 §2).</summary>
public sealed class ConcurrencyConflictException(Exception? inner = null)
    : Exception("The record was changed by another request.", inner);

/// <summary>Raised when a unique constraint rejects a write (for example two concurrent creations of the same name).</summary>
public sealed class UniqueConstraintViolationException(string? constraint, Exception? inner = null)
    : Exception($"Unique constraint '{constraint}' was violated.", inner)
{
    public string? Constraint { get; } = constraint;
}

/// <summary>An audit record (NFR-001). Never contains secrets.</summary>
public sealed record AuditRecord(string Action, Guid? ActorId, Guid? SubjectId, IReadOnlyDictionary<string, string?> Details);

/// <summary>Who may model workflows and forms: admins and members of non-archived groups granted Modeler (ADR-0006 §3).</summary>
public interface IModelingAuthorization
{
    Task<bool> CanModelAsync(Guid actorId, CancellationToken cancellationToken);
}

/// <summary>The time zone that defines "today" for conditions and date bounds (ADR-0003 §2; fixed UTC−03:00 for now, Q-15).</summary>
public sealed record EvaluationZone(TimeSpan Offset)
{
    public static readonly EvaluationZone Default = new(TimeSpan.FromHours(-3));
}
