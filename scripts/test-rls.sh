#!/usr/bin/env bash
# Boot a disposable Postgres 16, apply the Supabase preamble + every
# migration + RLS policy matrix. Exit 0 on success, non-zero on any
# EXCEPTION raised inside the SQL test script.
#
# Usage:
#   ./scripts/test-rls.sh            # uses Docker (local dev default)
#   PGHOST=... PGUSER=... ./scripts/test-rls.sh   # uses an existing
#                                                 # Postgres (CI service
#                                                 # container path)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATIONS_DIR="$ROOT/supabase/migrations"
TEST_DIR="$ROOT/supabase/tests/rls"

USE_DOCKER=${USE_DOCKER:-}
if [[ -z "${PGHOST:-}" && -z "$USE_DOCKER" ]]; then
  USE_DOCKER=1
fi

cleanup() {
  if [[ -n "${CONTAINER:-}" ]]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ -n "$USE_DOCKER" ]]; then
  command -v docker >/dev/null || { echo "docker not installed"; exit 1; }
  CONTAINER="calab-rls-test-$$"
  PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()')
  echo "[rls] starting postgres:16 on 127.0.0.1:$PORT …"
  docker run -d --rm --name "$CONTAINER" \
    -e POSTGRES_PASSWORD=test -e POSTGRES_USER=test -e POSTGRES_DB=test \
    -p "$PORT:5432" postgres:16 >/dev/null

  export PGHOST=127.0.0.1 PGPORT="$PORT" PGUSER=test PGPASSWORD=test PGDATABASE=test

  # Wait until postgres is accepting connections
  for _ in $(seq 1 30); do
    if docker exec "$CONTAINER" pg_isready -U test -d test >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

if command -v psql >/dev/null 2>&1; then
  PSQL_CMD=(psql)
elif [[ -n "${CONTAINER:-}" ]]; then
  # Fall back to running psql inside the service container when the host has
  # no client binary. Piping stdin keeps the invocation identical.
  PSQL_CMD=(docker exec -i -e PGPASSWORD=test "$CONTAINER" psql -U test -d test)
else
  echo "error: psql not available on host and no container fallback" >&2
  exit 1
fi

run_psql() {
  local file="$1"
  if [[ "${PSQL_CMD[0]}" == "docker" ]]; then
    "${PSQL_CMD[@]}" --no-psqlrc -v ON_ERROR_STOP=1 < "$file"
  else
    "${PSQL_CMD[@]}" --no-psqlrc -v ON_ERROR_STOP=1 -f "$file"
  fi
}

echo "[rls] applying preamble and migrations …"
run_psql "$TEST_DIR/preamble.sql"
for mig in "$MIGRATIONS_DIR"/*.sql; do
  echo "[rls]   $(basename "$mig")"
  run_psql "$mig"
done

echo "[rls] running RLS policy matrix …"
run_psql "$TEST_DIR/test.sql"

echo "[rls] ALL RLS ASSERTIONS PASSED"
