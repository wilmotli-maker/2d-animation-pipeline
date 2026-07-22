#!/usr/bin/env bash
# Shared helpers for the sanity-check scripts. Source this, don't run it directly:
#   source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
  C_RESET=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''
fi

info() { echo "${C_BLUE}[info]${C_RESET} $*"; }
pass() { echo "${C_GREEN}[pass]${C_RESET} $*"; }
fail() { echo "${C_RED}[fail]${C_RESET} $*"; }
warn() { echo "${C_YELLOW}[warn]${C_RESET} $*"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="$REPO_ROOT/scripts/sanity-checks/state"
mkdir -p "$STATE_DIR"

# CLI is installed locally (via package.json), not globally — prefer the
# workspace's node_modules/.bin over anything on the system PATH.
if [[ -d "$REPO_ROOT/node_modules/.bin" ]]; then
  export PATH="$REPO_ROOT/node_modules/.bin:$PATH"
fi

require_higgsfield_cli() {
  if ! command -v higgsfield >/dev/null 2>&1; then
    fail "higgsfield CLI not found (checked local node_modules/.bin and PATH)."
    cat <<EOF
Install it into this workspace (recommended — keeps it out of global npm):
  (cd "$REPO_ROOT" && npm install)
Then log in:
  npm run higgsfield -- auth login
EOF
    exit 1
  fi
}

# confirm_cost "human description of what's about to run and roughly what it costs"
# Skips the prompt if SANITY_CHECK_YES=1 is set in the environment.
confirm_cost() {
  local desc="$1"
  if [[ "${SANITY_CHECK_YES:-0}" == "1" ]]; then
    info "SANITY_CHECK_YES=1 set — skipping confirmation for: $desc"
    return 0
  fi
  warn "This step calls the real Higgsfield API and will spend credits:"
  echo "    $desc"
  read -r -p "Continue? [y/N] " reply
  case "$reply" in
    [yY][eE][sS]|[yY]) return 0 ;;
    *) info "Skipped."; exit 0 ;;
  esac
}

# extract_job_id <json-file> — best-effort parse of a top-level "id" field.
# The exact response shape isn't confirmed yet (see handoff doc); if this
# fails to find an id, scripts fall back to asking you to read the file.
extract_job_id() {
  grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' "$1" 2>/dev/null | head -1 | sed -E 's/.*"([^"]+)"$/\1/'
}
