using Chain.Workflows.Application.Engine;
using Chain.Workflows.Modeling;
using Chain.Workflows.Runtime;

namespace Chain.Workflows.Application.Engine;

public sealed class InstanceAccess(IInstanceStore store)
{
    public async Task<bool> CanSeeAsync(ActorInfo actor, Instance instance, CancellationToken cancellationToken)
    {
        if (actor.IsAdmin || instance.RequesterId == actor.Id || await store.IsParticipantAsync(instance.Id, actor.Id, cancellationToken))
        {
            return true;
        }

        if ((await store.GetOpenTasksAsync(instance.Id, cancellationToken)).Any(task => actor.IsEligibleFor(task, instance)))
        {
            return true;
        }

        if (await store.HasCapabilityAsync(instance.DefinitionId, actor.ActiveGroupIds, WorkflowCapability.View, cancellationToken)
            || await store.HasCapabilityAsync(instance.DefinitionId, actor.ActiveGroupIds, WorkflowCapability.Close, cancellationToken))
        {
            return true;
        }

        return instance.ParentInstanceId is { } parentId
            && await store.FindInstanceAsync(parentId, cancellationToken) is { } parent
            && await CanSeeAsync(actor, parent, cancellationToken);
    }
}
