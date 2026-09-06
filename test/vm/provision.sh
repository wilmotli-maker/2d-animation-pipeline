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
# Build install.sh args as an array so we never pass an empty "" arg (install.sh
# rejects unknown/empty args).
INSTALL_ARGS=(--yes); [[ "$WITH_MODELS" == 1 ]] || INSTALL_ARGS+=(--skip-models)

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
step() { echo; echo "===== $* ====="; }
ok()   { echo "  ok: $*"; }
bad()  { echo "  FAIL: $*" >&2; exit 1; }

# The cirruslabs *-base* image ships Homebrew + Xcode CLT (needed for SSH, which
# the truly-vanilla image lacks). node/uv/ffmpeg are NOT preinstalled, so the
# installer's package step is still exercised for real. To also cover the
# "no Homebrew" UX we run that one assertion with brew stripped from PATH.
BREWLESS_PATH="/usr/bin:/bin:/usr/sbin:/sbin"

step "A. Environment check"
command -v brew >/dev/null 2>&1 && ok "brew present (base image): $(command -v brew)" || echo "  note: brew absent — vanilla-style image"
for t in node npm uv ffmpeg; do
  command -v "$t" >/dev/null 2>&1 && echo "  note: $t already present ($(command -v "$t"))" || ok "$t absent (installer will provide it)"
done

step "B. install.sh with no Homebrew on PATH must fail loudly"
# Simulate a brew-less box by hiding brew; proves the installer detects it and
# prints the actionable bootstrap command instead of failing silently.
out="$(env -i PATH="$BREWLESS_PATH" HOME="$HOME" bash "$REPO/scripts/install.sh" "${INSTALL_ARGS[@]}" 2>&1)"; rc=$?
echo "$out" | sed 's/^/    | /'
[[ $rc -ne 0 ]] || bad "install.sh exited 0 with no Homebrew — it should fail."
echo "$out" | grep -qi "Homebrew not found" || bad "install.sh didn't clearly report missing Homebrew."
echo "$out" | grep -q  "install.sh)\"" || bad "install.sh didn't print the Homebrew bootstrap command."
ok "install.sh failed with a clear, actionable missing-Homebrew message"

step "C. Ensure Homebrew is available for the real install"
if ! command -v brew >/dev/null 2>&1; then
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
    || bad "Homebrew install failed."
fi
eval "$(/opt/homebrew/bin/brew shellenv)"
command -v brew >/dev/null 2>&1 || bad "brew not on PATH."
ok "brew ready: $(command -v brew)"

step "D. install.sh on a brew-equipped box must pass"
bash "$REPO/scripts/install.sh" "${INSTALL_ARGS[@]}" || bad "install.sh returned non-zero."
ok "install.sh completed successfully"

# Make the freshly linked `pipeline` (and brew tools) reachable for the rest.
eval "$(/opt/homebrew/bin/brew shellenv)"
hash -r

step "E. Idempotency — second install.sh run must also pass"
bash "$REPO/scripts/install.sh" "${INSTALL_ARGS[@]}" || bad "re-run of install.sh returned non-zero (not idempotent)."
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
