#!/usr/bin/env bash
# Sanity check 3: model schema drift. Free — metadata query only, no generation.
#
# Usage:
#   ./03-model-schema.sh                  # lists all available models
#   ./03-model-schema.sh model-id-1 ...   # dumps live schema per model id
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./lib.sh

echo "=== Sanity check 3: model schema drift ==="
require_higgsfield_cli

if [[ $# -eq 0 ]]; then
  info "No model ids passed — listing all available models instead."
  out="$STATE_DIR/model-list.json"
  higgsfield model list | tee "$out"
  pass "Saved to $out"
  info "Re-run as: $0 <model-id-1> <model-id-2> ... to dump per-model schemas."
  exit 0
fi

for m in "$@"; do
  out="$STATE_DIR/model-schema-$m.json"
  info "Fetching live schema for '$m'..."
  higgsfield model get "$m" | tee "$out"
  pass "Saved to $out — diff this against MODELS.md in the higgsfield-ai/cli repo."
done
