#!/usr/bin/env bash
# Check Autotask lines in .env WITHOUT printing secret values.
# Usage: bash scripts/check-autotask-env.sh
#        bash scripts/check-autotask-env.sh /opt/akab-portal/.env
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${1:-$ROOT/.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found"
  exit 1
fi

echo "==> Checking $ENV_FILE (values are never printed)"
echo
echo "Note: AUTOTASK_USERNAME may end with @soluti.dev — that is valid Username (Key) format."
echo

get_raw() {
  local key="$1"
  grep -E "^[[:space:]]*${key}=" "$ENV_FILE" | tail -1 | sed "s/^[^=]*=//" || true
}

strip_quotes() {
  local v="$1"
  v="${v//$'\r'/}"
  # trim
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  if [[ ${#v} -ge 2 && "${v:0:1}" == "'" && "${v: -1}" == "'" ]]; then
    v="${v:1:${#v}-2}"
  elif [[ ${#v} -ge 2 && "${v:0:1}" == '"' && "${v: -1}" == '"' ]]; then
    v="${v:1:${#v}-2}"
  fi
  printf '%s' "$v"
}

quote_style() {
  local raw="$1"
  raw="${raw//$'\r'/}"
  raw="${raw#"${raw%%[![:space:]]*}"}"
  raw="${raw%"${raw##*[![:space:]]}"}"
  if [[ ${#raw} -ge 2 && "${raw:0:1}" == "'" && "${raw: -1}" == "'" ]]; then
    echo single
  elif [[ ${#raw} -ge 2 && "${raw:0:1}" == '"' && "${raw: -1}" == '"' ]]; then
    echo double
  else
    echo none
  fi
}

check_key() {
  local key="$1"
  local raw
  raw="$(get_raw "$key")"
  if [[ -z "$raw" ]]; then
    echo "  $key: MISSING"
    return 1
  fi
  local q
  q="$(quote_style "$raw")"
  local val
  val="$(strip_quotes "$raw")"
  local len=${#val}
  local flags=()
  # @ in username is NORMAL for Autotask Username (Key) — only annotate, never fail
  if [[ "$key" == "AUTOTASK_USERNAME" && "$val" == *"@"* ]]; then
    flags+=("has_at_domain_OK")
  fi
  [[ "$val" == *'$'* ]] && flags+=("has_dollar")
  [[ "$val" == *'#'* ]] && flags+=("has_hash")
  [[ "$len" -lt 8 ]] && flags+=("SHORT")
  # Compose expansion markers are real problems
  if [[ "$val" == *'${'* ]] || [[ "$val" =~ \$[A-Za-z_][A-Za-z0-9_]* ]]; then
    flags+=("LOOKS_COMPOSE_EXPANDED")
  fi
  local flagstr=""
  if ((${#flags[@]})); then
    flagstr=" [${flags[*]}]"
  fi
  echo "  $key: present  length=$len  quoted=$q$flagstr"
  if [[ "$len" -lt 8 ]]; then
    return 1
  fi
  if [[ " ${flags[*]} " == *" LOOKS_COMPOSE_EXPANDED "* ]]; then
    return 1
  fi
  return 0
}

ok=0
check_key AUTOTASK_INTEGRATION_CODE || ok=1
check_key AUTOTASK_USERNAME || ok=1
check_key AUTOTASK_SECRET || ok=1

echo
raw_sec="$(get_raw AUTOTASK_SECRET)"
if [[ -n "$raw_sec" ]]; then
  q="$(quote_style "$raw_sec")"
  val="$(strip_quotes "$raw_sec")"
  if [[ "$q" == "none" ]]; then
    if [[ "$val" == *'$'* || "$val" == *'#'* ]]; then
      echo "WARNING: AUTOTASK_SECRET is unquoted and contains \$ or #."
      echo "  Docker Compose / .env parsers will corrupt it → Autotask 401."
      echo "  Fix: AUTOTASK_SECRET='...full secret...'"
      ok=1
    fi
  elif [[ "$q" == "double" ]]; then
    if [[ "$val" == *'$'* ]]; then
      echo "WARNING: AUTOTASK_SECRET uses double quotes and contains \$."
      echo "  Prefer single quotes so \$ is not expanded: AUTOTASK_SECRET='...'"
      ok=1
    fi
  fi
fi

echo
if [[ "$ok" -eq 0 ]]; then
  echo "Env shape looks OK (including @ in username if present)."
  echo "If Autotask still 401s:"
  echo "  • Re-copy all 3 values from Autotask Credentials (or regenerate Secret)"
  echo "  • Confirm API User (API-only) + API Tracking Identifier match this user"
  echo "  • docker compose up -d --force-recreate app"
  echo "  • curl -sS 'http://127.0.0.1:3000/api/autotask/status?refresh=1'"
  echo "  • Compare secretLength in JSON to the real secret length in Autotask"
else
  echo "Fix the items above, then recreate the app container."
fi
exit "$ok"
