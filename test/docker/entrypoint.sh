#!/usr/bin/env bash
# Tier-1 install-test driver. Runs inside the container built from Dockerfile.
#
# The repo is mounted read-only at /src so the container never writes to the
# host. We copy it to a writable /work (minus node_modules) and run the real
# installer there — twice, to prove idempotency — then a no-network smoke test.
set -uo pipefail

SRC=/src
WORK="$HOME/work"

if [[ ! -f "$SRC/scripts/install.sh" ]]; then
  echo "FATAL: mount the repo read-only at /src (docker run -v \"\$PWD\":/src:ro ...)" >&2
  exit 2
fi

echo "== Staging a clean copy of the repo (excluding node_modules/models) =="
mkdir -p "$WORK"
# -a preserves perms; exclude heavy/host-specific dirs so we install from scratch.
cp -a "$SRC/." "$WORK/"
rm -rf "$WORK/node_modules" "$WORK/models"
cd "$WORK"

# Skip the ~1.3 GB model fetch and the Homebrew steps — this tier is npm logic.
INSTALL="./scripts/install.sh --skip-brew --skip-models --yes"

echo; echo "== Run 1: fresh install =="
$INSTALL
rc1=$?
echo "run 1 exit: $rc1"

echo; echo "== Run 2: re-run (must be idempotent) =="
$INSTALL
rc2=$?
echo "run 2 exit: $rc2"

echo; echo "== Smoke test: pipeline scaffolds a project (no network, no credits) =="
# `pipeline init` is a real end-to-end command that writes files and exits 0.
# (There is no `--help` subcommand — bare/invalid args print usage and exit 1.)
smoke=1
smoke_dir="$HOME/smoke-init"
rm -rf "$smoke_dir"
if node bin/pipeline.js init "$smoke_dir" >/dev/null 2>&1 && [[ -f "$smoke_dir/CLAUDE.md" ]]; then
  echo "pipeline init: OK"
else
  echo "pipeline init: FAILED"; smoke=0
fi
rm -rf "$smoke_dir"

echo; echo "== Unit suite (node --test; no network, no credits) =="
if npm test >/dev/null 2>&1; then
  echo "npm test: OK"
else
  echo "npm test: FAILED (inspect with: npm test)"; smoke=0
fi

echo
echo "======================================================================"
if [[ $rc1 -eq 0 && $rc2 -eq 0 && $smoke -eq 1 ]]; then
  echo "TIER-1 PASS — install logic sound on clean Linux. Proceed to tier-2 (fresh Mac user)."
  exit 0
else
  echo "TIER-1 FAIL — install=$rc1/$rc2 smoke/tests=$smoke. Fix before tier-2."
  exit 1
fi
