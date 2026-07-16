#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NODE=$(command -v node)
"$NODE" --test "$ROOT/tests/lib_test.mjs"
"$NODE" --test "$ROOT/tests/cursor_subagent_tab_reaper_test.mjs"
echo 'ok - generator lib unit tests passed'
