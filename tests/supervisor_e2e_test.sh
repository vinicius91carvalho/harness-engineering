#!/usr/bin/env bash
# Slow supervisor end-to-end smoke: full pipeline runs and detached lifecycle.
set -euo pipefail
# shellcheck source=tests/supervisor_common.sh
source "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/supervisor_common.sh"
supervisor_common_init

mkdir -p "$TMP/repo"
supervisor_common_init_git_repo "$TMP/repo" false

supervisor_common_run_once \
  --repo "$TMP/repo" --host claude --poll-ms 50 \
  --max-workers 2 --quota-workers 1 --cpu-per-worker 0.25 \
  --memory-per-worker-mb 128 --reserve-memory-mb 0 --max-load-ratio 100

STATE="$TMP/repo/.git/harness-control/state.json"
EVENTS="$TMP/repo/.git/harness-control/events.jsonl"
jq -e '.status == "complete" and .supervisorPid == null and .progress.integrated == 1' "$STATE" >/dev/null || { cat "$STATE"; exit 1; }
jq -s -e 'any(.[]; .kind == "progress") and any(.[]; .kind == "goal_review_started") and any(.[]; .kind == "run_completed" and .immediate)' "$EVENTS" >/dev/null
echo 'ok - supervisor claims, builds, verifies, releases, and runs governed Goal Review'

mkdir -p "$TMP/monorepo/app"
cp "$TMP/repo/project_specs.xml" "$TMP/monorepo/app/project_specs.xml"
supervisor_common_write_feature_queue "$TMP/monorepo/app/feature_list.json" false
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
supervisor_common_run_once \
  --repo "$TMP/monorepo/app" --host claude --poll-ms 100 --quota-workers 1 \
  --memory-per-worker-mb 128 --reserve-memory-mb 0 --max-load-ratio 100
jq -e '.status == "complete" and .phase == "complete"' \
  "$TMP/monorepo/.git/harness-runs/app--goal-review.json" >/dev/null
jq -e '.status == "complete"' "$TMP/monorepo/.git/harness-control/app/state.json" >/dev/null
echo 'ok - nested projects recover and complete project-namespaced Run State'
test -f "$TMP/monorepo/unrelated.txt"

git clone -q "$TMP/repo" "$TMP/detached"
git -C "$TMP/detached" config user.name test
git -C "$TMP/detached" config user.email test@example.invalid
supervisor_common_write_feature_queue "$TMP/detached/feature_list.json" false
git -C "$TMP/detached" add feature_list.json && git -C "$TMP/detached" commit -qm reset
PATH="$SUPERVISOR_PATH" HARNESS_TEST_GOAL_SLEEP=1 "$NODE" "$CONTROL" start \
  --repo "$TMP/detached" --host claude --poll-ms 100 --quota-workers 1 \
  --memory-per-worker-mb 128 --reserve-memory-mb 0 --max-load-ratio 100 | jq -e '.started == true' >/dev/null
if PATH="$SUPERVISOR_PATH" "$NODE" "$CONTROL" start --repo "$TMP/detached" --host claude >/dev/null 2>&1; then
  echo 'not ok - a second live supervisor acquired the same repository' >&2; exit 1
fi
for _ in $(seq 1 150); do
  [ "$("$NODE" "$CONTROL" status --repo "$TMP/detached" | jq -r 'select(.status == "complete" and .supervisorPid == null) | "ready"')" = ready ] && break
  sleep 0.1
done
"$NODE" "$CONTROL" status --repo "$TMP/detached" | jq -e '.status == "complete" and .supervisorPid == null' >/dev/null \
  || { echo 'not ok - detached supervisor did not finish within 15s' >&2; "$NODE" "$CONTROL" status --repo "$TMP/detached" >&2; exit 1; }
echo 'ok - detached start is singleton/recoverable and finishes in the background'

mkdir -p "$TMP/crash-msg"
supervisor_common_init_git_repo "$TMP/crash-msg" false
mkdir -p "$TMP/crash-msg/.git/harness-control" "$TMP/crash-msg/.git/harness-runs"
printf '%s\n' '{"boom":{"context":"boom","status":"building","worktree":"'"$TMP"'/crash-msg","branch":"gen/boom","port":9,"featureIds":[]}}' \
  >"$TMP/crash-msg/.git/generator-claims.json"
printf '%s\n' '{"status":"resuming","ownerPid":999999999,"childPid":null}' \
  >"$TMP/crash-msg/.git/harness-runs/boom.json"
CRASH_EVENTS="$TMP/crash-msg/.git/harness-control/events.jsonl"
PATH="$SUPERVISOR_PATH" "$NODE" "$CONTROL" run \
  --repo "$TMP/crash-msg" --host claude --poll-ms 100 \
  --max-workers 1 --quota-workers 1 --cpu-per-worker 0.25 \
  --memory-per-worker-mb 128 --reserve-memory-mb 0 --max-load-ratio 100 &
crash_pid=$!
found=
for _ in $(seq 1 100); do
  if [ -f "$CRASH_EVENTS" ] && jq -s -e 'any(.[]; .kind == "input_required" and .context == "boom")' "$CRASH_EVENTS" >/dev/null 2>&1; then
    found=1
    break
  fi
  sleep 0.2
done
kill "$crash_pid" 2>/dev/null || true
wait "$crash_pid" 2>/dev/null || true
if [ -z "$found" ]; then
  echo 'not ok - worker crash surfacing test did not finish' >&2; exit 1
fi
jq -s -e 'any(.[]; .kind == "input_required" and .context == "boom" and (.reason | contains("--features is required")))' "$CRASH_EVENTS" >/dev/null \
  || { echo 'not ok - a worker crash reason did not surface the actual error from its log (still just "Worker exited with code N")' >&2; cat "$CRASH_EVENTS" >&2; exit 1; }
echo 'ok - a worker crash surfaces its real log-level error in the Input Request reason, not just an exit code'

echo 'ok - supervisor e2e tests passed'
