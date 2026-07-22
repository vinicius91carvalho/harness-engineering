#!/usr/bin/env bash
# Disable the systemd --user ops-cron timer installed by install-ops-cron.sh /
# harness-control lifecycle. Safe to call when the unit is already inactive.
#
# usage:
#   bash disable-ops-cron.sh [--unit-name harness-ops-cron]
set -euo pipefail

UNIT_NAME="harness-ops-cron"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --unit-name) UNIT_NAME="$2"; shift 2 ;;
    -h|--help)
      echo "usage: disable-ops-cron.sh [--unit-name harness-ops-cron]"
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if ! command -v systemctl >/dev/null 2>&1; then
  echo "disable-ops-cron: systemctl not found; nothing to do"
  exit 0
fi

systemctl --user disable --now "${UNIT_NAME}.timer" 2>/dev/null || true
systemctl --user stop "${UNIT_NAME}.service" 2>/dev/null || true
echo "disabled ${UNIT_NAME}.timer"
