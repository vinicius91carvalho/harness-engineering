#!/bin/sh
# Shared role-routing stub for orchestrator_test.sh.
# Installed as claude, codex, and opencode under a test bin dir.
# Parses --model from argv and logs "kind harness model" to HARNESS_TEST_ROLES_LOG.
set -eu

harness=$(basename "$0")
model=
prompt=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -p|--print|--force|--trust|--approve-mcps|--yolo) shift ;;
    exec|run) shift ;;
    --model) model=$2; shift 2 ;;
    --sandbox) shift 2 ;;
    --dangerously-bypass-approvals-and-sandbox) shift ;;
    *) prompt=$1; shift ;;
  esac
done

case "$model" in
  rate-limit) echo "ERROR: You've hit your usage limit. Try again at Jul 9th, 2026 12:17 AM." >&2; exit 1 ;;
  auth-fail) echo 'authentication credential rejected' >&2; exit 1 ;;
  missing-model) echo 'model is unavailable' >&2; exit 1 ;;
  missing-cli) echo 'claude: command not found' >&2; exit 127 ;;
  launch-fail) echo 'worker launch failed' >&2; exit 1 ;;
  fail-402) echo 'HTTP 402 insufficient credits' >&2; exit 1 ;;
  fail-quota) echo 'HTTP 429 quota exceeded' >&2; exit 1 ;;
  fail-infra) echo 'worker launch failed' >&2; exit 1 ;;
esac

kind=unknown
case "$prompt" in
  *"orchestrator repair planner"*) kind=repair ;;
  *"Integrated Verification"*) kind=integration ;;
  *"coding-agent"*) kind=coding ;;
  *"qa-agent"*) kind=qa ;;
esac
printf '%s %s %s\n' "$kind" "$harness" "${model:-default}" >>"${HARNESS_TEST_ROLES_LOG:?HARNESS_TEST_ROLES_LOG required}"
tmp="$PWD/feature_list.json.tmp"
commit() { git add feature_list.json; git commit -qm "$1"; }
case "$kind" in
  repair) printf '%s\n' '{"summary":"repair","rootCause":"defect","actions":["fix"],"validation":["check"]}' ;;
  coding)
    if [ "$model" = decline ]; then
      printf '%s\n' '{"id":"WI-AC-001","implementation":false,"notes":"scope exceeds budget"}'; exit 0
    fi
    jq 'map(if .id=="WI-AC-001" then .implementation=true else . end)' feature_list.json >"$tmp" && mv "$tmp" feature_list.json
    commit coding; printf '%s\n' '{"id":"WI-AC-001","implementation":true}' ;;
  qa)
    count=0; [ ! -f "${HARNESS_TEST_ROLES_QA:-}" ] || count=$(cat "$HARNESS_TEST_ROLES_QA")
    count=$((count + 1)); printf '%s' "$count" >"${HARNESS_TEST_ROLES_QA:-/dev/null}"
    fails=${HARNESS_TEST_ROLES_QA_FAILS:-1}
    if [ "$count" -le "$fails" ]; then
      jq 'map(if .id=="WI-AC-001" then .implementation=false | .qa=false else . end)' feature_list.json >"$tmp" && mv "$tmp" feature_list.json
      commit qa-defect; printf '%s\n' '{"id":"WI-AC-001","qa":false,"implementation":false,"defects":["product defect"]}'
    else
      jq 'map(if .id=="WI-AC-001" then .qa=true else . end)' feature_list.json >"$tmp" && mv "$tmp" feature_list.json
      commit qa-pass; printf '%s\n' '{"id":"WI-AC-001","qa":true,"implementation":true,"defects":[]}'
    fi ;;
  integration)
    jq 'map(if .id=="WI-AC-001" then .integration=true else . end)' feature_list.json >"$tmp" && mv "$tmp" feature_list.json
    commit integration; printf '%s\n' '{"id":"WI-AC-001","integration":true,"implementation":true,"defects":[]}' ;;
esac
