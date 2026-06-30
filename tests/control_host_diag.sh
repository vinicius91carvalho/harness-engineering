#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/harness-control-test.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/repo" "$TMP/invalid"

git -C "$TMP/repo" init -b main -q
git -C "$TMP/repo" config user.name test
git -C "$TMP/repo" config user.email test@example.invalid
cat >"$TMP/repo/project_specs.xml" <<'XML'
<project_specification>
  <project_goal>The integrated service is ready.</project_goal>
  <acceptance_checks>
    <acceptance_check id="AC-001" context="core" category="functional" depends_on="">
      <description>The integrated health boundary returns ready.</description>
    </acceptance_check>
  </acceptance_checks>
</project_specification>
XML
cat >"$TMP/repo/feature_list.json" <<'JSON'
[{"id":"WI-AC-001","context":"core","description":"health works","steps":["verify health"],"acceptance_checks":["AC-001"],"depends_on":[],"implementation":false,"qa":false,"integration":false,"retries":0}]
JSON
git -C "$TMP/repo" add .
git -C "$TMP/repo" commit -qm init

cat >"$TMP/bin/claude" <<'SH'
#!/bin/sh
set -eu
prompt=""; for arg in "$@"; do prompt=$arg; done
case "$prompt" in
  *"Integrated Verification"*)
    jq 'map(if .id=="WI-AC-001" then .implementation=true | .qa=true | .integration=true else . end)' feature_list.json >feature_list.json.tmp
    mv feature_list.json.tmp feature_list.json
    git add feature_list.json && git commit -qm integration
    printf '%s\n' '{"id":"WI-AC-001","implementation":true,"integration":true,"defects":[]}'
    ;;
  *"independent Goal Review agent"*)
    printf '%s\n' '{"goal":true,"summary":"integrated goal observed","acceptanceCheckIds":["AC-001"],"defects":[]}'
    ;;
  *"coding-agent"*)
    jq 'map(if .id=="WI-AC-001" then .implementation=true else . end)' feature_list.json >feature_list.json.tmp
    mv feature_list.json.tmp feature_list.json
    git add feature_list.json && git commit -qm coding
    printf '%s\n' '{"id":"WI-AC-001","implementation":true,"notes":"implemented"}'
    ;;
  *"qa-agent"*)
    jq 'map(if .id=="WI-AC-001" then .implementation=true | .qa=true else . end)' feature_list.json >feature_list.json.tmp
    mv feature_list.json.tmp feature_list.json
    git add feature_list.json && git commit -qm qa
    printf '%s\n' '{"id":"WI-AC-001","implementation":true,"qa":true,"defects":[]}'
    ;;
esac
SH
chmod +x "$TMP/bin/claude"

NODE=$(command -v node)
CONTROL="$ROOT/skills/control-host/scripts/harness-control.mjs"
PATH="$TMP/bin:$(dirname "$NODE"):/usr/bin:/bin" "$NODE" "$CONTROL" run \
  --repo "$TMP/repo" --host claude --once true --poll-ms 250 \
  --max-workers 2 --quota-workers 1 --cpu-per-worker 0.25 \
  --memory-per-worker-mb 128 --reserve-memory-mb 0 --max-load-ratio 100

STATE="$TMP/repo/.git/harness-control/state.json"
EVENTS="$TMP/repo/.git/harness-control/events.jsonl"
jq -e '.status == "complete" and .supervisorPid == null and .progress.integrated == 1' "$STATE" >/dev/null || { cat "$STATE"; exit 1; }
jq -s -e 'any(.[]; .kind == "progress") and any(.[]; .kind == "goal_review_started") and any(.[]; .kind == "run_completed" and .immediate)' "$EVENTS" >/dev/null
echo 'ok - supervisor claims, builds, verifies, releases, and runs governed Goal Review'

echo "=== DIAGNOSTIC ===" >&2
echo "State status: $(jq -r .status "$STATE")" >&2
echo "Supervisor pid: $(jq -r .supervisorPid "$STATE")" >&2
GOAL_FILE="$TMP/repo/.git/harness-runs/goal-review.json"
if [ -f "$GOAL_FILE" ]; then
  echo "Goal file exists" >&2
  echo "Reviewed head: $(jq -r '.reviewedHead // "MISSING"' "$GOAL_FILE")" >&2
  echo "Goal status: $(jq -r '.status // "MISSING"' "$GOAL_FILE")" >&2
  echo "Goal phase: $(jq -r '.phase // "MISSING"' "$GOAL_FILE")" >&2
else
  echo "Goal file MISSING: $GOAL_FILE" >&2
fi
MAIN_HEAD=$(git -C "$TMP/repo" rev-parse main)
echo "Main HEAD: $MAIN_HEAD" >&2
echo "Git status: $(git -C "$TMP/repo" status --porcelain)" >&2
START_OUT=$("$NODE" "$CONTROL" start --repo "$TMP/repo" --host claude 2>&1)
echo "start() output: $START_OUT" >&2
echo "=== END DIAGNOSTIC ===" >&2
