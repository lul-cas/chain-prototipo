using Chain.Forms;

namespace Chain.Forms.Application;

public interface IKnownFileSource
{
    Task<IReadOnlyDictionary<Guid, FileBinding>> FindAsync(IReadOnlyCollection<Guid> ids, CancellationToken cancellationToken);
}
