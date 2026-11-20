using System.Diagnostics;
using System.Globalization;
using Chain.SharedKernel;

namespace Chain.Automations.Application;

/// <summary>A configured KEK by id, with its check value (ADR-0017 §4.3), and whether it is the active one; never its material.</summary>
public sealed record KekInfo(string Id, string CheckValue, bool Active);

/// <summary>A secret whose data key doesn't unwrap with the KEK its row names, and why.</summary>
public sealed record SecretKeyProblem(string Name, int Version, string KeyId, KeyCheck Reason);

/// <summary>What <c>automation-keks status</c> shows (ADR-0017 §5.2): never key material, wrapped keys or values.</summary>
public sealed record KekStatus(IReadOnlyList<KekInfo> Keys, IReadOnlyDictionary<string, int> SecretsPerKey, IReadOnlyList<SecretKeyProblem> Problems);

/// <summary>A secret a run moved, with its place in the run.</summary>
public sealed record SecretMoved(string Name, int Version, string FromKeyId, string ToKeyId, int Position, int Count);

/// <summary>The end of a run: what moved, what was already on the active key, what failed or is gone, and the secrets left per key.</summary>
public sealed record RewrapReport(
    string RunId, string ActiveKeyId, int Moved, int Current, IReadOnlyList<SecretKeyProblem> Failed, IReadOnlyList<string> Gone,
    IReadOnlyDictionary<string, int> Left)
{
    /// <summary>Every secret is on the active key and opens with it: the command's exit code 0.</summary>
    public bool Complete => Failed.Count == 0 && Left.Keys.All(key => key == ActiveKeyId);
}

/// <summary>
/// Moves every secret's data key under the active KEK (ADR-0017 §5.2, card #77): the service behind <c>automation-keks</c>,
/// whose CLI verb is only an adapter. Values are never decrypted. Each secret moves in its own transaction, so a run stopped
/// part-way leaves each wholly on one key or the other, and a rerun finishes the rest. The database is the only state.
/// </summary>
public sealed class KekRotationService(IAutomationStore store, KeyRing ring, TimeProvider time)
{
    /// <summary>The configured keys, by id, with their check values.</summary>
    public IReadOnlyList<KekInfo> Keys() =>
        [.. ring.Ids.Order(StringComparer.Ordinal).Select(id => new KekInfo(id, ring.Find(id)!.CheckValue, ring.Active?.Id == id))];

    /// <summary>Read-only: the keys, the secrets per key id, and every secret that doesn't unwrap with the key its row names.</summary>
    public async Task<KekStatus> StatusAsync(CancellationToken cancellationToken)
    {
        var secrets = await store.InTransactionAsync(store.ListSecretsAsync, cancellationToken);
        store.ClearTracking();
        var problems = secrets
            .Select(secret => (Secret: secret, Check: SecretEnvelope.Check(ring, secret.Name, secret.Version, secret.Sealed)))
            .Where(pair => pair.Check != KeyCheck.Opens)
            .Select(pair => new SecretKeyProblem(pair.Secret.Name, pair.Secret.Version, pair.Secret.KeyId, pair.Check))
            .ToList();
        return new KekStatus(Keys(), PerKey(secrets), problems);
    }

    /// <summary>
    /// Moves every secret that isn't on the active key, reporting each one moved to <paramref name="moved"/>. Null when no KEK is
    /// active. The run's id is the correlation id of all its audit records.
    /// </summary>
    public async Task<RewrapReport?> RewrapAsync(Action<SecretMoved> moved, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(moved);
        if (ring.Active is not { } active)
        {
            return null;
        }

        using var run = new Activity("automation-keks.rewrap").SetIdFormat(ActivityIdFormat.W3C).Start();
        var runId = run.TraceId.ToString();
        var names = await store.InTransactionAsync(store.SecretNamesAsync, cancellationToken);
        var (movedCount, current, failed, gone) = (0, 0, new List<SecretKeyProblem>(), new List<string>());
        for (var i = 0; i < names.Count; i++)
        {
            var outcome = await MoveAsync(names[i], active, runId, cancellationToken);
            if (outcome is Outcome.Conflict)
            {
                // The row changed during the step: a value rotated, the secret deleted, or another run. Read it again (§5.2, 5).
                outcome = await MoveAsync(names[i], active, runId, cancellationToken);
            }

            switch (outcome)
            {
                case Outcome.Moved m:
                    movedCount++;
                    moved(new SecretMoved(names[i], m.Version, m.FromKeyId, active.Id, i + 1, names.Count));
                    break;
                case Outcome.Current:
                    current++;
                    break;
                case Outcome.Gone:
                    gone.Add(names[i]);
                    break;
                case Outcome.Failed f:
                    failed.Add(f.Problem);
                    break;
            }
        }

        var left = PerKey(await store.InTransactionAsync(store.ListSecretsAsync, cancellationToken));
        store.ClearTracking();
        var report = new RewrapReport(runId, active.Id, movedCount, current, failed, gone, left);
        await store.InTransactionAsync(_ =>
        {
            store.Audit(new AuditRecord("admin.kek.rewrap_finished", null, null, new Dictionary<string, string?>
            {
                ["principal"] = "operator",
                ["runId"] = runId,
                ["activeKeyId"] = active.Id,
                ["moved"] = movedCount.ToString(CultureInfo.InvariantCulture),
                ["current"] = current.ToString(CultureInfo.InvariantCulture),
                ["failed"] = string.Join(",", failed.Select(problem => problem.Name)),
                ["left"] = string.Join(",", left.Select(pair => $"{pair.Key}:{pair.Value.ToString(CultureInfo.InvariantCulture)}")),
            }), time.GetUtcNow());
            return Task.FromResult(true);
        }, cancellationToken);
        return report;
    }

    /// <summary>One secret, in its own transaction, saved with its row version as the concurrency token (ADR-0008 §1).</summary>
    private async Task<Outcome> MoveAsync(string name, Kek active, string runId, CancellationToken cancellationToken)
    {
        store.ClearTracking();
        try
        {
            return await store.InTransactionAsync<Outcome>(async ct =>
            {
                var secret = await store.FindSecretAsync(name, ct);
                if (secret is null)
                {
                    return new Outcome.Gone();
                }

                var check = SecretEnvelope.Check(ring, secret.Name, secret.Version, secret.Sealed);
                if (check != KeyCheck.Opens)
                {
                    return new Outcome.Failed(new SecretKeyProblem(secret.Name, secret.Version, secret.KeyId, check));
                }

                if (secret.KeyId == active.Id)
                {
                    return new Outcome.Current();
                }

                var from = secret.KeyId;
                secret.Rewrap(SecretEnvelope.Rewrap(ring, active, secret.Name, secret.Version, secret.Sealed));
                store.Audit(new AuditRecord("admin.secret.rewrapped", null, null, new Dictionary<string, string?>
                {
                    ["principal"] = "operator",
                    ["name"] = secret.Name,
                    ["version"] = secret.Version.ToString(CultureInfo.InvariantCulture),
                    ["fromKeyId"] = from,
                    ["toKeyId"] = active.Id,
                    ["runId"] = runId,
                }), time.GetUtcNow());
                return new Outcome.Moved(from, secret.Version);
            }, cancellationToken);
        }
        catch (ConcurrencyConflictException)
        {
            return new Outcome.Conflict();
        }
        finally
        {
            store.ClearTracking();
        }
    }

    private static Dictionary<string, int> PerKey(IEnumerable<Secret> secrets) =>
        secrets.GroupBy(secret => secret.KeyId, StringComparer.Ordinal)
            .OrderBy(group => group.Key, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.Count(), StringComparer.Ordinal);

    private abstract record Outcome
    {
        public sealed record Moved(string FromKeyId, int Version) : Outcome;

        public sealed record Current : Outcome;

        public sealed record Gone : Outcome;

        public sealed record Failed(SecretKeyProblem Problem) : Outcome;

        public sealed record Conflict : Outcome;
    }
}
