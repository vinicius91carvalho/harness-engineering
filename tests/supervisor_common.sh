#!/usr/bin/env bash
# Shared fixtures for supervisor fast/e2e tests.
set -euo pipefail

supervisor_common_root() {
  CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd
}

supervisor_common_init() {
  unset HARNESS_INTEGRATION_BRANCH
  ROOT=$(supervisor_common_root)
  TMP=$(mktemp -d "${TMPDIR:-/tmp}/harness-control-test.XXXXXX")
  trap '[ "${KEEP_TMP:-0}" = 1 ] || rm -rf "$TMP"' EXIT
  NODE=$(command -v node)
  CONTROL="$ROOT/skills/supervisor/scripts/harness-control.mjs"
  mkdir -p "$TMP/bin"
  supervisor_common_write_claude_stub "$TMP/bin/claude"
  export ROOT TMP NODE CONTROL
  export SUPERVISOR_PATH="$TMP/bin:$(dirname "$NODE"):/usr/bin:/bin"
}

supervisor_common_write_claude_stub() {
  local stub=$1
  cat >"$stub" <<'SH'
#!/bin/sh
set -eu
prompt=""; for arg in "$@"; do prompt=$arg; done
if [ "${HARNESS_TEST_USAGE_LIMIT:-}" = 1 ]; then
  echo "ERROR: You've hit your usage limit. Try again at Jul 9th, 2026 12:17 AM." >&2
  exit 1
fi
case "$prompt" in
  *"Integrated Verification"*)
    printf '%s\n' '{"id":"WI-AC-001","implementation":true,"integration":true,"defects":[]}'
    ;;
  *"independent Goal Review agent"*)
    [ -z "${HARNESS_TEST_GOAL_SLEEP:-}" ] || sleep "$HARNESS_TEST_GOAL_SLEEP"
    printf '%s\n' '{"goal":true,"summary":"integrated goal observed","acceptanceCheckIds":["AC-001"],"defects":[]}'
    ;;
  *"coding-agent"*)
    printf '%s\n' '{"id":"WI-AC-001","implementation":true,"notes":"implemented"}'
    ;;
  *"qa-agent"*)
    printf '%s\n' '{"id":"WI-AC-001","implementation":true,"qa":true,"defects":[]}'
    ;;
esac
SH
  chmod +x "$stub"
}

supervisor_common_write_specs() {
  local dir=$1
  cat >"$dir/project_specs.xml" <<'XML'
<project_specification>
  <project_goal>The integrated service is ready.</project_goal>
  <acceptance_checks>
    <acceptance_check id="AC-001" context="core" category="functional" depends_on="">
      <description>The integrated health boundary returns ready.</description>
    </acceptance_check>
  </acceptance_checks>
</project_specification>
XML
}

supervisor_common_write_feature_queue() {
  local file=$1 integrated=${2:-false}
  if [ "$integrated" = true ]; then
    cat >"$file" <<'JSON'
[{"id":"WI-AC-001","context":"core","description":"health works","steps":["verify health"],"acceptance_checks":["AC-001"],"depends_on":[],"implementation":true,"qa":true,"integration":true,"retries":0}]
JSON
  else
    cat >"$file" <<'JSON'
[{"id":"WI-AC-001","context":"core","description":"health works","steps":["verify health"],"acceptance_checks":["AC-001"],"depends_on":[],"implementation":false,"qa":false,"integration":false,"retries":0}]
JSON
  fi
}

supervisor_common_init_git_repo() {
  local dir=$1 integrated=${2:-false}
  git -C "$dir" init -b main -q
  git -C "$dir" config user.name test
  git -C "$dir" config user.email test@example.invalid
  supervisor_common_write_specs "$dir"
  supervisor_common_write_feature_queue "$dir/feature_list.json" "$integrated"
  git -C "$dir" add .
  git -C "$dir" commit -qm init
}

supervisor_common_seed_completed_repo() {
  local dir=$1
  supervisor_common_init_git_repo "$dir" true
  mkdir -p "$dir/.git/harness-control" "$dir/.git/harness-runs"
  local head
  head=$(git -C "$dir" rev-parse main)
  cat >"$dir/.git/harness-control/state.json" <<JSON
{"status":"complete","supervisorPid":null,"phase":"complete","progress":{"total":1,"implemented":1,"verified":1,"integrated":1,"blocked":0},"pendingInputs":{},"retryQueue":{}}
JSON
  cat >"$dir/.git/harness-control/events.jsonl" <<'JSONL'
{"id":1,"kind":"progress","integrated":1}
{"id":2,"kind":"goal_review_started"}
{"id":3,"kind":"run_completed","immediate":true}
JSONL
  printf '%s\n' "{\"status\":\"complete\",\"phase\":\"complete\",\"reviewedHead\":\"$head\"}" \
    >"$dir/.git/harness-runs/goal-review.json"
}

supervisor_common_run_once() {
  PATH="$SUPERVISOR_PATH" "$NODE" "$CONTROL" run "$@"
}

supervisor_common_run_timeout() {
  local secs=$1; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
  else
    "$@" &
    local pid=$!
    local status=0
    ( sleep "$secs"; kill "$pid" 2>/dev/null ) &
    local killer=$!
    wait "$pid" 2>/dev/null || status=$?
    kill "$killer" 2>/dev/null || true
    wait "$killer" 2>/dev/null || true
    return "$status"
  fi
}
