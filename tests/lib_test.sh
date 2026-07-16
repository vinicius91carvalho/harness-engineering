#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NODE=$(command -v node)
"$NODE" --test "$ROOT/tests/lib_test.mjs"

# Regression: macOS TMPDIR is /var/folders/... while git rev-parse --show-toplevel
# resolves to /private/var/...; detectProjectBoundaries must return a canonical gitRoot.
var_sim=${TMPDIR:-/tmp}/lib-test-var-sim.$$
mkdir -p "$var_sim/private/var"
ln -sfn "$var_sim/private/var" "$var_sim/var"
TMPDIR=$var_sim/var "$NODE" --test "$ROOT/tests/lib_test.mjs"

echo 'ok - generator lib unit tests passed'
