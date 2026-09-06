#!/usr/bin/env bash
# Runs INSIDE the clean macOS VM (invoked by run-tier2.sh over ssh). Validates
# scripts/install.sh on a machine that starts with no Homebrew, Node, ffmpeg, or
# uv. Exits 0 only if every phase passes; any failure exits non-zero and the host
# reports TIER-2 FAIL.
#
# Phases:
#   A. clean-state check — confirm the box really is bare.
#   B. missing-brew UX   — install.sh must FAIL clearly (not silently) with no brew.
#   C. bootstrap         — install Homebrew non-interactively (what a human would do).
#   D. real install      — install.sh must PASS now that brew exists.
#   E. idempotency       — a second install.sh run must also PASS.
#   F. smoke             — `pipeline init` scaffolds a project.
set -uo pipefail

WITH_MODELS=0
[[ "${1:-}" == "--with-models" ]] && WITH_MODELS=1
MODEL_FLAG="--skip-models"; [[ "$WITH_MODELS" == 1 ]] && MODEL_FLAG=""

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
step() { echo; echo "===== $* ====="; }
ok()   { echo "  ok: $*"; }
bad()  { echo "  FAIL: $*" >&2; exit 1; }

step "A. Clean-state check"
for t in brew node npm uv ffmpeg; do
  if command -v "$t" >/dev/null 2>&1; then
    echo "  note: $t already present ($(command -v "$t")) — image is not fully vanilla"
  else
    ok "$t absent (expected on a clean box)"
  fi
done

step "B. install.sh with no Homebrew must fail loudly"
if command -v brew >/dev/null 2>&1; then
  echo "  skip: brew already present, cannot test the missing-brew path"
else
  out="$(bash "$REPO/scripts/install.sh" --yes "$MODEL_FLAG" 2>&1)"; rc=$?
  echo "$out" | sed 's/^/    | /'
  [[ $rc -ne 0 ]] || bad "install.sh exited 0 with no Homebrew — it should fail."
  echo "$out" | grep -qi "Homebrew not found" || bad "install.sh didn't clearly report missing Homebrew."
  echo "$out" | grep -q  "install.sh)\"" || bad "install.sh didn't print the Homebrew bootstrap command."
  ok "install.sh failed with a clear, actionable missing-Homebrew message"
fi

step "C. Bootstrap Homebrew (non-interactive)"
if command -v brew >/dev/null 2>&1; then
  ok "brew already present: $(command -v brew)"
else
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
    || bad "Homebrew install failed."
  ok "Homebrew installed"
fi
eval "$(/opt/homebrew/bin/brew shellenv)"
command -v brew >/dev/null 2>&1 || bad "brew still not on PATH after bootstrap."

step "D. install.sh on a brew-equipped clean box must pass"
bash "$REPO/scripts/install.sh" --yes "$MODEL_FLAG" || bad "install.sh returned non-zero after brew bootstrap."
ok "install.sh completed successfully"

# Make the freshly linked `pipeline` (and brew tools) reachable for the rest.
eval "$(/opt/homebrew/bin/brew shellenv)"
hash -r

step "E. Idempotency — second install.sh run must also pass"
bash "$REPO/scripts/install.sh" --yes "$MODEL_FLAG" || bad "re-run of install.sh returned non-zero (not idempotent)."
ok "install.sh is idempotent"

step "F. Smoke test — pipeline init scaffolds a project"
PROJ="$(mktemp -d)/proj"
if command -v pipeline >/dev/null 2>&1; then
  pipeline init "$PROJ" || bad "pipeline init failed."
else
  ( cd "$REPO" && npm run --silent pipeline -- init "$PROJ" ) || bad "pipeline init (via npm) failed."
fi
[[ -f "$PROJ/CLAUDE.md" ]] || bad "pipeline init did not scaffold CLAUDE.md."
ok "pipeline init scaffolded $PROJ (CLAUDE.md present)"

echo; echo "ALL PHASES PASSED"
