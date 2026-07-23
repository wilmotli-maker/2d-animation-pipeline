#!/usr/bin/env bash
# Sanity check 4: credit accounting. Spends ~1 credit.
# Reads the account credit balance via `higgsfield account status --json`
# before/after a cheap generation, and prints `account transactions` — the
# authoritative record of what was actually charged.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh
source ./config.sh

echo "=== Sanity check 4: credit accounting ==="
require_higgsfield_cli
confirm_cost "one cheap generation with model '$SANITY_MODEL'"

# Extract the numeric "credits" value from `account status --json`.
account_credits() {
  higgsfield account status --json 2>/dev/null \
    | grep -o '"credits"[[:space:]]*:[[:space:]]*[0-9][0-9]*' \
    | grep -o '[0-9][0-9]*' | head -1
}

before=$(account_credits)
if [[ -z "$before" ]]; then
  warn "Could not parse credits from 'higgsfield account status --json'."
  warn "Run 'higgsfield account status' manually and note the balance."
else
  info "Credits before: $before"
fi

info "Running the test generation..."
higgsfield generate create "$SANITY_MODEL" --prompt "$SANITY_PROMPT" --wait
job_exit=$?
if [[ $job_exit -eq 0 ]]; then
  pass "Generation succeeded."
else
  fail "Generation failed (exit $job_exit) — a failed job may or may not have billed."
fi

after=$(account_credits)
[[ -n "$after" ]] && info "Credits after:  $after"

if [[ -n "$before" && -n "$after" ]]; then
  delta=$((before - after))
  if [[ $delta -gt 0 ]]; then
    pass "Balance dropped by $delta credit(s) for one generation."
  elif [[ $delta -eq 0 ]]; then
    warn "Balance unchanged ($before). Either the balance is cached / eventually"
    warn "consistent, or this model is free. The transaction log below is decisive."
  else
    warn "Balance INCREASED by $((-delta)) — unexpected; investigate."
  fi
fi

echo
info "Most recent credit transactions (authoritative record of the charge):"
higgsfield account transactions --size 5 2>&1 || warn "Could not list transactions."

echo
info "Record the observed per-generation credit cost (from the balance delta OR the"
info "transaction log) in animation-automation-handoff.md — it drives per-run cost logging."
