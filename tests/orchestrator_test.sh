#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP=${TMPDIR:-/tmp}/harness-orchestrator-test.$$
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/repo"

install_role_stubs() {
  for host in claude codex opencode; do
    cp "$ROOT/tests/lib/roles-routing-stub.sh" "$TMP/bin/$host"
    chmod +x "$TMP/bin/$host"
  done
}

install_main_claude_stub() {
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
    if [ "${HARNESS_TEST_CODE_DECLINE:-}" = 1 ]; then
      printf '%s\n' '{"id":"WI-AC-001","implementation":false,"notes":"scope exceeds budget"}'; exit 0
    fi
    if [ "${HARNESS_TEST_CODE_RATE_LIMIT:-}" = 1 ]; then
      echo '429: {"message":"Rate limit exceeded"}' >&2; exit 1
    fi
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
}

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

install_main_claude_stub

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

mkdir -p "$TMP/ratelimited"
git -C "$TMP/ratelimited" init -b main -q
git -C "$TMP/ratelimited" config user.name test
git -C "$TMP/ratelimited" config user.email test@example.invalid
cp "$TMP/repo/project_specs.xml" "$TMP/ratelimited/project_specs.xml"
cat >"$TMP/ratelimited/feature_list.json" <<'JSON'
[{"id":"WI-AC-001","context":"core","description":"health works","steps":["verify health"],"acceptance_checks":["AC-001"],"depends_on":[],"implementation":false,"qa":false,"integration":false,"retries":0}]
JSON
git -C "$TMP/ratelimited" add . && git -C "$TMP/ratelimited" commit -qm init
bash "$ROOT/skills/generator/claim.sh" select-claim "$TMP/ratelimited" all '' 5001 >"$TMP/ratelimited-claim.json"
RATELIMITED_WT=$(jq -r .worktree "$TMP/ratelimited-claim.json")
START_NS=$(date +%s%N)
PATH="$TMP/bin:$(dirname "$NODE"):/usr/bin:/bin" HARNESS_TEST_QA_COUNT="$TMP/ratelimited-qa-count" HARNESS_TEST_CODE_COUNT="$TMP/ratelimited-code-count" \
  HARNESS_TEST_CODE_RATE_LIMIT=1 HARNESS_RATE_LIMIT_BACKOFF_MS=1500 \
  "$NODE" "$ROOT/skills/generator/orchestrator.mjs" --host claude --repo "$TMP/ratelimited" \
  --workdir "$RATELIMITED_WT" --context core --port 5170 --features WI-AC-001 \
  --claim-script "$ROOT/skills/generator/claim.sh" >"$TMP/ratelimited-result.json"
ELAPSED_MS=$(( ($(date +%s%N) - START_NS) / 1000000 ))
jq -e '.stuck[0].status == "blocked" and .stuck[0].reason == "coding agent failed three times"' "$TMP/ratelimited-result.json" >/dev/null
test "$(cat "$TMP/ratelimited-code-count")" -eq 3
test "$ELAPSED_MS" -ge 3000 \
  || { echo "not ok - a 429 was retried without backing off (elapsed ${ELAPSED_MS}ms, expected >= 2 backoffs of 1500ms)" >&2; exit 1; }
echo 'ok - a rate-limited coding agent backs off before its next Attempt instead of instantly re-exhausting the same limit'

mkdir -p "$TMP/omni/.harness"
git -C "$TMP/omni" init -b main -q
git -C "$TMP/omni" config user.name test
git -C "$TMP/omni" config user.email test@example.invalid
cp "$TMP/repo/project_specs.xml" "$TMP/omni/project_specs.xml"
cat >"$TMP/omni/feature_list.json" <<'JSON'
[{"id":"WI-AC-001","context":"core","description":"health works","steps":["verify health"],"acceptance_checks":["AC-001"],"depends_on":[],"implementation":false,"qa":false,"integration":false,"retries":0}]
JSON
cat >"$TMP/omni/.harness/roles.json" <<'JSON'
{
  "coding": [
    {"harness":"claude","model":"rate-limit"},
    {"harness":"opencode","model":"auth-fail"},
    {"harness":"claude","model":"missing-model"},
    {"harness":"claude","model":"missing-cli"},
    {"harness":"opencode","model":"launch-fail"},
    {"harness":"codex"}
  ],
  "validation": [{"harness":"codex"},{"harness":"claude"}],
  "repairPlanning": [{"harness":"opencode"}],
  "goalReview": [{"harness":"claude"},{"harness":"codex"}]
}
JSON
git -C "$TMP/omni" add . && git -C "$TMP/omni" commit -qm init

install_role_stubs
bash "$ROOT/skills/generator/claim.sh" select-claim "$TMP/omni" all '' 5001 >"$TMP/omni-claim.json"
OMNI_WT=$(jq -r .worktree "$TMP/omni-claim.json")
PATH="$TMP/bin:$(dirname "$NODE"):/usr/bin:/bin" \
  HARNESS_TEST_ROLES_LOG="$TMP/omni.log" HARNESS_TEST_ROLES_QA="$TMP/omni-qa" \
  "$NODE" "$ROOT/skills/generator/orchestrator.mjs" --host claude --repo "$TMP/omni" \
  --workdir "$OMNI_WT" --context core --port 5170 --features WI-AC-001 \
  --claim-script "$ROOT/skills/generator/claim.sh" >"$TMP/omni-result.json"
jq -e '.passed == 1' "$TMP/omni-result.json" >/dev/null
OMNI_STATE="$TMP/omni/.git/harness-runs/core.json"
jq -e '[.routeHistory[] | select(.kind=="CODING" and .outcome=="fallback") | .fallbackReason] | contains(["rate-limited","authentication-failure","model-unavailable","launch-failure"])' "$OMNI_STATE" >/dev/null
jq -e '.routeHistory | any(.kind=="CODING" and .harness=="codex" and .outcome=="selected")' "$OMNI_STATE" >/dev/null
jq -e '.routeHistory | any((.kind=="QA" or .kind=="INTEGRATION_QA") and .harness=="claude" and .independence=="independent-harness")' "$OMNI_STATE" >/dev/null
test "$(grep -c '^qa claude ' "$TMP/omni.log")" -eq 2
grep -q 'route=.*"harness":"claude"' "$TMP/omni/.git/harness-runs/evidence/core/WI-AC-001-2-qa.log"
grep -q 'command not found' "$TMP/omni/.git/harness-runs/evidence/core/WI-AC-001-2-coding.log"
echo 'ok - roles.json routes ordered candidates and records provider/model fallbacks'
echo 'ok - validation prefers a different actual harness and product defects enter the repair loop'

mkdir -p "$TMP/single/.harness"
git -C "$TMP/single" init -b main -q
git -C "$TMP/single" config user.name test
git -C "$TMP/single" config user.email test@example.invalid
cp "$TMP/repo/project_specs.xml" "$TMP/single/project_specs.xml"
cat >"$TMP/single/feature_list.json" <<'JSON'
[{"id":"WI-AC-001","context":"core","description":"done","acceptance_checks":["AC-001"],"depends_on":[],"implementation":true,"qa":true,"integration":true,"retries":0}]
JSON
cat >"$TMP/single/.harness/roles.json" <<'JSON'
{"coding":["codex"],"validation":["codex"],"repairPlanning":["codex"],"goalReview":["codex"]}
JSON
git -C "$TMP/single" add . && git -C "$TMP/single" commit -qm init
install_role_stubs
PATH="$TMP/bin:$(dirname "$NODE"):/usr/bin:/bin" \
  HARNESS_TEST_ROLES_LOG="$TMP/omni.log" HARNESS_TEST_ROLES_QA="$TMP/omni-qa" \
  "$NODE" "$ROOT/skills/generator/orchestrator.mjs" --host claude --repo "$TMP/single" \
  --workdir "$TMP/single" --mode goal-review --context goal-review --port 5170 \
  --claim-script "$ROOT/skills/generator/claim.sh" >"$TMP/single-result.json" || true
jq -e '.agentRoute.harness == "codex" and .agentRoute.independence == "same-harness-fallback" and .agentRoute.fallbackReason == "no-different-harness-available"' "$TMP/single/.git/harness-runs/goal-review.json" >/dev/null
echo 'ok - single-harness roles.json records same-harness validation fallback'

if "$NODE" "$ROOT/skills/generator/orchestrator.mjs" --host invalid --workdir "$TMP/repo" 2>"$TMP/err"; then
  echo 'not ok - invalid host accepted' >&2; exit 1
fi
grep -q 'claude, codex, opencode, pi, or agent' "$TMP/err"
echo 'ok - one state machine exposes only the five thin host adapters'

mkdir -p "$TMP/cancel/.harness"
git -C "$TMP/cancel" init -b main -q
git -C "$TMP/cancel" config user.name test
git -C "$TMP/cancel" config user.email test@example.invalid
cp "$TMP/repo/project_specs.xml" "$TMP/cancel/project_specs.xml"
cp "$TMP/repo/feature_list.json" "$TMP/cancel/feature_list.json"
cat >"$TMP/cancel/.harness/roles.json" <<'JSON'
{"coding":["opencode"],"validation":["codex"],"repairPlanning":["codex"],"goalReview":["codex"]}
JSON
git -C "$TMP/cancel" add . && git -C "$TMP/cancel" commit -qm init
cat >"$TMP/bin/opencode" <<'SH'
#!/bin/sh
exec sleep 300
SH
chmod +x "$TMP/bin/opencode"
bash "$ROOT/skills/generator/claim.sh" select-claim "$TMP/cancel" all '' 6001 >"$TMP/cancel-claim.json"
CANCEL_WT=$(jq -r .worktree "$TMP/cancel-claim.json")
PATH="$TMP/bin:$(dirname "$NODE"):/usr/bin:/bin" \
  "$NODE" "$ROOT/skills/generator/orchestrator.mjs" --host codex --repo "$TMP/cancel" \
  --workdir "$CANCEL_WT" --context core --port 5170 --features WI-AC-001 \
  --claim-script "$ROOT/skills/generator/claim.sh" >"$TMP/cancel-result.json" &
ORCHESTRATOR_PID=$!
for _ in $(seq 1 100); do pgrep -P "$ORCHESTRATOR_PID" >/dev/null 2>&1 && break; sleep 0.05; done
CHILD_PID=$(pgrep -P "$ORCHESTRATOR_PID" | head -1)
test -n "$CHILD_PID"
kill -TERM "$ORCHESTRATOR_PID"
wait "$ORCHESTRATOR_PID" || true
if kill -0 "$CHILD_PID" 2>/dev/null; then
  echo 'not ok - interrupted roles-routed descendant remained alive' >&2; exit 1
fi
echo 'ok - interruption terminates the complete roles-routed process group'

install_role_stubs

new_case_repo() {
  local dir="$1"
  mkdir -p "$dir/.harness"
  git -C "$dir" init -b main -q
  git -C "$dir" config user.name test
  git -C "$dir" config user.email test@example.invalid
  cp "$TMP/repo/project_specs.xml" "$dir/project_specs.xml"
  # Fresh queue: $TMP/repo/feature_list.json was mutated to integration=true by the first run.
  cat >"$dir/feature_list.json" <<'JSON'
[{"id":"WI-AC-001","context":"core","description":"health works","acceptance_checks":["AC-001"],"depends_on":[],"implementation":false,"qa":false,"integration":false,"retries":0}]
JSON
}

# ---- (a) no-credits classification routes to the free tier; 429 quota stays rate-limited -------
new_case_repo "$TMP/credits"
cat >"$TMP/credits/.harness/roles.json" <<'JSON'
{
  "coding": [{"harness":"claude","model":"fail-402"},{"harness":"codex","model":"fail-quota"}],
  "validation": [{"harness":"claude"}],
  "repairPlanning": [{"harness":"opencode"}],
  "goalReview": [{"harness":"claude"}],
  "noCredits": [{"harness":"opencode","model":"free"}]
}
JSON
git -C "$TMP/credits" add . && git -C "$TMP/credits" commit -qm init
bash "$ROOT/skills/generator/claim.sh" select-claim "$TMP/credits" all '' 7001 >"$TMP/credits-claim.json"
CREDITS_WT=$(jq -r .worktree "$TMP/credits-claim.json")
PATH="$TMP/bin:$(dirname "$NODE"):/usr/bin:/bin" \
  HARNESS_TEST_ROLES_LOG="$TMP/credits.log" HARNESS_TEST_ROLES_QA="$TMP/credits-qa" HARNESS_TEST_ROLES_QA_FAILS=0 \
  "$NODE" "$ROOT/skills/generator/orchestrator.mjs" --host claude --repo "$TMP/credits" \
  --workdir "$CREDITS_WT" --context core --port 5170 --features WI-AC-001 \
  --claim-script "$ROOT/skills/generator/claim.sh" >"$TMP/credits-result.json"
jq -e '.passed == 1' "$TMP/credits-result.json" >/dev/null
CREDITS_STATE="$TMP/credits/.git/harness-runs/core.json"
jq -e '.routeHistory | any(.kind=="CODING" and .outcome=="selected" and .harness=="opencode" and .model=="free")' "$CREDITS_STATE" >/dev/null
jq -e '[.routeHistory[] | select(.kind=="CODING" and .outcome=="fallback") | .fallbackReason] | contains(["no-credits","rate-limited"])' "$CREDITS_STATE" >/dev/null
echo 'ok - 402/insufficient-credits classifies as no-credits and falls through to the free tier'
echo 'ok - a 429 quota-exceeded coder still classifies as rate-limited, not no-credits'

# ---- (b) cross-item strike sort: a demoted candidate is tried AFTER a lower-strike one ----------
new_case_repo "$TMP/bsort"
cat >"$TMP/bsort/.harness/roles.json" <<'JSON'
{
  "coding": [{"harness":"claude","model":"seeded"},{"harness":"codex","model":"fail-infra"}],
  "validation": [{"harness":"opencode"}],
  "repairPlanning": [{"harness":"opencode"}],
  "goalReview": [{"harness":"claude"}]
}
JSON
git -C "$TMP/bsort" add . && git -C "$TMP/bsort" commit -qm init
bash "$ROOT/skills/generator/claim.sh" select-claim "$TMP/bsort" all '' 7002 >"$TMP/bsort-claim.json"
BSORT_WT=$(jq -r .worktree "$TMP/bsort-claim.json")
# Demote the natural first coder (claude|seeded) so the lower-strike codex|fail-infra sorts ahead of it.
bash "$ROOT/skills/generator/claim.sh" strike "$TMP/bsort" 'infra|claude|seeded' 5 >/dev/null
PATH="$TMP/bin:$(dirname "$NODE"):/usr/bin:/bin" \
  HARNESS_TEST_ROLES_LOG="$TMP/bsort.log" HARNESS_TEST_ROLES_QA="$TMP/bsort-qa" HARNESS_TEST_ROLES_QA_FAILS=0 \
  "$NODE" "$ROOT/skills/generator/orchestrator.mjs" --host claude --repo "$TMP/bsort" \
  --workdir "$BSORT_WT" --context core --port 5170 --features WI-AC-001 \
  --claim-script "$ROOT/skills/generator/claim.sh" >"$TMP/bsort-result.json"
jq -e '.passed == 1' "$TMP/bsort-result.json" >/dev/null
BSORT_STATE="$TMP/bsort/.git/harness-runs/core.json"
# routeHistory preserves attempt order: the lower-strike codex is tried first, the demoted claude|seeded after.
jq -e '[.routeHistory[] | select(.kind=="CODING")] | .[0].harness=="codex" and .[0].model=="fail-infra" and .[0].outcome=="fallback"' "$BSORT_STATE" >/dev/null
jq -e '[.routeHistory[] | select(.kind=="CODING")] | .[1].harness=="claude" and .[1].model=="seeded" and .[1].outcome=="selected"' "$BSORT_STATE" >/dev/null
echo 'ok - a pre-seeded strike demotes a candidate so a lower-strike one is tried first'

# ---- (c) within-item switch: two QA defects advance the attempt-3 coder by the repair budget ----
new_case_repo "$TMP/within"
cat >"$TMP/within/.harness/roles.json" <<'JSON'
{
  "coding": [{"harness":"claude","model":"c1"},{"harness":"codex","model":"c2"}],
  "validation": [{"harness":"opencode"}],
  "repairPlanning": [{"harness":"opencode"}],
  "goalReview": [{"harness":"claude"}]
}
JSON
git -C "$TMP/within" add . && git -C "$TMP/within" commit -qm init
bash "$ROOT/skills/generator/claim.sh" select-claim "$TMP/within" all '' 7003 >"$TMP/within-claim.json"
WITHIN_WT=$(jq -r .worktree "$TMP/within-claim.json")
# Default HARNESS_REPAIR_BUDGET=2 => offset floor((attempt-1)/2): attempts 1,2 keep coder[0], attempt 3 advances to coder[1].
PATH="$TMP/bin:$(dirname "$NODE"):/usr/bin:/bin" \
  HARNESS_TEST_ROLES_LOG="$TMP/within.log" HARNESS_TEST_ROLES_QA="$TMP/within-qa" HARNESS_TEST_ROLES_QA_FAILS=2 \
  "$NODE" "$ROOT/skills/generator/orchestrator.mjs" --host claude --repo "$TMP/within" \
  --workdir "$WITHIN_WT" --context core --port 5170 --features WI-AC-001 \
  --claim-script "$ROOT/skills/generator/claim.sh" >"$TMP/within-result.json"
jq -e '.passed == 1' "$TMP/within-result.json" >/dev/null
test "$(grep -c '^coding claude c1' "$TMP/within.log")" -eq 2
test "$(grep -c '^coding codex c2' "$TMP/within.log")" -eq 1
grep -q 'route=.*"harness":"codex"' "$TMP/within/.git/harness-runs/evidence/core/WI-AC-001-3-coding.log"
echo 'ok - within an item the coder switches only at attempt 3 under the default repair budget of 2'

# ---- (d) an explicit decline routes to the next coding candidate without burning Attempts -------
new_case_repo "$TMP/decline"
cat >"$TMP/decline/.harness/roles.json" <<'JSON'
{
  "coding": [{"harness":"claude","model":"decline"},{"harness":"codex","model":"c2"}],
  "validation": [{"harness":"opencode"}],
  "repairPlanning": [{"harness":"opencode"}],
  "goalReview": [{"harness":"claude"}]
}
JSON
git -C "$TMP/decline" add . && git -C "$TMP/decline" commit -qm init
bash "$ROOT/skills/generator/claim.sh" select-claim "$TMP/decline" all '' 7004 >"$TMP/decline-claim.json"
DECLINE_WT=$(jq -r .worktree "$TMP/decline-claim.json")
PATH="$TMP/bin:$(dirname "$NODE"):/usr/bin:/bin" \
  HARNESS_TEST_ROLES_LOG="$TMP/decline.log" HARNESS_TEST_ROLES_QA="$TMP/decline-qa" HARNESS_TEST_ROLES_QA_FAILS=0 \
  "$NODE" "$ROOT/skills/generator/orchestrator.mjs" --host claude --repo "$TMP/decline" \
  --workdir "$DECLINE_WT" --context core --port 5170 --features WI-AC-001 \
  --claim-script "$ROOT/skills/generator/claim.sh" >"$TMP/decline-result.json"
jq -e '.passed == 1' "$TMP/decline-result.json" >/dev/null
test "$(grep -c '^coding claude decline' "$TMP/decline.log")" -eq 1
test "$(grep -c '^coding codex c2' "$TMP/decline.log")" -eq 1
echo 'ok - a coding decline routes to the next candidate without consuming an Attempt'

# ---- (e) direct-host mode blocks immediately on an explicit decline ----------------------------
new_case_repo "$TMP/ddecline"
install_main_claude_stub
git -C "$TMP/ddecline" add . && git -C "$TMP/ddecline" commit -qm init
bash "$ROOT/skills/generator/claim.sh" select-claim "$TMP/ddecline" all '' 7005 >"$TMP/ddecline-claim.json"
DDECLINE_WT=$(jq -r .worktree "$TMP/ddecline-claim.json")
PATH="$TMP/bin:$(dirname "$NODE"):/usr/bin:/bin" HARNESS_TEST_QA_COUNT="$TMP/ddecline-qa-count" \
  HARNESS_TEST_CODE_COUNT="$TMP/ddecline-code-count" HARNESS_TEST_CODE_DECLINE=1 \
  "$NODE" "$ROOT/skills/generator/orchestrator.mjs" --host claude --repo "$TMP/ddecline" \
  --workdir "$DDECLINE_WT" --context core --port 5170 --features WI-AC-001 \
  --claim-script "$ROOT/skills/generator/claim.sh" >"$TMP/ddecline-result.json"
jq -e '.stuck[0].reason == "coding agent declined the Work Item"' "$TMP/ddecline-result.json" >/dev/null
test "$(cat "$TMP/ddecline-code-count")" -eq 1
echo 'ok - direct-host mode blocks immediately with the agent notes when the coder declines'

# ---- (f) attempt offset and decline offset compose without skipping a candidate -----------------
new_case_repo "$TMP/compose"
install_role_stubs
cat >"$TMP/compose/.harness/roles.json" <<'JSON'
{
  "coding": [{"harness":"claude","model":"decline"},{"harness":"codex","model":"c2"},{"harness":"claude","model":"c3"}],
  "validation": [{"harness":"opencode"}],
  "repairPlanning": [{"harness":"opencode"}],
  "goalReview": [{"harness":"claude"}]
}
JSON
git -C "$TMP/compose" add . && git -C "$TMP/compose" commit -qm init
bash "$ROOT/skills/generator/claim.sh" select-claim "$TMP/compose" all '' 7006 >"$TMP/compose-claim.json"
COMPOSE_WT=$(jq -r .worktree "$TMP/compose-claim.json")
# Repair budget 1: decline advances past claude|decline, the attempt-2 offset past codex|c2 -> claude|c3 codes.
PATH="$TMP/bin:$(dirname "$NODE"):/usr/bin:/bin" \
  HARNESS_TEST_ROLES_LOG="$TMP/compose.log" HARNESS_TEST_ROLES_QA="$TMP/compose-qa" HARNESS_TEST_ROLES_QA_FAILS=1 \
  HARNESS_REPAIR_BUDGET=1 \
  "$NODE" "$ROOT/skills/generator/orchestrator.mjs" --host claude --repo "$TMP/compose" \
  --workdir "$COMPOSE_WT" --context core --port 5170 --features WI-AC-001 \
  --claim-script "$ROOT/skills/generator/claim.sh" >"$TMP/compose-result.json"
jq -e '.passed == 1' "$TMP/compose-result.json" >/dev/null
test "$(grep -c '^coding claude decline' "$TMP/compose.log")" -eq 1
test "$(grep -c '^coding codex c2' "$TMP/compose.log")" -eq 1
test "$(grep -c '^coding claude c3' "$TMP/compose.log")" -eq 1
echo 'ok - attempt and decline offsets compose so every candidate is consulted exactly once'

# ---- (g) a delimited verdict block wins over distractor JSON-looking noise printed before it ----
new_case_repo "$TMP/verdict"
git -C "$TMP/verdict" add . && git -C "$TMP/verdict" commit -qm init
cat >"$TMP/bin/claude" <<'SH'
#!/bin/sh
set -eu
prompt=""; for arg in "$@"; do prompt=$arg; done
printf '%s' "$prompt" | grep -q "$PWD/project_specs.xml"
printf '%s' "$prompt" | grep -q 'verify that the repository contains every structure and file it requires'
tmp="$PWD/feature_list.json.tmp"
commit() { git add feature_list.json; git commit -qm "$1"; }
# Distractor: JSON-looking noise (a bare object plus a stray closing brace) printed before the
# real, sentinel-wrapped verdict. A parser that still scans positionally instead of preferring the
# delimited block risks picking this up instead.
noise() { printf '{"note":"debug"}\n'; printf '}\n'; }
verdict() { printf '===HARNESS-VERDICT-BEGIN===\n%s\n===HARNESS-VERDICT-END===\n' "$1"; }
case "$prompt" in
  *"Integrated Verification"*)
    jq 'map(if .id=="WI-AC-001" then .integration=true else . end)' feature_list.json >"$tmp" && mv "$tmp" feature_list.json
    commit integration
    noise; verdict '{"id":"WI-AC-001","integration":true,"implementation":true,"defects":[]}'
    ;;
  *"coding-agent"*)
    jq 'map(if .id=="WI-AC-001" then .implementation=true else . end)' feature_list.json >"$tmp" && mv "$tmp" feature_list.json
    commit coding
    noise; verdict '{"id":"WI-AC-001","implementation":true,"notes":"implemented"}'
    ;;
  *"qa-agent"*)
    jq 'map(if .id=="WI-AC-001" then .qa=true else . end)' feature_list.json >"$tmp" && mv "$tmp" feature_list.json
    commit qa-pass
    noise; verdict '{"id":"WI-AC-001","qa":true,"implementation":true,"defects":[]}'
    ;;
esac
SH
chmod +x "$TMP/bin/claude"
bash "$ROOT/skills/generator/claim.sh" select-claim "$TMP/verdict" all '' 8001 >"$TMP/verdict-claim.json"
VERDICT_WT=$(jq -r .worktree "$TMP/verdict-claim.json")
PATH="$TMP/bin:$(dirname "$NODE"):/usr/bin:/bin" HARNESS_TEST_QA_COUNT="$TMP/verdict-qa-count" HARNESS_TEST_CODE_COUNT="$TMP/verdict-code-count" \
  "$NODE" "$ROOT/skills/generator/orchestrator.mjs" --host claude --repo "$TMP/verdict" \
  --workdir "$VERDICT_WT" --context core --port 5170 --features WI-AC-001 \
  --claim-script "$ROOT/skills/generator/claim.sh" >"$TMP/verdict-result.json"
jq -e '.passed == 1 and (.stuck | length) == 0' "$TMP/verdict-result.json" >/dev/null
jq -e '.[0].implementation and .[0].qa and .[0].integration and .[0].retries == 0' "$TMP/verdict/feature_list.json" >/dev/null
echo 'ok - a delimited verdict block wins over distractor JSON-looking noise printed before it'

# A MERGE agent that stages a conflicted file without actually removing the
# <<<<<<</=======/>>>>>>> marker lines must not be allowed to commit it --
# git add clears the path's unresolved-merge flag regardless of file content,
# so integrate() needs its own content-level check, not just diff --diff-filter=U.
mkdir -p "$TMP/mergecorrupt/bin"
git -C "$TMP/mergecorrupt" init -b main -q
git -C "$TMP/mergecorrupt" config user.name test
git -C "$TMP/mergecorrupt" config user.email test@example.invalid
cat >"$TMP/mergecorrupt/project_specs.xml" <<'XML'
<project_specification>
  <project_goal>A real boundary returns ready.</project_goal>
  <acceptance_checks>
    <acceptance_check id="AC-001" context="core" category="functional" depends_on="">
      <description>The health boundary returns ready.</description>
    </acceptance_check>
  </acceptance_checks>
</project_specification>
XML
cat >"$TMP/mergecorrupt/feature_list.json" <<'JSON'
[{"id":"WI-AC-001","context":"core","description":"health works","steps":["verify health"],"acceptance_checks":["AC-001"],"depends_on":[],"implementation":false,"qa":false,"integration":false,"retries":0}]
JSON
git -C "$TMP/mergecorrupt" add . && git -C "$TMP/mergecorrupt" commit -qm init

bash "$ROOT/skills/generator/claim.sh" select-claim "$TMP/mergecorrupt" all '' 9001 >"$TMP/mergecorrupt-claim.json"
MC_WT=$(jq -r .worktree "$TMP/mergecorrupt-claim.json")

# Diverge main after the claim so the worktree's checkpoint conflicts with it on
# the exact same field when integrate() tries to merge back.
jq '.[0].note = "changed on main"' "$TMP/mergecorrupt/feature_list.json" >"$TMP/mergecorrupt/feature_list.json.tmp"
mv "$TMP/mergecorrupt/feature_list.json.tmp" "$TMP/mergecorrupt/feature_list.json"
git -C "$TMP/mergecorrupt" commit -qam 'diverge main'

cat >"$TMP/mergecorrupt/bin/claude" <<'SH'
#!/bin/sh
set -eu
prompt=""; for arg in "$@"; do prompt=$arg; done
tmp="$PWD/feature_list.json.tmp"
commit() { git add feature_list.json; git commit -qm "$1"; }
case "$prompt" in
  *"resolving integration conflicts"*)
    # Deliberately buggy "resolution": leave the marker lines in place and
    # stage the file anyway -- this is exactly the failure this test guards.
    git add feature_list.json
    git commit -qm 'merge: resolve (broken)'
    printf '%s\n' '{"resolved":true,"notes":"resolved"}'
    ;;
  *"coding-agent"*)
    jq 'map(if .id=="WI-AC-001" then .implementation=true else . end)' feature_list.json >"$tmp" && mv "$tmp" feature_list.json
    commit coding
    printf '%s\n' '{"id":"WI-AC-001","implementation":true,"notes":"implemented"}'
    ;;
  *"qa-agent"*)
    jq 'map(if .id=="WI-AC-001" then .qa=true else . end)' feature_list.json >"$tmp" && mv "$tmp" feature_list.json
    commit qa-pass
    printf '%s\n' '{"id":"WI-AC-001","qa":true,"implementation":true,"defects":[]}'
    ;;
esac
SH
chmod +x "$TMP/mergecorrupt/bin/claude"

MC_BEFORE_HEAD=$(git -C "$TMP/mergecorrupt" rev-parse main)
PATH="$TMP/mergecorrupt/bin:$(dirname "$NODE"):/usr/bin:/bin" \
  "$NODE" "$ROOT/skills/generator/orchestrator.mjs" --host claude --repo "$TMP/mergecorrupt" \
  --workdir "$MC_WT" --context core --port 5172 --features WI-AC-001 \
  --claim-script "$ROOT/skills/generator/claim.sh" >"$TMP/mergecorrupt-result.json" || true
if jq -e '.passed == 1' "$TMP/mergecorrupt-result.json" >/dev/null; then
  echo 'not ok - a marker-corrupted merge was accepted as passing' >&2
  exit 1
fi
jq -e '.stuck[0].defects[0] | test("marker")' "$TMP/mergecorrupt-result.json" >/dev/null
test "$(git -C "$TMP/mergecorrupt" rev-parse main)" = "$MC_BEFORE_HEAD"
! grep -q '^<<<<<<< ' "$TMP/mergecorrupt/feature_list.json"
echo 'ok - a MERGE agent that stages a conflict without removing marker lines is caught and its commit is aborted, not landed on main'
echo 'ok - orchestrator tests passed'
