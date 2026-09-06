#!/usr/bin/env bash
# One-shot installer for the 2d-animation-pipeline on a fresh Mac.
#
# Installs the system dependencies the pipeline shells out to (Node, uv, ffmpeg,
# whisper-cpp), then sets up the workspace (npm install + npm link). Auth steps
# that need a browser or a personal account (Higgsfield OAuth, Claude) can't be
# scripted — the script prints them at the end and points at `npm run check-auth`.
#
# Design: idempotent (safe to re-run), and it accumulates problems instead of
# dying on the first one, so a fresh-machine run surfaces every gap at once
# (mirrors scripts/check-auth.sh). Nothing here spends money or touches the
# network beyond package managers and the model-weight download.
#
# Usage:
#   ./scripts/install.sh              # interactive, installs everything
#   ./scripts/install.sh --yes        # non-interactive (assume yes to prompts)
#   ./scripts/install.sh --skip-brew  # don't touch Homebrew (Linux/Docker/CI)
#   ./scripts/install.sh --skip-models# pass SKIP_MODEL_DOWNLOAD=1 to npm install
set -uo pipefail

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./sanity-checks/lib.sh   # info/pass/fail/warn + REPO_ROOT

# ---- flags ------------------------------------------------------------------
ASSUME_YES=0
SKIP_BREW=0
SKIP_MODELS=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y)      ASSUME_YES=1 ;;
    --skip-brew)   SKIP_BREW=1 ;;
    --skip-models) SKIP_MODELS=1 ;;
    -h|--help)     awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "$SELF"; exit 0 ;;
    *) fail "Unknown argument: $arg (try --help)"; exit 2 ;;
  esac
done

ok=1                            # flipped to 0 by any hard failure
need_manual=()                  # human steps to print at the end

# confirm "prompt" — yes on --yes, else ask. Returns 1 (skip) on anything but y.
confirm() {
  [[ "$ASSUME_YES" == "1" ]] && { info "--yes: $1"; return 0; }
  read -r -p "$1 [Y/n] " reply
  case "${reply:-y}" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

# ---- platform ---------------------------------------------------------------
OS="$(uname -s)"
info "Platform: $OS"
if [[ "$OS" != "Darwin" && "$SKIP_BREW" != "1" ]]; then
  warn "Not macOS — Homebrew steps will be skipped. This path only validates the"
  warn "workspace/npm logic (the Docker tier-1 case). Pass --skip-brew to silence."
  SKIP_BREW=1
fi

# ---- Homebrew + system packages --------------------------------------------
# ensure_brew_pkg <formula> <probe-cmd> <required|optional> <why>
ensure_brew_pkg() {
  local formula="$1" probe="$2" tier="$3" why="$4"
  if command -v "$probe" >/dev/null 2>&1; then
    pass "$probe found: $(command -v "$probe")"
    return 0
  fi
  if [[ "$SKIP_BREW" == "1" ]]; then
    if [[ "$tier" == "required" ]]; then
      fail "$probe missing and --skip-brew set — install '$formula' manually ($why)."
      ok=0
    else
      warn "$probe missing ($why) — optional, skipping under --skip-brew."
    fi
    return 0
  fi
  if confirm "Install $formula via Homebrew? ($why)"; then
    if brew install "$formula"; then
      pass "Installed $formula."
    else
      fail "brew install $formula failed."
      [[ "$tier" == "required" ]] && ok=0
    fi
  else
    if [[ "$tier" == "required" ]]; then
      fail "Declined $formula, but it's required ($why)."
      ok=0
    else
      warn "Declined $formula (optional — $why). Install later with: brew install $formula"
    fi
  fi
}

if [[ "$SKIP_BREW" != "1" ]]; then
  echo; echo "-- Homebrew --"
  if ! command -v brew >/dev/null 2>&1; then
    fail "Homebrew not found."
    info "Homebrew is the cleanest way to get the rest. Install it with the official one-liner:"
    info '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
    info "Then re-run this script. (Not auto-run here: it modifies system paths and"
    info "wants your password — better you run it yourself and see what it does.)"
    ok=0
  else
    pass "Homebrew found: $(command -v brew)"
  fi
fi

echo; echo "-- System dependencies --"
ensure_brew_pkg node        node        required "Node.js runtime for the pipeline + Higgsfield CLI"
ensure_brew_pkg uv          uv          required "runs the Python matte sidecar (numpy/pillow/onnxruntime/scipy) with no venv to manage"
ensure_brew_pkg ffmpeg      ffmpeg      required "video encode/decode for shot render, matte, and speech clips"
ensure_brew_pkg whisper-cpp whisper-cli optional "local speech-to-text for 'pipeline voice transcribe'"

# ---- workspace setup --------------------------------------------------------
echo; echo "-- Workspace (npm) --"
if command -v npm >/dev/null 2>&1; then
  export NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
  [[ "$SKIP_MODELS" == "1" ]] && { export SKIP_MODEL_DOWNLOAD=1; info "SKIP_MODEL_DOWNLOAD=1 — skipping the ~1.3 GB model fetch."; }
  info "Running npm install in $REPO_ROOT (installs deps; postinstall fetches model weights)..."
  if (cd "$REPO_ROOT" && npm install); then
    pass "npm install completed."
  else
    fail "npm install failed — see output above."
    ok=0
  fi

  # npm link puts the `pipeline` bin on PATH. Non-fatal: users can always fall
  # back to `npm run pipeline -- ...` or `node bin/pipeline.js`.
  info "Linking the 'pipeline' command onto your PATH (npm link)..."
  if (cd "$REPO_ROOT" && npm link); then
    if command -v pipeline >/dev/null 2>&1; then
      pass "pipeline linked: $(command -v pipeline)"
    else
      warn "npm link ran but 'pipeline' isn't on PATH yet — open a new shell, or use 'npm run pipeline -- ...'."
    fi
  else
    warn "npm link failed (permissions?). Use 'npm run pipeline -- ...' or retry with sudo."
  fi
else
  fail "npm not found — Node install above must have failed. Fix that, then re-run."
  ok=0
fi

# ---- manual steps the script can't do --------------------------------------
# OAuth and account selection need a human; just tell them clearly.
need_manual+=("Log in to Higgsfield (browser OAuth):   npm run higgsfield -- auth login")
need_manual+=("Select your billing workspace (REQUIRED): npm run higgsfield -- workspace list  then  workspace set <id>")
if [[ -z "${ANTHROPIC_API_KEY:-}" ]] && ! command -v claude >/dev/null 2>&1; then
  need_manual+=("Set up Claude access: install Claude Code, or 'export ANTHROPIC_API_KEY=...' (needed for prompt direction + the critique loop)")
fi

# ---- summary ----------------------------------------------------------------
echo
echo "======================================================================"
if [[ $ok -eq 1 ]]; then
  pass "System + workspace install complete."
else
  fail "Install finished with problems above — fix them, then re-run (safe to re-run)."
fi
echo
info "Next, a few steps only you can do (accounts + browser):"
for step in "${need_manual[@]}"; do echo "    • $step"; done
echo
info "Then verify everything end-to-end (spends no credits):"
echo "    npm run check-auth"
echo "======================================================================"

exit $((1 - ok))
