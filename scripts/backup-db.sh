#!/usr/bin/env bash
# Backup AKAB production PostgreSQL (Docker Compose).
# Usage:
#   ./scripts/backup-db.sh
#   ./scripts/backup-db.sh /var/backups/akab
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Dumps contain password hashes and MFA secrets — owner-only files.
umask 077
OUT_DIR="${1:-./backups}"
mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR" 2>/dev/null || true
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$OUT_DIR/akab-pg-$STAMP.sql.gz"

# Load .env for POSTGRES_* if present (without expanding $ in values awkwardly)
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source <(grep -E '^(POSTGRES_|DATABASE_URL=)' .env | sed 's/\r$//')
  set +a
fi

DB_USER="${POSTGRES_USER:-akab}"
DB_NAME="${POSTGRES_DB:-akab}"
CONTAINER="${AKAB_DB_CONTAINER:-}"

if [[ -z "$CONTAINER" ]]; then
  CONTAINER="$(docker compose ps -q db 2>/dev/null || true)"
fi

if [[ -z "$CONTAINER" ]]; then
  echo "ERROR: Postgres container not found. Is 'docker compose up -d' running?" >&2
  exit 1
fi

echo "Backing up database '$DB_NAME' from container $CONTAINER …"
# No -t: a TTY rewrites newlines and can corrupt the dump stream.
docker exec -i "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" --no-owner --no-acl \
  | gzip > "$FILE"
chmod 600 "$FILE"

echo "OK → $FILE"
ls -lh "$FILE"
