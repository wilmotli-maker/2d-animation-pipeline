#!/usr/bin/env bash
# Shared config for the sanity-check scripts. Edit these before running anything
# that touches the real API. Everything can also be overridden via env vars,
# e.g.: SANITY_MODEL=some-model ./04-credit-accounting.sh

# Run `../check-auth.sh` then `./03-model-schema.sh` (both free) to see real
# model ids, then fill these in. Left unset on purpose so cost-incurring
# scripts fail loudly instead of silently hitting a made-up model id.
: "${SANITY_MODEL:=REPLACE_ME_WITH_A_CHEAP_IMAGE_MODEL_ID}"
: "${SANITY_VIDEO_MODEL:=REPLACE_ME_WITH_A_VIDEO_MODEL_ID}"

# Keep this cheap and deterministic — it's reused across checks 2, 4, 5, 7.
: "${SANITY_PROMPT:=a single red apple on a plain white background, test generation}"

# Used by check 5 (file I/O round-trip). Drop any small local image here, or
# point this at one elsewhere — see fixtures/README.md.
: "${SANITY_TEST_IMAGE:=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/fixtures/test-image.png}"
