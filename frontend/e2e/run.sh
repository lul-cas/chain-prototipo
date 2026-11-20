#!/bin/sh
# End-to-end tests against an isolated docker compose stack (ADR-0010 D6): its own project name, ports and database
# volume, removed afterwards, so a developer's local stack and data are never touched.
# Usage, from frontend/: npm run e2e [-- <playwright arguments>]
set -eu
cd "$(dirname "$0")/../.."

export COMPOSE_PROJECT_NAME=chain-e2e
export CHAIN_DB_PORT="${CHAIN_E2E_DB_PORT:-55432}"
export CHAIN_API_PORT="${CHAIN_E2E_API_PORT:-58080}"
export CHAIN_FRONTEND_PORT="${CHAIN_E2E_FRONTEND_PORT:-54200}"
export CHAIN_FRONTEND_ORIGIN="http://localhost:${CHAIN_FRONTEND_PORT}"
export CHAIN_E2E_BASE_URL="$CHAIN_FRONTEND_ORIGIN"
export CHAIN_E2E_ADMIN_USER=e2e-admin
CHAIN_E2E_ADMIN_INITIAL_PASSWORD="e2e-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
export CHAIN_E2E_ADMIN_INITIAL_PASSWORD
# The key the automation stub accepts; the automation test stores it as a secret (automation.md §10).
CHAIN_E2E_STUB_KEY="stub-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
export CHAIN_E2E_STUB_KEY

# The stack also has the automation service and the stub target of frontend/e2e/compose.yml.
compose() { docker compose -f docker-compose.yml -f frontend/e2e/compose.yml "$@"; }
cleanup() { compose down -v --remove-orphans > /dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

compose up -d --build postgres api automation frontend stub

wait_for() {
  i=0
  until curl -sf -o /dev/null "$1"; do
    i=$((i + 1))
    if [ "$i" -ge 90 ]; then
      echo "Timed out waiting for $1" >&2
      exit 1
    fi
    sleep 2
  done
}
wait_for "http://localhost:${CHAIN_API_PORT}/health/ready"
wait_for "$CHAIN_E2E_BASE_URL/"

printf '%s\n' "$CHAIN_E2E_ADMIN_INITIAL_PASSWORD" | compose run --rm -T api bootstrap-admin --username "$CHAIN_E2E_ADMIN_USER"

cd frontend
npx playwright test --config e2e/playwright.config.ts "$@"
