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
rm -f "$TMP/quota-limit/.git/harness-control/state.json" "$TMP/quota-limit/.git/harness-control/events.jsonl"
PATH="$SUPERVISOR_PATH" HARNESS_TEST_SUPERVISOR_QUOTA=1 HARNESS_RATE_LIMIT_BACKOFF_MS=100 HARNESS_RATE_LIMIT_JITTER_MS=0 \
  "$NODE" "$CONTROL" run \
  --repo "$TMP/quota-limit" --host claude --poll-ms 50 --quota-cooldown-seconds 60 \
  --memory-per-worker-mb 1 --reserve-memory-mb 0 --max-load-ratio 100 >"$TMP/quota-supervisor.log" 2>&1 &
quota_supervisor=$!
# macOS CI cold-starts can exceed 20s before the first claim/spawn; keep polling until
# quota_wait lands (jq -se fails on false, so we do not treat "not yet" as success).
deadline=$(( $(date +%s) + 60 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ -f "$TMP/quota-limit/.git/harness-control/events.jsonl" ] \
    && jq -se 'any(.[]; .kind == "quota_wait")' "$TMP/quota-limit/.git/harness-control/events.jsonl" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
kill "$quota_supervisor" 2>/dev/null || true
wait "$quota_supervisor" 2>/dev/null || true
if ! jq -s -e 'any(.[]; .kind == "quota_wait") and all(.[]; .kind != "input_required")' \
  "$TMP/quota-limit/.git/harness-control/events.jsonl" >/dev/null \
  || ! jq -e '.retryQueue.core.guidance | contains("Provider quota")' \
  "$TMP/quota-limit/.git/harness-control/state.json" >/dev/null; then
  echo 'not ok - provider usage limits did not pause quota' >&2
  echo '--- events ---' >&2
  cat "$TMP/quota-limit/.git/harness-control/events.jsonl" 2>/dev/null >&2 || true
  echo '--- state ---' >&2
  cat "$TMP/quota-limit/.git/harness-control/state.json" 2>/dev/null >&2 || true
  echo '--- supervisor log ---' >&2
  cat "$TMP/quota-supervisor.log" 2>/dev/null >&2 || true
  exit 1
fi
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
PATH="$SUPERVISOR_PATH" supervisor_common_run_once --repo "$TMP/invalid" --host claude --poll-ms 50 --max-load-ratio 100
"$NODE" "$CONTROL" status --repo "$TMP/invalid" | jq -e '.status == "paused" and .supervisorPid == null' >/dev/null
"$NODE" "$CONTROL" start --repo "$TMP/invalid" --host claude | jq -e '.started == false and .status == "paused"' >/dev/null
echo 'ok - invalid planning emits a durable goal Input Request and consumes its idempotent response after restart'

mkdir -p "$TMP/retry"
supervisor_common_init_git_repo "$TMP/retry" false
mkdir -p "$TMP/retry/.git/harness-control"
printf '%s\n' '{"retryQueue":{"ghost":{"guidance":"","attempts":4}}}' >"$TMP/retry/.git/harness-control/state.json"
supervisor_common_run_once --repo "$TMP/retry" --host claude --once true --poll-ms 50 \
  --max-workers 2 --quota-workers 2 --cpu-per-worker 0.25 \
  --memory-per-worker-mb 1 --reserve-memory-mb 0 --max-load-ratio 100
RETRY_STATE="$TMP/retry/.git/harness-control/state.json"
RETRY_EVENTS="$TMP/retry/.git/harness-control/events.jsonl"
if ! jq -e '.retryQueue == {}' "$RETRY_STATE" >/dev/null \
  || ! jq -s -e 'any(.[]; .kind == "input_required" and .context == "ghost" and .reason == "Retry could not resume the Claim Lease")' "$RETRY_EVENTS" >/dev/null; then
  echo 'not ok - exhausted retry did not raise Claim Lease Input Request' >&2
  echo '--- state ---' >&2
  cat "$RETRY_STATE" >&2 || true
  echo '--- events ---' >&2
  cat "$RETRY_EVENTS" >&2 || true
  exit 1
fi
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
  --memory-per-worker-mb 1 --reserve-memory-mb 0 --max-load-ratio 100
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
  --memory-per-worker-mb 1 --reserve-memory-mb 0 --max-load-ratio 100
jq -e '.progress.blocked == 0' "$TMP/mono2/.git/harness-control/appA/state.json" >/dev/null \
  || { cat "$TMP/mono2/.git/harness-control/appA/state.json"; echo 'not ok - sibling subproject appB'"'"'s blocked claim leaked into appA'"'"'s own blocked count' >&2; exit 1; }
if jq -s -e 'any(.[]; .context == "ghost")' "$TMP/mono2/.git/harness-control/appA/events.jsonl" >/dev/null 2>&1; then
  echo 'not ok - appA raised a ghost input_required event for sibling appB'"'"'s context' >&2; exit 1
fi
echo 'ok - a subproject'"'"'s status/claims inspection never sees a sibling subproject'"'"'s claims in a shared monorepo .git'

mkdir -p "$TMP/installed/skills/harness-supervisor/scripts" "$TMP/installed/skills/harness-supervisor/lib"
cp "$CONTROL" "$TMP/installed/skills/harness-supervisor/scripts/harness-control.mjs"
cp "$ROOT/skills/supervisor/lib/herdr-spawn.mjs" "$TMP/installed/skills/harness-supervisor/lib/herdr-spawn.mjs"
cp "$ROOT/skills/supervisor/lib/supervisor-preflight.mjs" "$TMP/installed/skills/harness-supervisor/lib/supervisor-preflight.mjs"
cp -R "$ROOT/skills/generator" "$TMP/installed/skills/harness-generator"
git clone -q "$TMP/repo" "$TMP/namespaced"
git -C "$TMP/namespaced" config user.name test
git -C "$TMP/namespaced" config user.email test@example.invalid
mkdir -p "$TMP/namespaced/.git/harness-control" "$TMP/namespaced/.git/harness-runs"
cp "$TMP/repo/.git/harness-control/state.json" "$TMP/namespaced/.git/harness-control/"
cp "$TMP/repo/.git/harness-control/events.jsonl" "$TMP/namespaced/.git/harness-control/"
cp "$TMP/repo/.git/harness-runs/goal-review.json" "$TMP/namespaced/.git/harness-runs/"
PATH="$SUPERVISOR_PATH" "$NODE" \
  "$TMP/installed/skills/harness-supervisor/scripts/harness-control.mjs" start \
  --repo "$TMP/namespaced" --host claude \
  | jq -e '.started == false and .status == "complete"' >/dev/null \
  || {
    echo 'not ok - namespaced supervisor failed to resolve generator sibling / complete state' >&2
    "$NODE" "$TMP/installed/skills/harness-supervisor/scripts/harness-control.mjs" status --repo "$TMP/namespaced" >&2 || true
    cat "$TMP/namespaced/.git/harness-control/state.json" >&2 || true
    exit 1
  }
echo 'ok - OpenCode namespaced supervisor resolves its generator sibling'

git clone -q "$TMP/repo" "$TMP/background"
git -C "$TMP/background" config user.name test
git -C "$TMP/background" config user.email test@example.invalid
supervisor_common_write_feature_queue "$TMP/background/feature_list.json" false
git -C "$TMP/background" add feature_list.json && git -C "$TMP/background" commit -qm reset
PATH="$SUPERVISOR_PATH" HERDR_ENV=1 supervisor_common_run_once \
  --repo "$TMP/background" --host claude --poll-ms 50 --display background \
  --quota-workers 1 --memory-per-worker-mb 1 --reserve-memory-mb 0 --max-load-ratio 100
jq -e '.status == "complete"' "$TMP/background/.git/harness-control/state.json" >/dev/null
echo 'ok - explicit --display background always forces background workers, even when HERDR_ENV=1'

mkdir -p "$TMP/herdr-bin"
cp "$ROOT/tests/fixtures/herdr-mock.sh" "$TMP/herdr-bin/herdr"
cp "$ROOT/tests/fixtures/herdr-mock-helper.mjs" "$TMP/herdr-mock-helper.mjs"
chmod +x "$TMP/herdr-bin/herdr"
printf '%s\n' '{"tabs":[{"tab_id":"1-1","label":"1","pane_count":1,"workspace_id":"1","number":1}],"panes":[{"pane_id":"1-1","tab_id":"1-1","workspace_id":"1","focused":true,"agent_status":"unknown"}],"seq":0}' \
  >"$TMP/herdr-state.json"
HERDR_ENV=1 PATH="$TMP/herdr-bin:$SUPERVISOR_PATH" \
  HARNESS_TEST_HERDR_STATE="$TMP/herdr-state.json" \
  HARNESS_TEST_HERDR_HELPER="$TMP/herdr-mock-helper.mjs" \
  HARNESS_TEST_HERDR_LOG="$TMP/herdr.log" \
  "$NODE" -e "
import('$ROOT/skills/supervisor/lib/herdr-spawn.mjs').then(({ resolveDisplayMode }) => {
  if (resolveDisplayMode({}) !== 'herdr') throw new Error('HERDR_ENV=1 with herdr on PATH should auto-select herdr')
  if (resolveDisplayMode({ display: 'background' }) !== 'background') throw new Error('--display background must still override auto herdr')
}).catch((error) => { console.error(String(error)); process.exit(1) })
"
echo 'ok - HERDR_ENV=1 with herdr on PATH auto-selects herdr panes, and --display background still overrides it'

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
supervisor_common_run_timeout 15 env PATH="$SUPERVISOR_PATH" "$NODE" "$CONTROL" run \
  --repo "$TMP/circuit" --host claude --once true --poll-ms 50 \
  --max-workers 2 --quota-workers 2 --cpu-per-worker 0.25 \
  --memory-per-worker-mb 1 --reserve-memory-mb 0 --max-load-ratio 100
CIRCUIT_EVENTS="$TMP/circuit/.git/harness-control/events.jsonl"
jq -e '.crashCounts.flaky == 5' "$TMP/circuit/.git/harness-control/state.json" >/dev/null
if jq -s -e 'any(.[]; .context == "flaky")' "$CIRCUIT_EVENTS" >/dev/null 2>&1; then
  echo 'not ok - a context already at the crash bound was still dispatched/raised an event instead of being skipped' >&2; exit 1
fi
echo 'ok - a context already at the crash-count bound is never auto-recovered again on a single tick'

mkdir -p "$TMP/fleet"
supervisor_common_init_git_repo "$TMP/fleet" false
mkdir -p "$TMP/fleet/.git/harness-control"
printf '%s\n' '{"supervisorPid":999999999,"supervisorHost":"'"$(hostname)"'","workers":{}}' \
  >"$TMP/fleet/.git/harness-control/state.json"
"$NODE" "$CONTROL" release-supervisor-lock --repo "$TMP/fleet" | jq -e '.cleared == false and .reason == "absent"' >/dev/null
"$NODE" "$CONTROL" clear-dead-lock --repo "$TMP/fleet" --lock merge | jq -e '.cleared == false' >/dev/null
echo 'ok - guarded fleet recovery commands authorize when supervisor is not live'

mkdir -p "$TMP/emptyfleet"
supervisor_common_init_git_repo "$TMP/emptyfleet" false
mkdir -p "$TMP/emptyfleet/.git/harness-control" \
  "$TMP/emptyfleet/.git/harness-runs" \
  "$TMP/emptyfleet/.git/harness-locks/generator-merge"
printf '%s\n' '{"stuckctx":{"context":"stuckctx","status":"building","worktree":"'"$TMP"'/emptyfleet","branch":"gen/stuckctx","port":9,"featureIds":[]}}' \
  >"$TMP/emptyfleet/.git/generator-claims.json"
printf '%s\n' '{"status":"failed","ownerPid":999999999,"childPid":null}' \
  >"$TMP/emptyfleet/.git/harness-runs/stuckctx.json"
printf '%s\n' '999999999' >"$TMP/emptyfleet/.git/harness-locks/generator-merge/owner"
hostname >"$TMP/emptyfleet/.git/harness-locks/generator-merge/host"
printf '%s\n' '{
  "status":"running",
  "supervisorPid":null,
  "workers":{},
  "crashCounts":{"stuckctx":5},
  "retryQueue":{},
  "pendingInputs":{
    "42":{
      "id":42,
      "status":"pending",
      "scope":"context",
      "context":"stuckctx",
      "kind":"input_required",
      "immediate":true,
      "reason":"Worker exited with code 1",
      "choices":["retry","pause","abort"]
    }
  }
}' >"$TMP/emptyfleet/.git/harness-control/state.json"
supervisor_common_run_timeout 20 env PATH="$SUPERVISOR_PATH" "$NODE" "$CONTROL" run \
  --repo "$TMP/emptyfleet" --host claude --once true --poll-ms 50 \
  --max-workers 2 --quota-workers 2 --cpu-per-worker 0.25 \
  --memory-per-worker-mb 1 --reserve-memory-mb 0 --max-load-ratio 100
test ! -f "$TMP/emptyfleet/.git/harness-locks/generator-merge/owner"
jq -e '(.crashCounts.stuckctx // 0) != 5 or (.crashCounts|length==0) or (.retryQueue.stuckctx != null) or (.pendingInputs["42"].status == "responded")' \
  "$TMP/emptyfleet/.git/harness-control/state.json" >/dev/null
echo 'ok - empty fleet tick clears dead merge lock and recovers past crash-bound'

# --- preflight: ghost run + dead claim + stale capacity ---
git clone -q "$TMP/repo" "$TMP/preflight"
git -C "$TMP/preflight" config user.name test
git -C "$TMP/preflight" config user.email test@example.invalid
supervisor_common_write_feature_queue "$TMP/preflight/feature_list.json" false
git -C "$TMP/preflight" add feature_list.json && git -C "$TMP/preflight" commit -qm 'queue'
COMMON_GIT="$(git -C "$TMP/preflight" rev-parse --git-common-dir)"
COMMON_GIT="$(cd "$TMP/preflight" && cd "$COMMON_GIT" && pwd)"
mkdir -p "$COMMON_GIT/harness-runs" "$COMMON_GIT/harness-control" "$COMMON_GIT/harness-governor"
# claim with dead session (building)
printf '%s\n' '{
  "foundation": {
    "project": "root",
    "context": "foundation",
    "session": "99999999",
    "status": "building",
    "worktree": "'"$TMP"'/preflight-wt-foundation",
    "branch": "gen/foundation"
  }
}' >"$COMMON_GIT/generator-claims.json"
printf '%s\n' '{
  "context": "foundation",
  "status": "running",
  "phase": "coding",
  "ownerPid": 99999999,
  "childPid": 99999998,
  "worktree": "'"$TMP"'/preflight-wt-foundation"
}' >"$COMMON_GIT/harness-runs/foundation.json"
printf '%s\n' '{
  "status": "stopped",
  "supervisorPid": null,
  "capacity": {"available": 0, "stale": true},
  "workerHealth": {"foundation": {"verdict": "healthy", "childPid": 99999998}},
  "workers": {},
  "retryQueue": {},
  "mergeLock": {"owner": "99999999", "host": "test-host", "holderAlive": true}
}' >"$COMMON_GIT/harness-control/state.json"
# Stale journal.lock from a dead writer must be cleared by preflight
printf '%s\n' '99999999.dead-journal-lock' >"$COMMON_GIT/harness-control/journal.lock"
printf '%s\n' '{
  "version": 1,
  "reservations": {
    "dead-slot": {
      "id": "dead-slot",
      "projectId": "root",
      "context": "foundation",
      "pid": 99999999,
      "at": "2020-01-01T00:00:00.000Z"
    }
  },
  "providers": {},
  "updatedAt": "2020-01-01T00:00:00.000Z"
}' >"$COMMON_GIT/harness-governor/reservations.json"
mkdir -p "$TMP/preflight-wt-foundation"
"$NODE" "$CONTROL" preflight --repo "$TMP/preflight" --repair true >/tmp/harness-preflight-out.json
jq -e '.ok == true and .reconcileOk == true' /tmp/harness-preflight-out.json >/dev/null
jq -e '.status == "abandoned"' "$COMMON_GIT/harness-runs/foundation.json" >/dev/null
jq -e '.reservations == {} or (.reservations|length==0)' "$COMMON_GIT/harness-governor/reservations.json" >/dev/null
jq -e '.capacity == null and (.workerHealth.foundation|not) and (.mergeLock == null)' "$COMMON_GIT/harness-control/state.json" >/dev/null
test ! -f "$COMMON_GIT/harness-control/journal.lock"
jq -e '[.actions[].kind] | index("journal_lock_cleared") != null' /tmp/harness-preflight-out.json >/dev/null
# dead claim should be cleared (foundation key gone)
if [ -f "$COMMON_GIT/generator-claims.json" ]; then
  jq -e '.foundation|not' "$COMMON_GIT/generator-claims.json" >/dev/null
fi
echo 'ok - preflight abandons ghost runs, prunes governor, clears stale health, clears dead claims, clears dead journal.lock'

echo 'ok - supervisor fast tests passed'
