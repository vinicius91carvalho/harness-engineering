#!/usr/bin/env bash
# Canonical Worktree Runtime Lifecycle skeleton (source of truth).
# Initializer copies/adapts this into the project root as ./init.sh.
# Fill cmd_start for the stack; keep subcommand dispatch and PID/health invariants.
set -euo pipefail

PORT="${PORT:-3000}"
FRONTEND_PORT="${FRONTEND_PORT:-$PORT}"
BACKEND_PORT="${BACKEND_PORT:-$((PORT + 1))}"
PID_FILE=".harness/app.pid"
LOG_FILE="dev.log"
HEALTH_URL="http://127.0.0.1:${PORT}/"

usage() {
  cat <<'EOF'
Usage: ./init.sh [start|stop|restart|status|help]
  start    (default) install deps if needed, daemonize app, wait for Ready
  stop     stop process tree rooted at .harness/app.pid
  restart  stop then start
  status   exit 0 if pid alive and health URL responds
  help     show this usage
EOF
}

kill_process_tree() {
  local pid="$1"
  local sig="$2"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_process_tree "$child" "$sig"
  done
  kill -"$sig" "$pid" 2>/dev/null || true
}

cmd_stop() {
  if [[ -s "$PID_FILE" ]]; then
    pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then
      kill_process_tree "$pid" TERM
      for _ in $(seq 1 20); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
      done
      kill_process_tree "$pid" KILL
    fi
    rm -f "$PID_FILE"
  fi
}

cmd_status() {
  local alive=0 healthy=0
  if [[ -s "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    alive=1
  fi
  if curl -sf -o /dev/null --max-time 2 "$HEALTH_URL" 2>/dev/null; then
    healthy=1
  fi
  echo "pid_alive=$alive healthy=$healthy url=$HEALTH_URL"
  [[ "$alive" -eq 1 && "$healthy" -eq 1 ]]
}

cmd_start() {
  mkdir -p .harness
  if cmd_status >/dev/null 2>&1; then
    echo "Ready ${HEALTH_URL} (already up)"
    return 0
  fi
  # Projects replace the stub below with real start logic for this stack:
  # 1) install jq + deps if missing
  # 2) daemonize the app bound to PORT / FRONTEND_PORT / BACKEND_PORT,
  #    append to $LOG_FILE, write the **server** PID (not the shell) to $PID_FILE
  # 3) optional: wait for HEALTH_URL here, or rely on the health wait below
  :
  # Fail closed until a real process is recorded (no false Ready on the template stub).
  if [[ ! -s "$PID_FILE" ]] || ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "init.sh: start is not configured — replace the cmd_start stub with daemonize and health steps for this stack" >&2
    exit 1
  fi
  local i
  for i in $(seq 1 60); do
    if curl -sf -o /dev/null --max-time 2 "$HEALTH_URL" 2>/dev/null; then
      echo "Ready ${HEALTH_URL} (logs: $LOG_FILE)"
      return 0
    fi
    sleep 1
  done
  echo "init.sh: timed out waiting for health check at $HEALTH_URL" >&2
  exit 1
}

cmd="${1:-start}"
case "$cmd" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  status) cmd_status ;;
  help|-h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
