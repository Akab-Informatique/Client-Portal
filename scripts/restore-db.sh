#!/usr/bin/env bash
# Restore AKAB PostgreSQL from a gzipped pg_dump.
# WARNING: replaces data in the target database (does not drop the volume).
#
# Usage:
#   ./scripts/restore-db.sh ./backups/akab-pg-YYYYMMDD-HHMMSS.sql.gz
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DUMP="${1:-}"
if [[ -z "$DUMP" || ! -f "$DUMP" ]]; then
  echo "Usage: $0 path/to/backup.sql.gz" >&2
  exit 1
fi

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source <(grep -E '^(POSTGRES_|DATABASE_URL=)' .env | sed 's/\r$//')
  set +a
fi

DB_USER="${POSTGRES_USER:-akab}"
DB_NAME="${POSTGRES_DB:-akab}"
CONTAINER="$(docker compose ps -q db 2>/dev/null || true)"

if [[ -z "$CONTAINER" ]]; then
  echo "ERROR: Postgres container not found." >&2
  exit 1
fi

echo "Restoring $DUMP into $DB_NAME …"
# Terminate other sessions lightly, then restore
docker exec -i "$CONTAINER" psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 <<SQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid();
SQL

gunzip -c "$DUMP" | docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1

echo "Restore complete. Restart the app if needed:"
echo "  docker compose restart app"
