#!/usr/bin/env bash
set -euo pipefail
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
bash "$DIR/supervisor_fast_test.sh"
bash "$DIR/supervisor_e2e_test.sh"
