#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP=${TMPDIR:-/tmp}/harness-orchestrator-test.$$
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/repo"

git -C "$TMP/repo" init -b main -q
git -C "$TMP/repo" config user.name test
git -C "$TMP/repo" config user.email test@example.invalid
cat >"$TMP/repo/project_specs.xml" <<'XML'
<project_specification>
  <project_goal>A real boundary returns ready.</project_goal>
  <acceptance_checks>
    <acceptance_check id="AC-001" context="core" category="functional" depends_on="">
      <description>The health boundary returns ready.</description>
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
printf '%s' "$prompt" | grep -q "$PWD/project_specs.xml"
printf '%s' "$prompt" | grep -q 'verify that the repository contains every structure and file it requires'
if printf '%s' "$prompt" | grep -q '<injected_project_specs>'; then exit 1; fi
tmp="$PWD/feature_list.json.tmp"
commit() { git add feature_list.json; git commit -qm "$1"; }
case "$prompt" in
  *"orchestrator repair planner"*)
    printf '%s\n' '{"summary":"fix the health response","rootCause":"wrong response","actions":["return ready"],"validation":["request health"]}'
    ;;
  *"Integrated Verification"*)
    jq 'map(if .id=="WI-AC-001" then .integration=true else . end)' feature_list.json >"$tmp" && mv "$tmp" feature_list.json
    commit integration
    printf '%s\n' '{"id":"WI-AC-001","integration":true,"implementation":true,"defects":[]}'
    ;;
  *"independent Goal Review agent"*)
    if [ "${HARNESS_TEST_GOAL_FAIL:-}" = 1 ]; then
      printf '%s\n' '{"goal":false,"summary":"cross-feature defect","acceptanceCheckIds":["AC-001"],"defects":["expected goal; observed regression; evidence journey"]}'
    else
      printf '%s\n' '{"goal":true,"summary":"goal observed","acceptanceCheckIds":["AC-001"],"defects":[]}'
    fi
    ;;
  *"coding-agent"*)
    code_count=0; [ ! -f "$HARNESS_TEST_CODE_COUNT" ] || code_count=$(cat "$HARNESS_TEST_CODE_COUNT")
    code_count=$((code_count + 1)); printf '%s' "$code_count" >"$HARNESS_TEST_CODE_COUNT"
    if [ "$code_count" -eq 2 ]; then printf '%s' "$prompt" | grep -q 'fix the health response'; fi
    jq 'map(if .id=="WI-AC-001" then .implementation=true else . end)' feature_list.json >"$tmp" && mv "$tmp" feature_list.json
    commit coding
    printf '%s\n' '{"id":"WI-AC-001","implementation":true,"notes":"implemented"}'
    ;;
  *"qa-agent"*)
    count=0; [ ! -f "$HARNESS_TEST_QA_COUNT" ] || count=$(cat "$HARNESS_TEST_QA_COUNT")
    count=$((count + 1)); printf '%s' "$count" >"$HARNESS_TEST_QA_COUNT"
    if [ "${HARNESS_TEST_ALWAYS_FAIL:-}" = 1 ] || [ "$count" -eq 1 ]; then
      jq 'map(if .id=="WI-AC-001" then .implementation=false | .qa=false else . end)' feature_list.json >"$tmp" && mv "$tmp" feature_list.json
      commit qa-defect
      printf '%s\n' '{"id":"WI-AC-001","qa":false,"implementation":false,"defects":["expected ready; observed down; evidence response"]}'
    else
      jq 'map(if .id=="WI-AC-001" then .qa=true else . end)' feature_list.json >"$tmp" && mv "$tmp" feature_list.json
      commit qa-pass
      printf '%s\n' '{"id":"WI-AC-001","qa":true,"implementation":true,"defects":[]}'
    fi
    ;;
esac
SH
chmod +x "$TMP/bin/claude"

bash "$ROOT/skills/generator/claim.sh" select-claim "$TMP/repo" all '' 1001 >"$TMP/claim.json"
WORKTREE=$(jq -r .worktree "$TMP/claim.json")
PORT=$(jq -r .port "$TMP/claim.json")
NODE=$(command -v node)
PATH="$TMP/bin:$(dirname "$NODE"):/usr/bin:/bin" HARNESS_TEST_QA_COUNT="$TMP/qa-count" HARNESS_TEST_CODE_COUNT="$TMP/code-count" \
  "$NODE" "$ROOT/skills/generator/orchestrator.mjs" --host claude --repo "$TMP/repo" \
  --workdir "$WORKTREE" --context core --port "$PORT" --features WI-AC-001 \
  --claim-script "$ROOT/skills/generator/claim.sh" >"$TMP/result.json"

jq -e '.passed == 1 and (.stuck | length) == 0' "$TMP/result.json" >/dev/null
jq -e '.[0].implementation and .[0].qa and .[0].integration and .[0].retries == 1' "$TMP/repo/feature_list.json" >/dev/null
grep -q 'Repair Plan' "$WORKTREE/harness-progress/core.md"
grep -q 'expected ready; observed down' "$WORKTREE/harness-progress/core.md"
STATE="$TMP/repo/.git/harness-runs/core.json"
jq -e '.status == "complete" and .nextAction == "release-claim" and .ownerPid == null' "$STATE" >/dev/null
echo 'ok - QA defects produce a persisted Repair Plan used by the next Attempt'
echo 'ok - each passed Work Item merges and passes Integrated Verification on main'
echo 'ok - Run State records resumable phase, result, and next action'
echo 'ok - every workflow agent receives the spec reference and verifies the generated structure'

bash "$ROOT/skills/generator/claim.sh" release "$TMP/repo" core >/dev/null
ln -s "$TMP/repo" "$TMP/main-alias"
PATH="$TMP/bin:$(dirname "$NODE"):/usr/bin:/bin" HARNESS_TEST_QA_COUNT="$TMP/qa-count" HARNESS_TEST_CODE_COUNT="$TMP/code-count" \
  "$NODE" "$ROOT/skills/generator/orchestrator.mjs" --host claude --repo "$TMP/repo" \
  --workdir "$TMP/main-alias" --mode goal-review --context goal-review --port 5170 \
  --claim-script "$ROOT/skills/generator/claim.sh" >"$TMP/goal.json"
jq -e '.goal == true and .summary == "goal observed"' "$TMP/goal.json" >/dev/null
grep -q 'Goal Review passed' "$TMP/repo/harness-progress/goal-review.md"
echo 'ok - mandatory Goal Review evaluates integrated main independently of queue exhaustion'
echo 'ok - Goal Review canonicalizes logical checkout paths before referencing the specification'

PATH="$TMP/bin:$(dirname "$NODE"):/usr/bin:/bin" HARNESS_TEST_QA_COUNT="$TMP/qa-count" HARNESS_TEST_CODE_COUNT="$TMP/code-count" \
  "$NODE" "$ROOT/skills/generator/orchestrator.mjs" --host claude --repo "$TMP/repo" \
  --workdir "$TMP/repo" --mode goal-review --context goal-review --port 5170 \
  --claim-script "$ROOT/skills/generator/claim.sh" >"$TMP/goal-reused.json"
jq -e '.goal == true and .reused == true' "$TMP/goal-reused.json" >/dev/null
echo 'ok - parallel idle sessions reuse Goal Review for the same main commit'

git -C "$TMP/repo" commit --allow-empty -qm 'test: change reviewed head'
PATH="$TMP/bin:$(dirname "$NODE"):/usr/bin:/bin" HARNESS_TEST_QA_COUNT="$TMP/qa-count" HARNESS_TEST_CODE_COUNT="$TMP/code-count" HARNESS_TEST_GOAL_FAIL=1 \
  "$NODE" "$ROOT/skills/generator/orchestrator.mjs" --host claude --repo "$TMP/repo" \
  --workdir "$TMP/repo" --mode goal-review --context goal-review --port 5170 \
  --claim-script "$ROOT/skills/generator/claim.sh" >"$TMP/goal-defect.json"
jq -e '.goal == false and .reopened == ["WI-AC-001"]' "$TMP/goal-defect.json" >/dev/null
jq -e '.[0].implementation == false and .[0].qa == false and .[0].integration == false and .[0].retries == 2' "$TMP/repo/feature_list.json" >/dev/null
echo 'ok - Goal Review defects reopen linked Work Items within the Attempt budget'

mkdir -p "$TMP/blocked"
git -C "$TMP/blocked" init -b main -q
git -C "$TMP/blocked" config user.name test
git -C "$TMP/blocked" config user.email test@example.invalid
cp "$TMP/repo/project_specs.xml" "$TMP/blocked/project_specs.xml"
cat >"$TMP/blocked/feature_list.json" <<'JSON'
[{"id":"WI-AC-001","context":"core","description":"health works","steps":["verify health"],"acceptance_checks":["AC-001"],"depends_on":[],"implementation":false,"qa":false,"integration":false,"retries":0}]
JSON
git -C "$TMP/blocked" add . && git -C "$TMP/blocked" commit -qm init
bash "$ROOT/skills/generator/claim.sh" select-claim "$TMP/blocked" all '' 4001 >"$TMP/blocked-claim.json"
BLOCKED_WT=$(jq -r .worktree "$TMP/blocked-claim.json")
PATH="$TMP/bin:$(dirname "$NODE"):/usr/bin:/bin" HARNESS_TEST_QA_COUNT="$TMP/blocked-qa-count" HARNESS_TEST_CODE_COUNT="$TMP/blocked-code-count" HARNESS_TEST_ALWAYS_FAIL=1 \
  "$NODE" "$ROOT/skills/generator/orchestrator.mjs" --host claude --repo "$TMP/blocked" \
  --workdir "$BLOCKED_WT" --context core --port 5170 --features WI-AC-001 \
  --claim-script "$ROOT/skills/generator/claim.sh" >"$TMP/blocked-result.json"
jq -e '.stuck[0].status == "blocked" and .stuck[0].reason == "QA failed after Attempt 3"' "$TMP/blocked-result.json" >/dev/null
test "$(cat "$TMP/blocked-qa-count")" -eq 3
jq -e '.core.status == "blocked"' "$TMP/blocked/.git/generator-claims.json" >/dev/null
jq -e '.status == "blocked" and .attempt == 3 and .nextAction == "user-guidance"' "$TMP/blocked/.git/harness-runs/core.json" >/dev/null
test -d "$BLOCKED_WT"
test "$(grep -c 'QA defect and Repair Plan' "$BLOCKED_WT/harness-progress/core.md")" -eq 2
grep -q 'Blocked Work Item' "$BLOCKED_WT/harness-progress/core.md"
echo 'ok - Attempt 3 blocks with feedback while preserving branch, worktree, state, and journal'

bash "$ROOT/skills/generator/claim.sh" resume "$TMP/blocked" core 4002 force >"$TMP/blocked-resume.json"
PATH="$TMP/bin:$(dirname "$NODE"):/usr/bin:/bin" HARNESS_TEST_QA_COUNT="$TMP/blocked-qa-count" HARNESS_TEST_CODE_COUNT="$TMP/blocked-code-count" \
  "$NODE" "$ROOT/skills/generator/orchestrator.mjs" --host claude --repo "$TMP/blocked" \
  --workdir "$BLOCKED_WT" --context core --port 5170 --features WI-AC-001 --guidance "apply the reviewed fallback" \
  --claim-script "$ROOT/skills/generator/claim.sh" >"$TMP/resumed-result.json"
jq -e '.passed == 1 and (.stuck | length) == 0' "$TMP/resumed-result.json" >/dev/null
grep -q 'Explicit Resume' "$BLOCKED_WT/harness-progress/core.md"
grep -q 'apply the reviewed fallback' "$BLOCKED_WT/harness-progress/core.md"
echo 'ok - explicit guidance is journaled and starts a fresh bounded Attempt cycle'

if "$NODE" "$ROOT/skills/generator/orchestrator.mjs" --host invalid --workdir "$TMP/repo" 2>"$TMP/err"; then
  echo 'not ok - invalid host accepted' >&2; exit 1
fi
grep -q 'claude, codex, or opencode' "$TMP/err"
echo 'ok - one state machine exposes only the three thin host adapters'
