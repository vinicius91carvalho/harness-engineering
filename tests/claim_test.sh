#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP=${TMPDIR:-/tmp}/harness-claim-test.$$
trap 'jobs -p | xargs -r kill 2>/dev/null || true; rm -rf "$TMP"' EXIT
mkdir -p "$TMP/repo"
git -C "$TMP/repo" init -b main -q
git -C "$TMP/repo" config user.name test
git -C "$TMP/repo" config user.email test@example.invalid
cat >"$TMP/repo/feature_list.json" <<'JSON'
[
  {"id":"A","context":"alpha","acceptance_checks":["AC-A"],"depends_on":[],"implementation":false,"qa":false,"integration":false},
  {"id":"B","context":"beta","acceptance_checks":["AC-B"],"depends_on":[],"implementation":false,"qa":false,"integration":false}
]
JSON
git -C "$TMP/repo" add feature_list.json
git -C "$TMP/repo" commit -qm init

bash "$ROOT/skills/generator/claim.sh" select-claim "$TMP/repo" all '' 1001 >"$TMP/one.json" & p1=$!
bash "$ROOT/skills/generator/claim.sh" select-claim "$TMP/repo" all '' 1002 >"$TMP/two.json" & p2=$!
wait "$p1"; wait "$p2"
jq -s -e 'length == 2 and (map(.context) | unique | length) == 2 and (map(.port) | unique | length) == 2' "$TMP/one.json" "$TMP/two.json" >/dev/null
bash "$ROOT/skills/generator/claim.sh" list "$TMP/repo" >"$TMP/list.txt"
grep -Eq 'tasks=(A|B)' "$TMP/list.txt"
test -z "$(bash "$ROOT/skills/generator/claim.sh" select-claim "$TMP/repo" task A 1003)"
test ! -d "$TMP/repo/.git/harness-locks/generator-state"
echo 'ok - atomic Claim Leases assign distinct contexts and ports'

mkdir -p "$TMP/dag"
git -C "$TMP/dag" init -b main -q
git -C "$TMP/dag" config user.name test
git -C "$TMP/dag" config user.email test@example.invalid
cat >"$TMP/dag/feature_list.json" <<'JSON'
[
  {"id":"F","context":"bootstrap","acceptance_checks":["AC-F"],"depends_on":[],"implementation":false,"qa":false,"integration":false},
  {"id":"P","context":"product","acceptance_checks":["AC-P"],"depends_on":["AC-F"],"implementation":false,"qa":false,"integration":false}
]
JSON
git -C "$TMP/dag" add feature_list.json
git -C "$TMP/dag" commit -qm init
bash "$ROOT/skills/generator/claim.sh" select-claim "$TMP/dag" all '' 2001 >"$TMP/prerequisite.json"
jq -e '.context == "bootstrap" and .featureIds == ["F"]' "$TMP/prerequisite.json" >/dev/null
bash "$ROOT/skills/generator/claim.sh" release "$TMP/dag" bootstrap >/dev/null
jq 'map(if .id=="F" then .implementation=true | .qa=true | .integration=true else . end)' "$TMP/dag/feature_list.json" >"$TMP/dag/feature_list.tmp"
mv "$TMP/dag/feature_list.tmp" "$TMP/dag/feature_list.json"
git -C "$TMP/dag" add feature_list.json
git -C "$TMP/dag" commit -qm prerequisite-passed
bash "$ROOT/skills/generator/claim.sh" select-claim "$TMP/dag" all '' 2002 >"$TMP/dependent.json"
jq -e '.context == "product" and .featureIds == ["P"]' "$TMP/dependent.json" >/dev/null
echo 'ok - only dependency-ready Work Items can be claimed'

CTX=$(jq -r .context "$TMP/dependent.json")
WT=$(jq -r .worktree "$TMP/dependent.json")
mkdir -p "$TMP/dag/.git/harness-runs"
sleep 30 & sleeper=$!
HOST=$(hostname)
cat >"$TMP/dag/.git/harness-runs/$CTX.json" <<JSON
{"ownerHost":"$HOST","ownerPid":$sleeper,"childPid":null,"heartbeatEpoch":$(date +%s),"phase":"coding","attempt":1,"nextAction":"coding"}
JSON
test -z "$(bash "$ROOT/skills/generator/claim.sh" resume "$TMP/dag" "$CTX" 3001 auto 2>"$TMP/live.err")"
grep -q LIVE "$TMP/live.err"
kill "$sleeper"; wait "$sleeper" 2>/dev/null || true
bash "$ROOT/skills/generator/claim.sh" resume "$TMP/dag" "$CTX" 3002 auto >"$TMP/resumed.json"
jq -e '.resumed == true and .context == "product" and .worktree == $wt' --arg wt "$WT" "$TMP/resumed.json" >/dev/null
jq -e '.status == "resuming" and .previousPhase == "coding" and .nextAction == "coding"' "$TMP/dag/.git/harness-runs/$CTX.json" >/dev/null
echo 'ok - live work is protected and dead local work resumes atomically'

bash "$ROOT/skills/generator/claim.sh" block "$TMP/dag" "$CTX" >/dev/null
test -d "$WT"
test -z "$(bash "$ROOT/skills/generator/claim.sh" resume "$TMP/dag" "$CTX" 3003 auto 2>"$TMP/blocked.err")"
grep -q BLOCKED "$TMP/blocked.err"
bash "$ROOT/skills/generator/claim.sh" resume "$TMP/dag" "$CTX" 3004 force >"$TMP/explicit.json"
jq -e '.resumed == true' "$TMP/explicit.json" >/dev/null
test -d "$WT"
echo 'ok - blocked worktrees are preserved and require explicit Resume'
