#!/usr/bin/env bash
# Preflight auth check — sanity check 1 from animation-automation-handoff.md.
# Free: only queries auth/session state, never spends Higgsfield credits.
#
# Usage: ./scripts/check-auth.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./sanity-checks/lib.sh

ok=1

echo "-- Higgsfield --"
if ! command -v higgsfield >/dev/null 2>&1; then
  fail "higgsfield CLI not found (checked local node_modules/.bin and PATH)."
  cat <<EOF
Install it into this workspace (recommended — keeps it out of global npm):
  (cd "$REPO_ROOT" && npm install)
Then log in:
  npm run higgsfield -- auth login
EOF
  ok=0
else
  pass "higgsfield CLI found: $(command -v higgsfield)"
  if higgsfield model list >/dev/null 2>&1; then
    pass "Session looks valid (model list succeeded without prompting to log in)."
  else
    fail "higgsfield is installed but not authenticated (or the session expired)."
    info "Run: npm run higgsfield -- auth login"
    ok=0
  fi
fi

echo
echo "-- Claude --"
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  pass "ANTHROPIC_API_KEY is set (headless/API mode ready)."
elif command -v claude >/dev/null 2>&1; then
  pass "claude CLI found on PATH (interactive mode ready — assumes you're already logged in)."
else
  fail "Neither ANTHROPIC_API_KEY nor the claude CLI was found."
  info "Either 'export ANTHROPIC_API_KEY=...' or install/login Claude Code."
  ok=0
fi

echo
if [[ $ok -eq 1 ]]; then
  pass "All auth checks passed."
else
  fail "Fix the above before running any batch job — cheaper to fail here than mid-batch."
fi
exit $((1 - ok))
