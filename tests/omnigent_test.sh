#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BUNDLE="$ROOT/omnigent/harness-engineering"

jq -e '
  ([.coding,.validation,.repairPlanning,.goalReview,.noCredits] | all(length > 0)) and
  ([.coding[],.validation[],.repairPlanning[],.goalReview[],.noCredits[]] |
    all((if type == "string" then . else .harness end) as $h |
      ["claude","codex","opencode"] | index($h))) and
  (.coding | all((if type == "string" then . else .harness end) != "pi"))
' "$BUNDLE/roles.example.json" >/dev/null

for harness in claude codex opencode pi; do
  file="$BUNDLE/agents/$harness/config.yaml"
  test -s "$file"
  grep -q '^spec_version: 1$' "$file"
  grep -q "^name: $harness$" "$file"
  grep -q "harness: $harness" "$file"
done

grep -Fq 'cwd_allow_hidden: [.git, .harness]' "$BUNDLE/agents/claude/config.yaml"
grep -Fq 'cwd_allow_hidden: [.git, .harness]' "$BUNDLE/agents/opencode/config.yaml"
grep -Fq 'cwd_allow_hidden: [.git, .harness]' "$BUNDLE/agents/pi/config.yaml"
grep -q '20k' "$BUNDLE/agents/pi/config.yaml"
grep -Fq '    type: none' "$BUNDLE/agents/codex/config.yaml"

grep -q '^spec_version: 1$' "$BUNDLE/config.yaml"
grep -Fq '    type: none' "$BUNDLE/config.yaml"
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

echo 'ok - Omnigent bundle, worker templates, skills, and role example are structurally valid'
