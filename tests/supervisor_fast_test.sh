#!/usr/bin/env bash
# Fast supervisor tests: CLI, seeded state, and single-tick (--once true) policy checks.
# No full claim-to-goal-review pipeline runs (those live in supervisor_e2e_test.sh).
set -euo pipefail
# shellcheck source=tests/supervisor_common.sh
source "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/supervisor_common.sh"
supervisor_common_init

mkdir -p "$TMP/repo" "$TMP/invalid"
supervisor_common_seed_completed_repo "$TMP/repo"

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

"$NODE" "$CONTROL" capacity --repo "$TMP/repo" --host claude \
  | jq -e '.memory.perWorkerMb == 1024 and .memory.reserveMb == 1024' >/dev/null
echo 'ok - default memory gate is 1GB/worker plus 1GB reserve, calibrated to real ~250MB worker RSS not the old 2GB gate'

"$NODE" "$CONTROL" start --repo "$TMP/repo" --host claude | jq -e '.started == false and .status == "complete"' >/dev/null
echo 'ok - start on an already-complete repository is idempotent'

git clone -q "$TMP/repo" "$TMP/quota-limit"
git -C "$TMP/quota-limit" config user.name test
git -C "$TMP/quota-limit" config user.email test@example.invalid
supervisor_common_write_feature_queue "$TMP/quota-limit/feature_list.json" false
git -C "$TMP/quota-limit" add feature_list.json && git -C "$TMP/quota-limit" commit -qm reset
PATH="$SUPERVISOR_PATH" HARNESS_TEST_USAGE_LIMIT=1 HARNESS_RATE_LIMIT_BACKOFF_MS=100 HARNESS_RATE_LIMIT_JITTER_MS=0 \
  supervisor_common_run_timeout 5 "$NODE" "$CONTROL" run \
  --repo "$TMP/quota-limit" --host claude --poll-ms 50 --quota-cooldown-seconds 60 \
  --memory-per-worker-mb 128 --reserve-memory-mb 0 --max-load-ratio 100 >/dev/null 2>&1 || true
jq -s -e 'any(.[]; .kind == "quota_wait") and all(.[]; .kind != "input_required")' \
  "$TMP/quota-limit/.git/harness-control/events.jsonl" >/dev/null
jq -e '.retryQueue.core.guidance | contains("Provider quota")' \
  "$TMP/quota-limit/.git/harness-control/state.json" >/dev/null
echo 'ok - provider usage limits pause quota and auto-retry instead of raising a false Work Item Input Request'

git -C "$TMP/invalid" init -b main -q
git -C "$TMP/invalid" config user.name test
git -C "$TMP/invalid" config user.email test@example.invalid
printf '%s\n' '<project_specification />' >"$TMP/invalid/project_specs.xml"
printf '%s\n' '[]' >"$TMP/invalid/feature_list.json"
git -C "$TMP/invalid" add .
git -C "$TMP/invalid" commit -qm init
supervisor_common_run_once --repo "$TMP/invalid" --host claude --once true --max-load-ratio 100
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
PATH="$SUPERVISOR_PATH" "$NODE" "$CONTROL" start --repo "$TMP/invalid" --host claude | jq -e '.started == true' >/dev/null
for _ in $(seq 1 30); do
  [ "$("$NODE" "$CONTROL" status --repo "$TMP/invalid" | jq -r 'select(.status == "paused" and .supervisorPid == null) | "ready"')" = ready ] && break
  sleep 0.1
done
"$NODE" "$CONTROL" status --repo "$TMP/invalid" | jq -e '.status == "paused" and .supervisorPid == null' >/dev/null
"$NODE" "$CONTROL" start --repo "$TMP/invalid" --host claude | jq -e '.started == false and .status == "paused"' >/dev/null
echo 'ok - invalid planning emits a durable goal Input Request and consumes its idempotent response after restart'

mkdir -p "$TMP/retry"
supervisor_common_init_git_repo "$TMP/retry" true
mkdir -p "$TMP/retry/.git/harness-control"
printf '%s\n' '{"retryQueue":{"ghost":{"guidance":"","attempts":3}}}' >"$TMP/retry/.git/harness-control/state.json"
supervisor_common_run_once --repo "$TMP/retry" --host claude --once true --poll-ms 50 \
  --max-workers 2 --quota-workers 2 --cpu-per-worker 0.25 \
  --memory-per-worker-mb 128 --reserve-memory-mb 0 --max-load-ratio 100
RETRY_STATE="$TMP/retry/.git/harness-control/state.json"
RETRY_EVENTS="$TMP/retry/.git/harness-control/events.jsonl"
jq -e '.retryQueue == {}' "$RETRY_STATE" >/dev/null
jq -s -e 'any(.[]; .kind == "input_required" and .context == "ghost" and .reason == "Retry could not resume the Claim Lease")' "$RETRY_EVENTS" >/dev/null
echo 'ok - a retry that can never resume its Claim Lease re-raises a bounded Input Request'

mkdir -p "$TMP/prune"
supervisor_common_init_git_repo "$TMP/prune" false
printf '%s\n' '{"realblock":{"context":"realblock","status":"blocked","worktree":"/nonexistent","branch":"gen/realblock","port":9,"featureIds":[]}}' \
  >"$TMP/prune/.git/generator-claims.json"
mkdir -p "$TMP/prune/.git/harness-control"
cat >"$TMP/prune/.git/harness-control/state.json" <<'JSON'
{"pendingInputs":{
  "100":{"id":100,"kind":"input_required","scope":"context","context":"ghost-orphan","reason":"Work Item blocked","status":"pending","choices":["retry","pause","abort"]},
  "101":{"id":101,"kind":"input_required","scope":"context","context":"realblock","reason":"Work Item blocked","status":"pending","choices":["retry","pause","abort"]},
  "102":{"id":102,"kind":"input_required","scope":"goal","context":null,"reason":"goal needs a human decision","status":"pending","choices":["retry","pause","abort"]}
}}
JSON
supervisor_common_run_once --repo "$TMP/prune" --host claude --once true --poll-ms 50 \
  --max-workers 2 --quota-workers 2 --cpu-per-worker 0.25 \
  --memory-per-worker-mb 128 --reserve-memory-mb 0 --max-load-ratio 100
PRUNE_STATE="$TMP/prune/.git/harness-control/state.json"
jq -e '(.pendingInputs | has("100") | not) and (.pendingInputs | has("101")) and (.pendingInputs | has("102"))' "$PRUNE_STATE" >/dev/null \
  || { jq '.pendingInputs | keys' "$PRUNE_STATE"; echo 'not ok - orphaned pending was not pruned, or a real blocked/goal event was wrongly dropped' >&2; exit 1; }
echo 'ok - an orphaned context Input Request (no live claim) is pruned while a blocked-claim event and a goal event are kept'

mkdir -p "$TMP/mono2/appA" "$TMP/mono2/appB"
cp "$TMP/repo/project_specs.xml" "$TMP/mono2/appA/project_specs.xml"
supervisor_common_write_feature_queue "$TMP/mono2/appA/feature_list.json" true
git -C "$TMP/mono2" init -b main -q
git -C "$TMP/mono2" config user.name test
git -C "$TMP/mono2" config user.email test@example.invalid
git -C "$TMP/mono2" add .
git -C "$TMP/mono2" commit -qm init
mkdir -p "$TMP/mono2/.git"
printf '%s\n' '{"appB--ghost":{"context":"ghost","status":"blocked"}}' >"$TMP/mono2/.git/generator-claims.json"
supervisor_common_run_once --repo "$TMP/mono2/appA" --host claude --once true --poll-ms 50 \
  --memory-per-worker-mb 128 --reserve-memory-mb 0 --max-load-ratio 100
jq -e '.progress.blocked == 0' "$TMP/mono2/.git/harness-control/appA/state.json" >/dev/null \
  || { cat "$TMP/mono2/.git/harness-control/appA/state.json"; echo 'not ok - sibling subproject appB'"'"'s blocked claim leaked into appA'"'"'s own blocked count' >&2; exit 1; }
if jq -s -e 'any(.[]; .context == "ghost")' "$TMP/mono2/.git/harness-control/appA/events.jsonl" >/dev/null 2>&1; then
  echo 'not ok - appA raised a ghost input_required event for sibling appB'"'"'s context' >&2; exit 1
fi
echo 'ok - a subproject'"'"'s status/claims inspection never sees a sibling subproject'"'"'s claims in a shared monorepo .git'

mkdir -p "$TMP/installed/skills/harness-supervisor/scripts" "$TMP/installed/skills/harness-supervisor/lib"
cp "$CONTROL" "$TMP/installed/skills/harness-supervisor/scripts/harness-control.mjs"
cp "$ROOT/skills/supervisor/lib/herdr-spawn.mjs" "$TMP/installed/skills/harness-supervisor/lib/herdr-spawn.mjs"
cp -R "$ROOT/skills/generator" "$TMP/installed/skills/harness-generator"
git clone -q "$TMP/repo" "$TMP/namespaced"
git -C "$TMP/namespaced" config user.name test
git -C "$TMP/namespaced" config user.email test@example.invalid
PATH="$SUPERVISOR_PATH" "$NODE" \
  "$TMP/installed/skills/harness-supervisor/scripts/harness-control.mjs" run \
  --repo "$TMP/namespaced" --host claude --once true --poll-ms 50 --quota-workers 1 \
  --memory-per-worker-mb 128 --reserve-memory-mb 0 --max-load-ratio 100
jq -e '.status == "complete"' "$TMP/namespaced/.git/harness-control/state.json" >/dev/null
echo 'ok - OpenCode namespaced supervisor resolves its generator sibling'

git clone -q "$TMP/repo" "$TMP/background"
git -C "$TMP/background" config user.name test
git -C "$TMP/background" config user.email test@example.invalid
supervisor_common_write_feature_queue "$TMP/background/feature_list.json" false
git -C "$TMP/background" add feature_list.json && git -C "$TMP/background" commit -qm reset
PATH="$SUPERVISOR_PATH" HERDR_ENV=1 supervisor_common_run_once \
  --repo "$TMP/background" --host claude --once true --poll-ms 50 --display background \
  --quota-workers 1 --memory-per-worker-mb 128 --reserve-memory-mb 0 --max-load-ratio 100
jq -e '.status == "complete"' "$TMP/background/.git/harness-control/state.json" >/dev/null
echo 'ok - --display background preserves child-process spawn even when HERDR_ENV=1'

mkdir -p "$TMP/circuit"
supervisor_common_init_git_repo "$TMP/circuit" false
mkdir -p "$TMP/circuit/.git/harness-control" "$TMP/circuit/.git/harness-runs"
printf '%s\n' '{"flaky":{"context":"flaky","status":"building","worktree":"/nonexistent","branch":"gen/flaky","port":9,"featureIds":[]},"boom":{"context":"boom","status":"building","worktree":"'"$TMP"'/circuit","branch":"gen/boom","port":9,"featureIds":[]}}' \
  >"$TMP/circuit/.git/generator-claims.json"
printf '%s\n' '{"status":"resuming","ownerPid":999999999,"childPid":null}' \
  >"$TMP/circuit/.git/harness-runs/flaky.json"
printf '%s\n' '{"status":"resuming","ownerPid":999999999,"childPid":null}' \
  >"$TMP/circuit/.git/harness-runs/boom.json"
printf '%s\n' '{"crashCounts":{"flaky":5}}' >"$TMP/circuit/.git/harness-control/state.json"
supervisor_common_run_once --repo "$TMP/circuit" --host claude --once true --poll-ms 50 \
  --max-workers 2 --quota-workers 2 --cpu-per-worker 0.25 \
  --memory-per-worker-mb 128 --reserve-memory-mb 0 --max-load-ratio 100
CIRCUIT_EVENTS="$TMP/circuit/.git/harness-control/events.jsonl"
jq -e '.crashCounts.flaky == 5' "$TMP/circuit/.git/harness-control/state.json" >/dev/null
if jq -s -e 'any(.[]; .context == "flaky")' "$CIRCUIT_EVENTS" >/dev/null 2>&1; then
  echo 'not ok - a context already at the crash bound was still dispatched/raised an event instead of being skipped' >&2; exit 1
fi
echo 'ok - a context already at the crash-count bound is never auto-recovered again on a single tick'

echo 'ok - supervisor fast tests passed'
