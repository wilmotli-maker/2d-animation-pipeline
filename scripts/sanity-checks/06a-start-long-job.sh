#!/usr/bin/env bash
# Sanity check 6, part A: start a video job WITHOUT --wait. Spends ~1 credit.
# Run 06b-resume-long-job.sh afterwards, ideally from a brand-new terminal
# session — that's the actual thing being tested (server-side resumability).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh
source ./config.sh

echo "=== Sanity check 6a: start a long job without --wait ==="
require_higgsfield_cli
confirm_cost "one video generation with model '$SANITY_VIDEO_MODEL' (returns immediately, no --wait)"

out="$STATE_DIR/resumability-start.json"
higgsfield generate create "$SANITY_VIDEO_MODEL" --prompt "$SANITY_PROMPT" | tee "$out"

job_id="$(extract_job_id "$out")"
if [[ -z "$job_id" ]]; then
  fail "Could not parse a job id from $out."
  info "Copy it manually into: $STATE_DIR/resumability-job-id.txt"
  exit 1
fi

echo "$job_id" > "$STATE_DIR/resumability-job-id.txt"
pass "Job started: $job_id"
echo
info "Now close this terminal completely, open a NEW one, and run:"
echo "    ./06b-resume-long-job.sh"
