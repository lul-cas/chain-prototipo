# Chain

Chain is a process-driven ERP platform. Organizations model business processes as executable workflows, assign responsibilities to groups, collect structured data through forms, automate steps, and compose workflows from other workflows. An MCP interface lets AI agents operate the ERP under the same rules as human users.

## Status

The backend covers identity, workflow modeling, forms, the workflow engine (human steps, forms in requests, automatic decisions, sub-workflows, data correction, HTTP triggers) and the MCP tools for AI agents. Automation tasks run end to end. An automation step calls an admin-approved HTTP destination with its secrets, through the Elixir executor, which has SSRF protection, retries and redaction, and its result returns to the request. The Angular frontend covers login, the inbox, starting a request, the request page and the task page; the modeling screens are next.

## Repository layout

| Path | Content |
|---|---|
| `backend/` | .NET 10 solution: `src/Chain.Api` (core API) and `tests/` |
| `automation/` | Elixir application with Oban (automation subsystem) |
| `frontend/` | Angular app |
| `specs/testing/` | Test vectors shared by the backend, frontend and automation test suites |
| `docker-compose.yml` | Local development environment |

## Local development

Requirements: Docker with Compose. For running tests outside containers you also need the .NET 10 SDK and Elixir 1.20 / OTP 29.

```sh
cp .env.example .env        # optional: override ports and credentials
docker compose up --build   # PostgreSQL 17, the .NET API, the Elixir automation app and the Angular dev server
```

| Service | Address (defaults) | Notes |
|---|---|---|
| `postgres` | `localhost:5432` (user / password / db: `chain`) | `CHAIN_DB_PORT` overrides the host port. |
| `api` | `http://localhost:8080` | `GET /health/live`, `GET /health/ready`, `/api/auth/*` (login, logout, me, change-password), `/api/admin/*` (users, groups, bots, automation destinations and secrets; admins only), `/api/automations/*` (automation definitions, for Modelers), `/api/workflows/*` and `/api/forms/*` (modeling), `/api/instances`, `/api/tasks` (requests and inbox), and `POST /mcp`, the MCP server for AI agents. MCP takes the token of a bot that an admin has enabled for it. |
| `frontend` | `http://localhost:4200` | Angular dev server: login (`/entrar`), password change (`/trocar-senha`), the inbox (`/tarefas`), starting a request (`/solicitar`), the requests list and the request page (`/solicitacoes`), and the task page (`/tarefas/{id}`). `CHAIN_FRONTEND_PORT` overrides the host port and must stay in step with `CHAIN_FRONTEND_ORIGIN`. In development, `/_design` shows the design system. `/api` on this origin is proxied to the API. |
| `automation` | — | Applies its migrations (schema `automation`, Oban tables), then runs Oban. It relays dispatched automation steps into jobs, makes the calls, and reports the results to the API's internal listener (`CHAIN_AUTOMATION_RESULT_URL`, with `CHAIN_AUTOMATION_RESULT_TOKEN`). It reads the same `CHAIN_AUTOMATION_KEKS` as the API, to open secrets. |

Create the first admin (once per environment; the password must be changed at first login):

```sh
printf 'choose-a-long-password\n' | docker compose run --rm -T api bootstrap-admin --username admin
```

The API applies database migrations at startup in local development (`Chain__ApplyMigrationsOnStartup`). State-changing API requests must carry an `Origin` header matching `CHAIN_FRONTEND_ORIGIN` (default `http://localhost:4200`).

Tests:

```sh
cd backend && dotnet test                              # integration tests start their own PostgreSQL via Testcontainers (Docker required)
docker compose up -d postgres && cd automation && mix test   # uses the compose PostgreSQL on localhost:5432
cd frontend && npm test                                       # Angular unit tests
cd frontend && npm run e2e                                    # Playwright against an isolated compose stack (frontend/README.md)
```

Every pull request runs `.github/workflows/ci.yml`: the backend tests (`dotnet test`, with Testcontainers), the automation tests (`mix test` with warnings as errors and a format check, on a PostgreSQL service), the frontend lint, unit tests and production build, and the end-to-end tests (`npm run e2e`: Playwright against an isolated docker compose project). The traces of a failed end-to-end test are kept for 7 days. There are no deploy steps and no secrets.

The credentials in `.env.example` are for local development only.

## Planned stack

| Area | Technology |
|---|---|
| Core backend (domain, workflow engine, APIs) | C# / .NET |
| Frontend | Angular |
| Automation and background jobs | Elixir with Oban |
| AI integration | Model Context Protocol (MCP) |
