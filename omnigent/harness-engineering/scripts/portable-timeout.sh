#!/usr/bin/env bash
set -euo pipefail
secs=${1:?seconds required}
shift
if command -v timeout >/dev/null 2>&1; then
  exec timeout "$secs" "$@"
fi
if command -v gtimeout >/dev/null 2>&1; then
  exec gtimeout "$secs" "$@"
fi
"$@" &
pid=$!
status=0
( sleep "$secs"; kill "$pid" 2>/dev/null ) &
killer=$!
wait "$pid" 2>/dev/null || status=$?
kill "$killer" 2>/dev/null || true
wait "$killer" 2>/dev/null || true
exit "$status"
