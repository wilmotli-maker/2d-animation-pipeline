#!/usr/bin/env bash
# Sanity check 2: non-interactive exit codes. Spends ~1 credit (the valid call;
# the broken call uses a bogus model id and should fail before billing, but
# that itself is part of what this check confirms).
set -uo pipefail   # no -e: we need to inspect $? after failing calls, not abort
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh
source ./config.sh

echo "=== Sanity check 2: non-interactive exit codes ==="
require_higgsfield_cli
confirm_cost "one valid generation with model '$SANITY_MODEL' (cheap prompt)"

info "Running a deliberately broken call (bogus model id)..."
higgsfield generate create not-a-real-model --prompt "$SANITY_PROMPT" --wait
broken_exit=$?
if [[ $broken_exit -ne 0 ]]; then
  pass "Broken call exited non-zero ($broken_exit) as expected."
else
  fail "Broken call exited 0 — the CLI did not signal failure via exit code. Don't trust \$? alone when scripting on top of this."
fi

echo
info "Running a valid call..."
higgsfield generate create "$SANITY_MODEL" --prompt "$SANITY_PROMPT" --wait
good_exit=$?
if [[ $good_exit -eq 0 ]]; then
  pass "Successful call exited 0 as expected."
else
  fail "Successful call exited non-zero ($good_exit) — investigate before relying on exit codes for retry logic."
fi

echo
echo "Summary: broken_exit=$broken_exit good_exit=$good_exit"
info "Record these results in the sanity-checks section of animation-automation-handoff.md."
