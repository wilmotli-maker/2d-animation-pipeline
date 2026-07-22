#!/usr/bin/env bash
# Sanity check 6, part B: resume polling a job from a fresh shell. Free —
# only polls an already-started job, doesn't create a new one.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh

echo "=== Sanity check 6b: resume from a fresh shell ==="
require_higgsfield_cli

job_file="$STATE_DIR/resumability-job-id.txt"
if [[ ! -f "$job_file" ]]; then
  fail "No saved job id found — run ./06a-start-long-job.sh first."
  exit 1
fi

job_id="$(cat "$job_file")"
info "Resuming wait on job $job_id from this shell..."
higgsfield generate wait "$job_id"
wait_exit=$?
if [[ $wait_exit -eq 0 ]]; then
  pass "Job resumed and completed successfully — confirms jobs are server-side/resumable."
else
  fail "generate wait failed (exit $wait_exit) — don't rely on unattended resumability until this is understood."
fi
