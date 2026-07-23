#!/usr/bin/env bash
# Sanity check 7: concurrency. Spends ~2 credits.
# Fires two jobs back-to-back without waiting, then polls both to see
# whether they ran in parallel or were serialized server-side.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh
source ./config.sh

echo "=== Sanity check 7: concurrency ==="
require_higgsfield_cli
confirm_cost "two generations with model '$SANITY_MODEL' fired back-to-back without waiting"

out_a="$STATE_DIR/concurrency-a.json"
out_b="$STATE_DIR/concurrency-b.json"

info "Firing job A..."
higgsfield generate create "$SANITY_MODEL" --prompt "$SANITY_PROMPT (A)" --json | tee "$out_a"
info "Firing job B immediately after, without waiting on A..."
higgsfield generate create "$SANITY_MODEL" --prompt "$SANITY_PROMPT (B)" --json | tee "$out_b"

job_a="$(extract_job_id "$out_a")"
job_b="$(extract_job_id "$out_b")"

if [[ -z "$job_a" || -z "$job_b" ]]; then
  warn "Could not auto-parse one or both job ids — inspect $out_a / $out_b manually."
  exit 0
fi

echo
info "Polling both jobs (note the timestamps/durations printed for each)..."
echo "--- Job A ($job_a) ---"
higgsfield generate wait "$job_a"
echo "--- Job B ($job_b) ---"
higgsfield generate wait "$job_b"

echo
info "Compare the two jobs' timing:"
echo "  - Overlapping progress/completion times -> jobs run in parallel."
echo "  - B's total time looks like it only started after A finished -> serialized."
info "Record which behavior you observed in animation-automation-handoff.md — it determines batch throughput design."
