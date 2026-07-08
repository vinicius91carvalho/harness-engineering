#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/harness-control-test.XXXXXX")
trap '[ "${KEEP_TMP:-0}" = 1 ] || rm -rf "$TMP"' EXIT
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
chmod +x "$TMP/bin/claude"

NODE=$(command -v node)
CONTROL="$ROOT/skills/supervisor/scripts/harness-control.mjs"
PATH="$TMP/bin:$(dirname "$NODE"):/usr/bin:/bin" "$NODE" "$CONTROL" run \
  --repo "$TMP/repo" --host claude --once true --poll-ms 250 \
  --max-workers 2 --quota-workers 1 --cpu-per-worker 0.25 \
  --memory-per-worker-mb 128 --reserve-memory-mb 0 --max-load-ratio 100

STATE="$TMP/repo/.git/harness-control/state.json"
EVENTS="$TMP/repo/.git/harness-control/events.jsonl"
jq -e '.status == "complete" and .supervisorPid == null and .progress.integrated == 1' "$STATE" >/dev/null || { cat "$STATE"; exit 1; }
jq -s -e 'any(.[]; .kind == "progress") and any(.[]; .kind == "goal_review_started") and any(.[]; .kind == "run_completed" and .immediate)' "$EVENTS" >/dev/null
echo 'ok - supervisor claims, builds, verifies, releases, and runs governed Goal Review'

mkdir -p "$TMP/installed/skills/harness-supervisor/scripts"
cp "$CONTROL" "$TMP/installed/skills/harness-supervisor/scripts/harness-control.mjs"
cp -R "$ROOT/skills/generator" "$TMP/installed/skills/harness-generator"
git clone -q "$TMP/repo" "$TMP/namespaced"
git -C "$TMP/namespaced" config user.name test
git -C "$TMP/namespaced" config user.email test@example.invalid
PATH="$TMP/bin:$(dirname "$NODE"):/usr/bin:/bin" "$NODE" \
  "$TMP/installed/skills/harness-supervisor/scripts/harness-control.mjs" run \
  --repo "$TMP/namespaced" --host claude --once true --poll-ms 250 --quota-workers 1 \
  --memory-per-worker-mb 128 --reserve-memory-mb 0 --max-load-ratio 100
jq -e '.status == "complete"' "$TMP/namespaced/.git/harness-control/state.json" >/dev/null
echo 'ok - OpenCode namespaced supervisor resolves its generator sibling'

mkdir -p "$TMP/monorepo/app"
cp "$TMP/repo/project_specs.xml" "$TMP/monorepo/app/project_specs.xml"
cp "$TMP/repo/feature_list.json" "$TMP/monorepo/app/feature_list.json"
jq 'map(.implementation=false | .qa=false | .integration=false)' \
  "$TMP/monorepo/app/feature_list.json" >"$TMP/monorepo/app/feature_list.json.tmp"
mv "$TMP/monorepo/app/feature_list.json.tmp" "$TMP/monorepo/app/feature_list.json"
git -C "$TMP/monorepo" init -b main -q
git -C "$TMP/monorepo" config user.name test
git -C "$TMP/monorepo" config user.email test@example.invalid
git -C "$TMP/monorepo" add .
git -C "$TMP/monorepo" commit -qm init
touch "$TMP/monorepo/unrelated.txt"
bash "$ROOT/skills/generator/claim.sh" select-claim \
  "$TMP/monorepo/app" all '' 999999 >"$TMP/monorepo-claim.json"
jq '.heartbeatEpoch=1' "$TMP/monorepo/.git/harness-runs/app--core.json" \
  >"$TMP/monorepo/.git/harness-runs/app--core.json.tmp"
mv "$TMP/monorepo/.git/harness-runs/app--core.json.tmp" \
  "$TMP/monorepo/.git/harness-runs/app--core.json"
PATH="$TMP/bin:$(dirname "$NODE"):/usr/bin:/bin" "$NODE" "$CONTROL" run \
  --repo "$TMP/monorepo/app" --host claude --poll-ms 250 --quota-workers 1 \
  --memory-per-worker-mb 128 --reserve-memory-mb 0 --max-load-ratio 100
jq -e '.status == "complete" and .phase == "complete"' \
  "$TMP/monorepo/.git/harness-runs/app--goal-review.json" >/dev/null
jq -e '.status == "complete"' "$TMP/monorepo/.git/harness-control/app/state.json" >/dev/null
echo 'ok - nested projects recover and complete project-namespaced Run State'
test -f "$TMP/monorepo/unrelated.txt"

mkdir -p "$TMP/mono2/appA" "$TMP/mono2/appB"
cp "$TMP/repo/project_specs.xml" "$TMP/mono2/appA/project_specs.xml"
jq 'map(.implementation=true | .qa=true | .integration=true)' "$TMP/repo/feature_list.json" \
  >"$TMP/mono2/appA/feature_list.json"
git -C "$TMP/mono2" init -b main -q
git -C "$TMP/mono2" config user.name test
git -C "$TMP/mono2" config user.email test@example.invalid
git -C "$TMP/mono2" add .
git -C "$TMP/mono2" commit -qm init
mkdir -p "$TMP/mono2/.git"
printf '%s\n' '{"appB--ghost":{"context":"ghost","status":"blocked"}}' >"$TMP/mono2/.git/generator-claims.json"
PATH="$TMP/bin:$(dirname "$NODE"):/usr/bin:/bin" "$NODE" "$CONTROL" run \
  --repo "$TMP/mono2/appA" --host claude --once true --poll-ms 250 \
  --memory-per-worker-mb 128 --reserve-memory-mb 0 --max-load-ratio 100
jq -e '.progress.blocked == 0' "$TMP/mono2/.git/harness-control/appA/state.json" >/dev/null \
  || { cat "$TMP/mono2/.git/harness-control/appA/state.json"; echo 'not ok - sibling subproject appB'"'"'s blocked claim leaked into appA'"'"'s own blocked count' >&2; exit 1; }
if jq -s -e 'any(.[]; .context == "ghost")' "$TMP/mono2/.git/harness-control/appA/events.jsonl" >/dev/null 2>&1; then
  echo 'not ok - appA raised a ghost input_required event for sibling appB'"'"'s context' >&2; exit 1
fi
echo 'ok - a subproject'"'"'s status/claims inspection never sees a sibling subproject'"'"'s claims in a shared monorepo .git'

"$NODE" "$CONTROL" start --repo "$TMP/repo" --host claude | jq -e '.started == false and .status == "complete"' >/dev/null
git clone -q "$TMP/repo" "$TMP/detached"
git -C "$TMP/detached" config user.name test
git -C "$TMP/detached" config user.email test@example.invalid
PATH="$TMP/bin:$(dirname "$NODE"):/usr/bin:/bin" HARNESS_TEST_GOAL_SLEEP=1 "$NODE" "$CONTROL" start \
  --repo "$TMP/detached" --host claude --poll-ms 250 --quota-workers 1 \
  --memory-per-worker-mb 128 --reserve-memory-mb 0 --max-load-ratio 100 | jq -e '.started == true' >/dev/null
if PATH="$TMP/bin:$(dirname "$NODE"):/usr/bin:/bin" "$NODE" "$CONTROL" start --repo "$TMP/detached" --host claude >/dev/null 2>&1; then
  echo 'not ok - a second live supervisor acquired the same repository' >&2; exit 1
fi
for _ in $(seq 1 50); do
  [ "$("$NODE" "$CONTROL" status --repo "$TMP/detached" | jq -r 'select(.status == "complete" and .supervisorPid == null) | "ready"')" = ready ] && break
  sleep 0.1
done
"$NODE" "$CONTROL" status --repo "$TMP/detached" | jq -e '.status == "complete" and .supervisorPid == null' >/dev/null
echo 'ok - detached start is singleton/recoverable and already-reviewed main is idempotent'

"$NODE" "$CONTROL" events --repo "$TMP/repo" --consumer test-telegram >"$TMP/unread.json"
LAST=$(jq '.[-1].id' "$TMP/unread.json")
test "$LAST" -gt 0
"$NODE" "$CONTROL" ack --repo "$TMP/repo" --consumer test-telegram --event "$LAST" >/dev/null
test "$("$NODE" "$CONTROL" events --repo "$TMP/repo" --consumer test-telegram | jq length)" -eq 0
echo 'ok - durable consumer acknowledgements survive chat context loss'

"$NODE" "$CONTROL" quota --repo "$TMP/repo" --workers 0 >/dev/null
"$NODE" "$CONTROL" capacity --repo "$TMP/repo" --host claude \
  --max-load-ratio 100 --reserve-memory-mb 0 | jq -e '.limit == 0 and .quota.slots == 0' >/dev/null
echo 'ok - provider quota is a hard worker-admission limit'

git -C "$TMP/invalid" init -b main -q
git -C "$TMP/invalid" config user.name test
git -C "$TMP/invalid" config user.email test@example.invalid
printf '%s\n' '<project_specification />' >"$TMP/invalid/project_specs.xml"
printf '%s\n' '[]' >"$TMP/invalid/feature_list.json"
git -C "$TMP/invalid" add .
git -C "$TMP/invalid" commit -qm init
PATH="$TMP/bin:$(dirname "$NODE"):/usr/bin:/bin" "$NODE" "$CONTROL" run \
  --repo "$TMP/invalid" --host claude --once true --max-load-ratio 100
INVALID_STATE="$TMP/invalid/.git/harness-control/state.json"
INVALID_EVENTS="$TMP/invalid/.git/harness-control/events.jsonl"
jq -e '.status == "needs_input" and .supervisorPid == null' "$INVALID_STATE" >/dev/null
REQUEST=$(jq -s '[.[] | select(.kind == "input_required")][0].id' "$INVALID_EVENTS")
"$NODE" "$CONTROL" respond --repo "$TMP/invalid" --event "$REQUEST" --action amend >/dev/null
"$NODE" "$CONTROL" respond --repo "$TMP/invalid" --event "$REQUEST" --action amend >/dev/null
if "$NODE" "$CONTROL" respond --repo "$TMP/invalid" --event "$REQUEST" --action abort >/dev/null 2>&1; then
  echo 'not ok - conflicting duplicate Input Request response accepted' >&2; exit 1
fi
test -f "$TMP/invalid/.git/harness-control/responses/$REQUEST.json"
PATH="$TMP/bin:$(dirname "$NODE"):/usr/bin:/bin" "$NODE" "$CONTROL" start --repo "$TMP/invalid" --host claude | jq -e '.started == true' >/dev/null
for _ in $(seq 1 30); do
  [ "$("$NODE" "$CONTROL" status --repo "$TMP/invalid" | jq -r 'select(.status == "paused" and .supervisorPid == null) | "ready"')" = ready ] && break
  sleep 0.1
done
"$NODE" "$CONTROL" status --repo "$TMP/invalid" | jq -e '.status == "paused" and .supervisorPid == null' >/dev/null
"$NODE" "$CONTROL" start --repo "$TMP/invalid" --host claude | jq -e '.started == false and .status == "paused"' >/dev/null
echo 'ok - invalid planning emits a durable goal Input Request and consumes its idempotent response after restart'

mkdir -p "$TMP/retry"
git -C "$TMP/retry" init -b main -q
git -C "$TMP/retry" config user.name test
git -C "$TMP/retry" config user.email test@example.invalid
cp "$TMP/repo/project_specs.xml" "$TMP/retry/project_specs.xml"
cat >"$TMP/retry/feature_list.json" <<'JSON'
[{"id":"WI-AC-001","context":"core","description":"health works","steps":["verify health"],"acceptance_checks":["AC-001"],"depends_on":[],"implementation":true,"qa":true,"integration":true,"retries":1}]
JSON
git -C "$TMP/retry" add . && git -C "$TMP/retry" commit -qm init
mkdir -p "$TMP/retry/.git/harness-control"
printf '%s\n' '{"retryQueue":{"ghost":{"guidance":"","attempts":3}}}' >"$TMP/retry/.git/harness-control/state.json"
PATH="$TMP/bin:$(dirname "$NODE"):/usr/bin:/bin" HARNESS_TEST_GOAL_SLEEP=3 "$NODE" "$CONTROL" run \
  --repo "$TMP/retry" --host claude --poll-ms 250 \
  --max-workers 2 --quota-workers 2 --cpu-per-worker 0.25 \
  --memory-per-worker-mb 128 --reserve-memory-mb 0 --max-load-ratio 100
RETRY_STATE="$TMP/retry/.git/harness-control/state.json"
RETRY_EVENTS="$TMP/retry/.git/harness-control/events.jsonl"
jq -e '.retryQueue == {}' "$RETRY_STATE" >/dev/null
jq -s -e 'any(.[]; .kind == "input_required" and .context == "ghost" and .reason == "Retry could not resume the Claim Lease")' "$RETRY_EVENTS" >/dev/null
echo 'ok - a retry that can never resume its Claim Lease re-raises a bounded Input Request'

mkdir -p "$TMP/circuit"
git -C "$TMP/circuit" init -b main -q
git -C "$TMP/circuit" config user.name test
git -C "$TMP/circuit" config user.email test@example.invalid
cp "$TMP/repo/project_specs.xml" "$TMP/circuit/project_specs.xml"
cat >"$TMP/circuit/feature_list.json" <<'JSON'
[{"id":"WI-AC-001","context":"core","description":"health works","steps":["verify health"],"acceptance_checks":["AC-001"],"depends_on":[],"implementation":false,"qa":false,"integration":false,"retries":0}]
JSON
git -C "$TMP/circuit" add . && git -C "$TMP/circuit" commit -qm init
mkdir -p "$TMP/circuit/.git/harness-control" "$TMP/circuit/.git/harness-runs"
printf '%s\n' '{"flaky":{"context":"flaky","status":"building","worktree":"/nonexistent","branch":"gen/flaky","port":9,"featureIds":[]},"boom":{"context":"boom","status":"building","worktree":"'"$TMP"'/circuit","branch":"gen/boom","port":9,"featureIds":[]}}' \
  >"$TMP/circuit/.git/generator-claims.json"
printf '%s\n' '{"status":"resuming","ownerPid":999999999,"childPid":null}' \
  >"$TMP/circuit/.git/harness-runs/flaky.json"
printf '%s\n' '{"status":"resuming","ownerPid":999999999,"childPid":null}' \
  >"$TMP/circuit/.git/harness-runs/boom.json"
printf '%s\n' '{"crashCounts":{"flaky":5}}' >"$TMP/circuit/.git/harness-control/state.json"
if ! PATH="$TMP/bin:$(dirname "$NODE"):/usr/bin:/bin" timeout 20 "$NODE" "$CONTROL" run \
  --repo "$TMP/circuit" --host claude --poll-ms 250 \
  --max-workers 2 --quota-workers 2 --cpu-per-worker 0.25 \
  --memory-per-worker-mb 128 --reserve-memory-mb 0 --max-load-ratio 100; then
  echo 'not ok - run never reached completion (a crash-looping context with no bound would hang here forever)' >&2; exit 1
fi
CIRCUIT_STATE="$TMP/circuit/.git/harness-control/state.json"
CIRCUIT_EVENTS="$TMP/circuit/.git/harness-control/events.jsonl"
jq -e '.status == "complete" and .progress.integrated == 1' "$CIRCUIT_STATE" >/dev/null \
  || { cat "$CIRCUIT_STATE"; exit 1; }
jq -e '.crashCounts.flaky == 5' "$CIRCUIT_STATE" >/dev/null \
  || { echo 'not ok - a context already at the crash bound was touched (should stay untouched, never dispatched)' >&2; cat "$CIRCUIT_STATE" >&2; exit 1; }
if jq -s -e 'any(.[]; .context == "flaky")' "$CIRCUIT_EVENTS" >/dev/null 2>&1; then
  echo 'not ok - a context already at the crash bound was still dispatched/raised an event instead of being skipped' >&2; exit 1
fi
echo 'ok - a context already at the crash-count bound is never auto-recovered again, while its sibling context keeps completing normally'

jq -s -e 'any(.[]; .kind == "input_required" and .context == "boom" and (.reason | contains("--features is required")))' "$CIRCUIT_EVENTS" >/dev/null \
  || { echo 'not ok - a worker crash reason did not surface the actual error from its log (still just "Worker exited with code N")' >&2; cat "$CIRCUIT_EVENTS" >&2; exit 1; }
echo 'ok - a worker crash surfaces its real log-level error in the Input Request reason, not just an exit code'
