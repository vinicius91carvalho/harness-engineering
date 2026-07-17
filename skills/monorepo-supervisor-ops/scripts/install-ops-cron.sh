#!/usr/bin/env bash
# Install a systemd --user timer that runs ops-remediate.mjs every N minutes
# (remediate + check + event-driven Control Host wake bridge).
#
# usage:
#   bash install-ops-cron.sh --repo /path/to/project [--project root] [--minutes 5] [--notify] [--invoke-agent]
set -euo pipefail

REPO=""
PROJECT=""
MINUTES=5
NOTIFY=0
INVOKE_AGENT=0
UNIT_NAME="harness-ops-cron"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --project|--projects) PROJECT="$2"; shift 2 ;;
    --minutes) MINUTES="$2"; shift 2 ;;
    --notify) NOTIFY=1; shift ;;
    --invoke-agent) INVOKE_AGENT=1; shift ;;
    --unit-name) UNIT_NAME="$2"; shift 2 ;;
    -h|--help)
      echo "usage: install-ops-cron.sh --repo <path> [--project root] [--minutes 5] [--notify] [--invoke-agent]"
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$REPO" ]]; then
  echo "install-ops-cron.sh: --repo is required" >&2
  exit 2
fi
REPO="$(cd "$REPO" && pwd)"
MINUTES="$(printf '%s' "$MINUTES" | tr -cd '0-9')"
if [[ -z "$MINUTES" || "$MINUTES" -lt 1 ]]; then
  echo "install-ops-cron.sh: --minutes must be >= 1" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$SCRIPT_DIR/ops-remediate.mjs"
if [[ ! -f "$CHECK" ]]; then
  # Backward-compatible fallback to check-only.
  CHECK="$SCRIPT_DIR/ops-cron-check.mjs"
fi
if [[ ! -f "$CHECK" ]]; then
  echo "missing ops-remediate.mjs / ops-cron-check.mjs" >&2
  exit 2
fi

CONTROL_CANDIDATES=(
  "${HARNESS_CONTROL:-}"
  "$HOME/.agents/skills/supervisor/scripts/harness-control.mjs"
  "$HOME/.agents/skills/harness-supervisor/scripts/harness-control.mjs"
  "$SCRIPT_DIR/../../supervisor/scripts/harness-control.mjs"
)
CONTROL=""
for c in "${CONTROL_CANDIDATES[@]}"; do
  [[ -n "$c" && -f "$c" ]] && CONTROL="$c" && break
done
if [[ -z "$CONTROL" ]]; then
  echo "harness-control.mjs not found; set HARNESS_CONTROL" >&2
  exit 2
fi

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"
SERVICE="$UNIT_DIR/${UNIT_NAME}.service"
TIMER="$UNIT_DIR/${UNIT_NAME}.timer"

ARGS=(--repo "$REPO" --wake-host)
if [[ -n "$PROJECT" ]]; then
  ARGS+=(--project "$PROJECT")
fi
if [[ "$NOTIFY" -eq 1 ]]; then
  ARGS+=(--notify)
fi
if [[ "$INVOKE_AGENT" -eq 1 ]]; then
  ARGS+=(--invoke-agent)
fi

# Escape for systemd ExecStart
exec_args=()
for a in "${ARGS[@]}"; do
  exec_args+=("$(printf '%q' "$a")")
done

UID_NUM="$(id -u)"
AGENT_BIN="$(command -v agent || true)"
if [[ -z "$AGENT_BIN" && -x "${HOME}/.local/bin/agent" ]]; then
  AGENT_BIN="${HOME}/.local/bin/agent"
fi
# systemd user units often lack ~/.local/bin on PATH — pin agent for --invoke-agent.
PATH_ENV="${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin"
cat >"$SERVICE" <<EOF
[Unit]
Description=Harness ops cron check (${REPO})
After=default.target

[Service]
Type=oneshot
# exit 1 = fleet needs attention (still a successful check run)
SuccessExitStatus=1
WorkingDirectory=${REPO}
Environment=HARNESS_CONTROL=${CONTROL}
Environment=HARNESS_MAX_SWAP_USED_RATIO=0.6
Environment=HARNESS_WAKE_AGENT=${AGENT_BIN}
Environment=PATH=${PATH_ENV}
Environment=DISPLAY=:0
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${UID_NUM}/bus
Environment=XDG_RUNTIME_DIR=/run/user/${UID_NUM}
ExecStart=$(command -v node) $(printf '%q' "$CHECK") ${exec_args[*]}
Nice=10
EOF

cat >"$TIMER" <<EOF
[Unit]
Description=Run harness ops cron every ${MINUTES} minutes (${REPO})

[Timer]
OnBootSec=2min
OnUnitActiveSec=${MINUTES}min
AccuracySec=30s
Persistent=true
Unit=${UNIT_NAME}.service

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "${UNIT_NAME}.timer"
systemctl --user start "${UNIT_NAME}.service" || true

echo "installed ${TIMER}"
echo "installed ${SERVICE}"
systemctl --user status "${UNIT_NAME}.timer" --no-pager || true
echo "--- last check ---"
systemctl --user status "${UNIT_NAME}.service" --no-pager -l || true
