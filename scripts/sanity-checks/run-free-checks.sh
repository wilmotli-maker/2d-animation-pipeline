#!/usr/bin/env bash
# Runs only the sanity checks that don't spend Higgsfield credits:
# auth (1) and model schema listing (3). Safe to run anytime.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

echo ">>> Running free sanity checks (no credits spent) <<<"
echo
../check-auth.sh
auth_exit=$?
echo
./03-model-schema.sh
schema_exit=$?

echo
if [[ $auth_exit -eq 0 && $schema_exit -eq 0 ]]; then
  echo "All free checks passed. Remaining checks (2, 4, 5, 6, 7) spend credits —"
  echo "run them individually once you've set real model ids in config.sh."
else
  echo "Fix the failures above before moving on to credit-spending checks."
fi
