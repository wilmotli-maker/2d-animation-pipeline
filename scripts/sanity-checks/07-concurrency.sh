#!/usr/bin/env bash
# Sanity check 7: concurrency / submission throughput. Spends ~2 credits.
# Fires two jobs async (no --wait) back-to-back, then waits for both, timing
# each phase by WALL CLOCK. The CLI exposes no per-job duration or completion
# timestamp (only `created_at` via `generate get --json`), and `generate wait`
# prints only the result URL — so wall-clock timing here is the only signal.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh
source ./config.sh

echo "=== Sanity check 7: concurrency ==="
require_higgsfield_cli
confirm_cost "two generations with model '$SANITY_MODEL' fired back-to-back without waiting"

out_a="$STATE_DIR/concurrency-a.json"
out_b="$STATE_DIR/concurrency-b.json"

t0=$(date +%s)
info "Firing job A (async)..."
higgsfield generate create "$SANITY_MODEL" --prompt "$SANITY_PROMPT (A)" --json | tee "$out_a"
info "Firing job B immediately after, without waiting on A..."
higgsfield generate create "$SANITY_MODEL" --prompt "$SANITY_PROMPT (B)" --json | tee "$out_b"
t_submitted=$(date +%s)

job_a="$(extract_job_id "$out_a")"
job_b="$(extract_job_id "$out_b")"
if [[ -z "$job_a" || -z "$job_b" ]]; then
  warn "Could not auto-parse one or both job ids — inspect $out_a / $out_b manually."
  exit 0
fi

echo
info "Waiting for both (server-side; both already running)..."
echo "--- Job A ($job_a) ---"; higgsfield generate wait "$job_a" >/dev/null
t_a=$(date +%s)
echo "--- Job B ($job_b) ---"; higgsfield generate wait "$job_b" >/dev/null
t_b=$(date +%s)

echo
info "Wall-clock timing:"
echo "  submit both:       $((t_submitted - t0))s   (small => async submit is non-blocking)"
echo "  until A finished:  $((t_a - t0))s"
echo "  until B finished:  $((t_b - t0))s"

echo
info "Interpretation:"
echo "  - Non-blocking submit (small submit time, two job ids returned) is confirmed"
echo "    regardless of the numbers -> orchestration can fire many jobs, then poll/"
echo "    wait on all of them. This is the decision that matters for batch design."
echo "  - Backend parallel-vs-serial can't be resolved with fast image jobs at this"
echo "    clock resolution. To actually measure it, re-run with a longer job:"
echo "      SANITY_MODEL=seedance_2_0_mini ./07-concurrency.sh"
echo "    If 'until B finished' ~= a single job's time -> parallel; ~= 2x -> serial."
info "Record what you observe in animation-automation-handoff.md."
