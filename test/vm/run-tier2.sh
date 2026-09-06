#!/usr/bin/env bash
# Tier-2 install test: run scripts/install.sh on a clean macOS VM.
#
# This is the automated, repeatable version of the "clean macOS VM" checklist in
# docs/install-test-harness.md. It works from any clone of the repo — clone the
# project anywhere and run `./test/vm/run-tier2.sh` to spin up a throwaway
# vanilla-macOS VM (via Tart), push this working tree into it, and validate the
# installer end-to-end on a machine that starts with no Homebrew, no Node, no
# ffmpeg/uv, and no cached auth.
#
# What it does NOT test: the account/browser auth steps (Higgsfield OAuth,
# workspace select, Claude). Those need a human and personal credentials, so the
# VM run stops at "install + tooling work on a clean box"; do the auth steps by
# hand per docs/install-test-harness.md once the machine is provisioned.
#
# Requirements (host): Apple Silicon Mac, Homebrew. The script installs Tart and
# sshpass via brew if they're missing (with a prompt unless --yes).
#
# Usage:
#   ./test/vm/run-tier2.sh                 # full clean run, then delete the VM
#   ./test/vm/run-tier2.sh --yes           # non-interactive (assume yes to prompts)
#   ./test/vm/run-tier2.sh --keep          # leave the VM running for inspection
#   ./test/vm/run-tier2.sh --reuse         # reuse an existing VM (skip clone/boot)
#   ./test/vm/run-tier2.sh --with-models   # include the ~1.3 GB model fetch (slow)
#   ./test/vm/run-tier2.sh --image <ref>   # override the base image
#   ./test/vm/run-tier2.sh --name <vm>     # override the VM name
set -uo pipefail

# ---- config / flags ---------------------------------------------------------
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"

IMAGE="ghcr.io/cirruslabs/macos-sequoia-base:latest"  # base = admin/admin + SSH + CLT (vanilla has no SSH, can't script)
VMNAME="anim-tier2"
VM_USER="admin"; VM_PASS="admin"   # cirruslabs image default creds (passwordless sudo inside)
ASSUME_YES=0; KEEP=0; REUSE=0; WITH_MODELS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y)      ASSUME_YES=1 ;;
    --keep)        KEEP=1 ;;
    --reuse)       REUSE=1 ;;
    --with-models) WITH_MODELS=1 ;;
    --image)       IMAGE="${2:?--image needs a value}"; shift ;;
    --name)        VMNAME="${2:?--name needs a value}"; shift ;;
    -h|--help)     awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

RED=$'\e[31m'; GRN=$'\e[32m'; YEL=$'\e[33m'; DIM=$'\e[2m'; RST=$'\e[0m'
info() { echo "${DIM}--${RST} $*"; }
pass() { echo "${GRN}PASS${RST} $*"; }
warn() { echo "${YEL}WARN${RST} $*"; }
die()  { echo "${RED}FAIL${RST} $*" >&2; exit 1; }
confirm() { [[ "$ASSUME_YES" == 1 ]] && return 0; read -r -p "$1 [y/N] " r; [[ "$r" == [yY]* ]]; }

# ---- host preflight ---------------------------------------------------------
[[ "$(uname -s)" == Darwin ]] || die "host must be macOS (Tart needs Apple Virtualization.framework)."
[[ "$(uname -m)" == arm64 ]]  || die "host must be Apple Silicon (arm64); Tart runs arm64 macOS guests only."
command -v brew >/dev/null || die "Homebrew required on the host to install Tart/sshpass."

ensure_tool() { # <cmd> <brew-install-arg> <label> [<tap-to-trust>]
  command -v "$1" >/dev/null && { info "$3 present: $(command -v "$1")"; return 0; }
  local tap="${4:-}"
  confirm "Install $3 via 'brew install $2'${tap:+ (trusts tap $tap)}?" || die "$3 is required — install it and re-run."
  # Homebrew >=6 refuses to load formulae from untrusted third-party taps until
  # the tap is trusted. tart and sshpass both live in third-party taps.
  if [[ -n "$tap" ]]; then
    brew tap "$tap" 2>/dev/null || true
    brew trust --tap "$tap" 2>/dev/null || warn "brew trust --tap $tap unavailable/failed (older brew won't need it) — continuing."
  fi
  brew install $2 || die "brew install $2 failed."
}
ensure_tool tart    cirruslabs/cli/tart          "Tart"    cirruslabs/cli
ensure_tool sshpass hudochenkov/sshpass/sshpass  "sshpass" hudochenkov/sshpass

SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=10)
vm_ssh()  { sshpass -p "$VM_PASS" ssh  "${SSH_OPTS[@]}" "$VM_USER@$VM_IP" "$@"; }
vm_rsync() { sshpass -p "$VM_PASS" rsync -e "ssh ${SSH_OPTS[*]}" "$@"; }

RUN_PID=""
cleanup() {
  if [[ "$KEEP" == 1 ]]; then
    # Leave the VM running so the auth steps can be done over SSH. Do NOT kill
    # RUN_PID — that is the `tart run` process; killing it stops the VM.
    warn "--keep set: leaving VM '$VMNAME' running at ${VM_IP:-<booting>} (user/pass: $VM_USER/$VM_PASS)."
    warn "  SSH in:  sshpass -p $VM_PASS ssh $VM_USER@${VM_IP:-<ip>}    Stop later: tart stop $VMNAME && tart delete $VMNAME"
    disown "$RUN_PID" 2>/dev/null || true
  else
    [[ -n "$RUN_PID" ]] && kill "$RUN_PID" 2>/dev/null
    info "Tearing down VM '$VMNAME'..."; tart stop "$VMNAME" 2>/dev/null; tart delete "$VMNAME" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ---- provision the VM -------------------------------------------------------
if [[ "$REUSE" != 1 ]]; then
  tart list --format json 2>/dev/null | grep -q "\"$VMNAME\"" && { info "Deleting existing VM '$VMNAME'..."; tart delete "$VMNAME"; }
  info "Cloning base image (first pull downloads ~25-40 GB): $IMAGE"
  tart clone "$IMAGE" "$VMNAME" || die "tart clone failed."
fi

info "Booting VM '$VMNAME' (headless)..."
tart run --no-graphics "$VMNAME" >/dev/null 2>&1 &
RUN_PID=$!

info "Waiting for VM IP..."
VM_IP=""
for _ in $(seq 1 60); do
  VM_IP="$(tart ip "$VMNAME" 2>/dev/null)" && [[ -n "$VM_IP" ]] && break
  sleep 5
done
[[ -n "$VM_IP" ]] || die "VM never reported an IP (boot failed?)."
info "VM IP: $VM_IP"

info "Waiting for SSH..."
for _ in $(seq 1 60); do vm_ssh true 2>/dev/null && break; sleep 5; done
if ! vm_ssh true 2>/dev/null; then
  warn "The VM booted and got IP $VM_IP, but host->guest traffic never worked."
  if ! ping -c1 -t2 "$VM_IP" >/dev/null 2>&1; then
    warn "The guest doesn't even answer ping ('No route to host'). On macOS 15+/26 this is"
    warn "almost always the LOCAL NETWORK privacy block: grant the app that runs this script"
    warn "(Terminal / Claude / iTerm) access under System Settings > Privacy & Security >"
    warn "Local Network, then re-run. Alternatively try 'tart run --net-softnet' (needs sudo)."
  fi
  die "SSH never came up (see hint above; VM left running for inspection: tart ip $VMNAME)."
fi
pass "SSH is up ($VM_USER@$VM_IP)."

# ---- push the working tree + provision script -------------------------------
DEST="/Users/$VM_USER/anim-pipeline"
info "Syncing working tree into VM at $DEST (excluding node_modules/models/.git)..."
vm_ssh "mkdir -p $DEST" || die "could not create $DEST in VM."
vm_rsync -a --delete \
  --exclude='.git/' --exclude='node_modules/' --exclude='models/' \
  --exclude='web/' --exclude='elements/' --exclude='shots/' \
  "$REPO_ROOT/" "$VM_USER@$VM_IP:$DEST/" || die "rsync into VM failed."

PROV_FLAGS=""; [[ "$WITH_MODELS" == 1 ]] && PROV_FLAGS="--with-models"
info "Running in-VM provision + install test..."
set +e
vm_ssh "bash $DEST/test/vm/provision.sh $PROV_FLAGS"
RESULT=$?
set -e

echo
if [[ $RESULT -eq 0 ]]; then
  pass "TIER-2 PASS — clean-VM install validated."
else
  die "TIER-2 FAIL — see the in-VM output above (exit $RESULT)."
fi
