# Evaluation lab tooling

The tooling of the lab described in [specs/experiments/laboratorio/](../specs/experiments/laboratorio/README.md). It has no dependencies beyond Node 24 and Docker.

| Path | What it is | Spec |
|---|---|---|
| `mock/` | The mock of the external systems | [mock.md](../specs/experiments/laboratorio/mock.md) |
| `stack.sh`, `compose.yml` | The lab's own compose stack | Below |
| `cadastro/` | Registers the first wave in Chain, and verifies it | [cadastro.md](../specs/experiments/laboratorio/cadastro.md) |

## The stack

```sh
lab/stack.sh up        # builds and starts it, and creates the admin the first time
lab/stack.sh logs mock # a service's logs
lab/stack.sh down      # stops it and keeps the data
lab/stack.sh destroy   # stops it and deletes the lab's data
```

It is a compose project of its own, `chain-lab`, so a developer's stack and data are never touched. Unlike the e2e stack, it stays up between runs, because the lab's data is the point.

| Service | Address |
|---|---|
| Chain | http://localhost:54300 |
| API | http://localhost:56080 |
| PostgreSQL | localhost:56432 |
| Mock | `http://mock:8080`, on the compose network only |

Generated passwords and keys stay in `lab/.segredos/`, which git ignores.

## Registering the processes

```sh
node lab/cadastro/cadastrar.mjs   # from the specs into Chain; it can run again
node lab/cadastro/verificar.mjs   # runs real paths through the personas, and fails on anything not covered
```

Verifying leaves instances behind, and they must not count as lab results. Recreate the stack afterwards, as [cadastro.md](../specs/experiments/laboratorio/cadastro.md) §4 says.

The admin is `lab-admin`, with the password in `lab/.segredos/admin.env`. The persona bots' tokens are in `lab/.segredos/bots.json`.

## Tests

```sh
cd lab && npm test
```

CI doesn't run these tests: pipeline changes stay with the owner (ADR-0010 Q9).
