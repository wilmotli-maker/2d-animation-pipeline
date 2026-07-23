#!/usr/bin/env bash
# Shared config for the sanity-check scripts. Edit these before running anything
# that touches the real API. Everything can also be overridden via env vars,
# e.g.: SANITY_MODEL=some-model ./04-credit-accounting.sh

# Run `../check-auth.sh` then `./03-model-schema.sh` (both free) to see real
# model ids, then fill these in. Left unset on purpose so cost-incurring
# scripts fail loudly instead of silently hitting a made-up model id.
: "${SANITY_MODEL:=nano_banana}"
: "${SANITY_VIDEO_MODEL:=seedance_2_0}"

# Keep this cheap and deterministic — it's reused across checks 2, 4, 5, 7.
: "${SANITY_PROMPT:=a single red apple on a plain white background, test generation}"

# Used by check 5 (file I/O round-trip). Drop any small local image here, or
# point this at one elsewhere — see fixtures/README.md.
: "${SANITY_TEST_IMAGE:=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/fixtures/test-image.png}"

# The image-input flag check 5 uses to feed SANITY_TEST_IMAGE. This is
# MODEL-DEPENDENT (confirm with `./03-model-schema.sh <model>`):
#   - image models (nano_banana, seedream, flux, ...) take --image / --image-references
#   - video models (seedance*, veo*, kling*) take --start-image / --end-image
# Default matches SANITY_MODEL=nano_banana. Set to --start-image if you point
# check 5 at a video model instead.
: "${SANITY_IMAGE_FLAG:=--image}"
