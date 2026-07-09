#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BUNDLE="$ROOT/omnigent/harness-engineering"

jq -e '
  ([.coding,.validation,.repairPlanning,.goalReview,.noCredits] | all(length > 0)) and
  ([.coding[],.validation[],.repairPlanning[],.goalReview[],.noCredits[]] |
    all((if type == "string" then . else .harness end) as $h |
      ["claude","codex","opencode","pi","agent"] | index($h)))
' "$BUNDLE/roles.example.json" >/dev/null

for harness in claude codex opencode pi agent; do
  file="$BUNDLE/agents/$harness/config.yaml"
  test -s "$file"
  grep -q '^spec_version: 1$' "$file"
  grep -q "^name: $harness$" "$file"
  grep -q "harness: $harness" "$file"
done

grep -Fq 'cwd_allow_hidden: [.git, .harness]' "$BUNDLE/agents/claude/config.yaml"
grep -Fq 'cwd_allow_hidden: [.git, .harness]' "$BUNDLE/agents/opencode/config.yaml"
grep -Fq 'cwd_allow_hidden: [.git, .harness]' "$BUNDLE/agents/pi/config.yaml"
grep -Fq '    type: none' "$BUNDLE/agents/codex/config.yaml"

grep -q '^spec_version: 1$' "$BUNDLE/config.yaml"
grep -Fq '    type: none' "$BUNDLE/config.yaml"
# config.yaml's own goal-intake recipe must gate on the bootstrap check too —
# it's read before the skill and previously let the agent skip straight to `start`
grep -q 'Bootstrap check BEFORE step 3' "$BUNDLE/config.yaml"
for skill in setup monorepo-setup planning generation validation integration goal-review status input-requests grilling harness-master harness-relay; do
  file="$BUNDLE/skills/$skill/SKILL.md"
  test -s "$file"
  grep -q '^name:' "$file"
  grep -q '^description:' "$file"
done
grep -q 'Always load `grilling` first' "$BUNDLE/skills/planning/SKILL.md"
grep -q 'Do not start or recommend validation of all mapped features' "$BUNDLE/skills/setup/SKILL.md"
grep -q 'Never refactor while RED' "$BUNDLE/skills/harness-master/SKILL.md"
grep -q '20k' "$BUNDLE/skills/harness-master/SKILL.md"

grep -q 'grill' "$BUNDLE/config.yaml"
grep -q 'summary-minutes' "$BUNDLE/config.yaml"
grep -q 'one question at a time' "$BUNDLE/skills/grilling/SKILL.md"
grep -q 'Grill at intake' "$BUNDLE/skills/harness-master/SKILL.md"

# harness-relay: status/event/action semantics, recovery policy, proposal mechanism
RELAY="$BUNDLE/skills/harness-relay/SKILL.md"
for section in 'Status semantics' 'Response action semantics' 'Stuck detection' 'Recovery policy' 'Proposal format' 'Apply approved proposal' 'Skills vocabulary' 'Delegation'; do
  grep -q "## $section" "$RELAY"
done
# The specific failure that thrashed the logged session: amend must NOT be followed by start
grep -q 'Never call .start. after .amend' "$RELAY"
grep -q 'amend.*5-step recipe' "$RELAY"
# Proposal folder is created at runtime, not bundled — but the path is referenced
grep -q 'BUNDLE/proposals' "$RELAY"
# Recovery policy must distinguish auto-recover vs delegate
grep -q 'Auto-recover' "$RELAY"
grep -qE 'auto-recover|delegate' "$RELAY"
# Apply is a one-liner using patch, not a new script
grep -q 'patch -p1 -d' "$RELAY"
# Operations surface mirrors the 11 commands in harness-control.mjs:18
grep -q 'start, run, status, capacity, events, ack, respond, quota, pause,' "$RELAY"
grep -q 'resume, stop' "$RELAY"
# Vocabulary maps bundle names (planning, validation) to root aliases (planner, evaluator)
grep -q 'planning.*planner' "$RELAY"
grep -q 'validation.*evaluator' "$RELAY"
# Delegation has five targets and the standard message shape
grep -q 'Orchestrator-skill action' "$RELAY"
grep -q 'Delegated to' "$RELAY"
# Bootstrap never becomes self-inspection: relay delegates, never loads setup itself
grep -q 'Never load .setup. yourself' "$RELAY"
grep -q 'bootstrap-setup.sh' "$RELAY"
# A stuck bootstrap job's question must reach the human, not just "go run setup elsewhere"
grep -q 'ASKED' "$RELAY"
grep -q 'WAITING_FOR_ANSWER' "$RELAY"
grep -q 'is the answer, not a new goal' "$RELAY"
test -x "$BUNDLE/scripts/bootstrap-setup.sh"
grep -q 'command -v' "$BUNDLE/scripts/bootstrap-setup.sh"

echo 'ok - Omnigent bundle, worker templates, skills, role example, and relay recovery policy are structurally valid'
