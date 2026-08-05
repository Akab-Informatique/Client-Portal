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
  [[ "$val" == *"@"* ]] && flags+=("LOOKS_LIKE_EMAIL")
  [[ "$val" == *'$'* ]] && flags+=("has_dollar")
  [[ "$val" == *'#'* ]] && flags+=("has_hash")
  [[ "$len" -lt 12 ]] && flags+=("SHORT")
  local flagstr=""
  if ((${#flags[@]})); then
    flagstr=" [${flags[*]}]"
  fi
  echo "  $key: present  length=$len  quoted=$q$flagstr"
  return 0
}

ok=0
check_key AUTOTASK_INTEGRATION_CODE || ok=1
check_key AUTOTASK_USERNAME || ok=1
check_key AUTOTASK_SECRET || ok=1

echo
raw_user="$(get_raw AUTOTASK_USERNAME)"
user="$(strip_quotes "$raw_user")"
if [[ -n "$user" && "$user" == *"@"* ]]; then
  echo "PRIMARY PROBLEM:"
  echo "  AUTOTASK_USERNAME is an email address."
  echo "  Autotask API requires the generated Username (Key) from the Credentials tab,"
  echo "  not the resource login email. This alone causes 401 Unauthorized."
  echo
  echo "Fix:"
  echo "  1. Autotask → Admin → Resources (Users) → your API User → Credentials"
  echo "  2. Copy Username (Key), API Tracking Identifier, and Secret"
  echo "  3. Edit $ENV_FILE:"
  echo "       AUTOTASK_INTEGRATION_CODE=...tracking-id..."
  echo "       AUTOTASK_USERNAME=...username-key-not-email..."
  echo "       AUTOTASK_SECRET='...full-secret...'"
  echo "  4. cd /opt/akab-portal && docker compose up -d --force-recreate app"
  echo "  5. curl -sS 'http://127.0.0.1:3000/api/autotask/status?refresh=1'"
  ok=1
fi

raw_sec="$(get_raw AUTOTASK_SECRET)"
if [[ -n "$raw_sec" ]]; then
  q="$(quote_style "$raw_sec")"
  if [[ "$q" == "none" ]]; then
    val="$(strip_quotes "$raw_sec")"
    if [[ "$val" == *'$'* || "$val" == *'#'* ]]; then
      echo "WARNING: AUTOTASK_SECRET is unquoted and contains \$ or #."
      echo "  Wrap it in single quotes: AUTOTASK_SECRET='...'"
      ok=1
    fi
  fi
fi

echo
if [[ "$ok" -eq 0 ]]; then
  echo "Env shape looks OK. If Autotask still 401s, re-copy Username (Key) + Secret from Autotask Credentials"
  echo "and recreate: docker compose up -d --force-recreate app"
else
  echo "Fix the items above, then recreate the app container."
fi
exit "$ok"
