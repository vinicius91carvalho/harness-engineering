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
exec perl -e 'alarm shift @ARGV; exec @ARGV or die $!' "$secs" "$@"
