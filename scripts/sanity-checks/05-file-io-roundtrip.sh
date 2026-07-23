#!/usr/bin/env bash
# Sanity check 5: file I/O round-trip. Spends ~1 credit.
# Confirms a local image path (passed via SANITY_IMAGE_FLAG — --image for image
# models, --start-image for video models) is auto-uploaded (not mistaken for a
# job UUID) and that the output is retrievable via `generate get` afterwards.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh
source ./config.sh

echo "=== Sanity check 5: file I/O round-trip ==="
require_higgsfield_cli

if [[ ! -f "$SANITY_TEST_IMAGE" ]]; then
  fail "Test image not found at $SANITY_TEST_IMAGE"
  info "Drop a small image at scripts/sanity-checks/fixtures/test-image.png, or set SANITY_TEST_IMAGE."
  exit 1
fi

confirm_cost "one generation using $SANITY_IMAGE_FLAG=$SANITY_TEST_IMAGE with model '$SANITY_MODEL'"

out="$STATE_DIR/file-io-job.json"
info "Submitting generation with a local image via $SANITY_IMAGE_FLAG (should auto-upload)..."
higgsfield generate create "$SANITY_MODEL" --prompt "$SANITY_PROMPT" "$SANITY_IMAGE_FLAG" "$SANITY_TEST_IMAGE" --wait | tee "$out"

job_id="$(extract_job_id "$out")"
if [[ -z "$job_id" ]]; then
  warn "Could not auto-parse a job id from the output — inspect $out manually and run 'higgsfield generate get <id>' yourself."
  exit 0
fi

info "Parsed job id: $job_id"
info "Confirming output is retrievable via 'generate get' after the fact..."
higgsfield generate get "$job_id"
pass "If the above printed the job result (not a 'not found'/bad-UUID error), the round-trip works."
