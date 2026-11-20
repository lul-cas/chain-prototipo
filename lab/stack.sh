#!/bin/sh
# The evaluation lab's stack: its own compose project, ports and database volume, so a developer's local stack and data are
# never touched. It stays up between runs, unlike the e2e stack, because the lab's data is the point (lab/README.md).
# Usage, from anywhere: lab/stack.sh up | down | destroy | logs [service]
set -eu
cd "$(dirname "$0")/.."

export COMPOSE_PROJECT_NAME=chain-lab
export CHAIN_DB_PORT="${CHAIN_LAB_DB_PORT:-56432}"
export CHAIN_API_PORT="${CHAIN_LAB_API_PORT:-56080}"
export CHAIN_FRONTEND_PORT="${CHAIN_LAB_FRONTEND_PORT:-54300}"
export CHAIN_FRONTEND_ORIGIN="http://localhost:${CHAIN_FRONTEND_PORT}"

SEGREDOS=lab/.segredos
ARQUIVO="$SEGREDOS/stack.env"
ADMIN=lab-admin

aleatorio() { od -An -N16 -tx1 /dev/urandom | tr -d ' \n'; }

# Passwords and keys are made once, on this machine, and never committed.
if [ ! -f "$ARQUIVO" ]; then
  mkdir -p "$SEGREDOS"
  chmod 700 "$SEGREDOS"
  umask 077
  {
    echo "CHAIN_LAB_MOCK_KEY=mock-$(aleatorio)"
    echo "CHAIN_LAB_ADMIN_INITIAL_PASSWORD=lab-$(aleatorio)"
  } > "$ARQUIVO"
fi
# shellcheck disable=SC1090
. "./$ARQUIVO"
export CHAIN_LAB_MOCK_KEY

compose() { docker compose -f docker-compose.yml -f lab/compose.yml "$@"; }

wait_for() {
  i=0
  until curl -sf -o /dev/null "$1"; do
    i=$((i + 1))
    if [ "$i" -ge 120 ]; then
      echo "Timed out waiting for $1" >&2
      exit 1
    fi
    sleep 2
  done
}

case "${1:-}" in
  up)
    compose up -d --build postgres api automation frontend mock
    wait_for "http://localhost:${CHAIN_API_PORT}/health/ready"
    if [ ! -f "$SEGREDOS/admin-criado" ]; then
      printf '%s\n' "$CHAIN_LAB_ADMIN_INITIAL_PASSWORD" | compose run --rm -T api bootstrap-admin --username "$ADMIN"
      touch "$SEGREDOS/admin-criado"
    fi
    echo "Chain: ${CHAIN_FRONTEND_ORIGIN}  API: http://localhost:${CHAIN_API_PORT}"
    ;;
  down)
    compose down
    ;;
  destroy)
    compose down -v --remove-orphans
    rm -f "$SEGREDOS/admin-criado" "$SEGREDOS/admin.env" "$SEGREDOS/cadastro.json" "$SEGREDOS/bots.json"
    ;;
  logs)
    shift
    compose logs --tail=100 "$@"
    ;;
  *)
    echo "Usage: lab/stack.sh up | down | destroy | logs [service]" >&2
    exit 1
    ;;
esac
