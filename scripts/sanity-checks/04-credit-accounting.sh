#!/usr/bin/env bash
# Sanity check 4: credit accounting. Spends ~1 credit.
#
# No confirmed CLI command for balance lookup exists yet (not covered in the
# handoff research) — this script tries a guessed command and otherwise falls
# back to asking you to check the web dashboard manually before/after.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh
source ./config.sh

echo "=== Sanity check 4: credit accounting ==="
require_higgsfield_cli
confirm_cost "one cheap generation with model '$SANITY_MODEL'"

echo
info "Attempting 'higgsfield account balance' (unconfirmed command — ignore if it errors)..."
if higgsfield account balance 2>/dev/null; then
  before_via_cli=1
else
  warn "No such command (or a different name/shape). Check 'higgsfield --help' and update this script if you find the real one."
  before_via_cli=0
fi

if [[ $before_via_cli -eq 0 ]]; then
  read -r -p "Note your Ultra credit balance from the dashboard now, then press Enter to continue... " _
fi

info "Running the test generation..."
higgsfield generate create "$SANITY_MODEL" --prompt "$SANITY_PROMPT" --wait
job_exit=$?
if [[ $job_exit -eq 0 ]]; then
  pass "Generation succeeded."
else
  fail "Generation failed (exit $job_exit) — check the balance anyway, a failed job may or may not have billed."
fi

echo
if [[ $before_via_cli -eq 1 ]]; then
  higgsfield account balance 2>/dev/null || true
  info "Compare the balance above against the 'before' value printed earlier."
else
  read -r -p "Check the dashboard balance again. Did it drop by the expected per-generation amount? [y/N] " reply
  case "$reply" in
    [yY]*) pass "Credit accounting matches expectations." ;;
    *) warn "Record the actual before/after numbers in animation-automation-handoff.md." ;;
  esac
fi
