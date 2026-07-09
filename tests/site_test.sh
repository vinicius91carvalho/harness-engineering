#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
HTML="$ROOT/site/index.html"
README="$ROOT/README.md"
ROLES="$ROOT/config/roles.example.json"
ROLES_URL='https://github.com/vinicius91carvalho/harness-engineering/blob/main/config/roles.example.json'

test -s "$HTML"
test -s "$ROOT/site/styles.css"
test -s "$ROOT/.github/workflows/pages.yml"
test -s "$ROLES"

jq -e '
  ([.coding,.validation,.repairPlanning,.goalReview,.noCredits] | all(length > 0)) and
  ([.coding[],.validation[],.repairPlanning[],.goalReview[],.noCredits[]] |
    all((if type == "string" then . else .harness end) as $h |
      ["claude","codex","opencode","pi","agent"] | index($h)))
' "$ROLES" >/dev/null

for id in why architecture language journey delegate workflow phases prerequisites install commands start worked-example add-feature files spec-format queue-format runtime-state monorepo operate troubleshoot advanced routing herdr maintenance help; do
  grep -q "id=\"$id\"" "$HTML"
done
while IFS= read -r id; do
  grep -q "id=\"$id\"" "$HTML"
done < <(sed -n 's/.*href="#\([^"]*\)".*/\1/p' "$HTML")

grep -q 'assets/banner.svg' "$HTML"
grep -q 'path: site' "$ROOT/.github/workflows/pages.yml"
grep -q 'actions/deploy-pages@v4' "$ROOT/.github/workflows/pages.yml"
! grep -Eq '(href|src)="/[^/]+' "$HTML"

next_heading=$(awk '/^## Framework$/{found=1; next} found && /^## /{print; exit}' "$README")
test "$next_heading" = '## How the workflow runs'
grep -Fq 'Node.js 18 or newer' "$README"
grep -Fq 'Node.js 18 or newer' "$HTML"
grep -Fq '/harness:setup` | `/harness-setup' "$README"
grep -Fq '/harness:setup</code></td><td><code>/harness-setup' "$HTML"
grep -Fq 'Run setup **without a goal, feature, scope, or other text**' "$README"
grep -Fq 'with no goal, feature, scope, or other text' "$HTML"
! grep -Eq '/harness[:-]setup +(Add|Your|Build)' "$README" "$HTML"
! grep -Fiq 'For non-interactive OpenCode setup' "$README" "$HTML"
! grep -Fq '/harness:grilling' "$README" "$HTML"
grep -Fq 'by asking “grill me.”' "$README"
grep -Fq 'by asking “grill me.”' "$HTML"
grep -Fq 'does not require a generator run' "$README"
grep -Fq 'does not validate every feature' "$HTML"
grep -Fq 'No coding tool launches and no Acceptance Check runs' "$HTML"
grep -Fq 'false queue flags mean “not yet proved,” not “the application is broken.”' "$HTML"
grep -Fq 'Other mapped Work Items stay untouched' "$HTML"
grep -Fq 'Add reversible note archiving' "$HTML"
grep -Fq '* `implementation` means coding completed.' "$README"
grep -Fq '* `qa` means isolated QA passed.' "$README"
grep -Fq '* `integration` means the behavior passed after merging.' "$README"
grep -Fq 'https://pi.dev/' "$README" "$HTML"
grep -Fq 'Context map' "$HTML"
grep -Fq 'harness-design-long-running-apps' "$HTML"
grep -Fq 'https://herdr.dev/' "$README" "$HTML"
grep -Fq 'https://github.com/AltanS/collie' "$README" "$HTML"
grep -Fq 'herdr.collie' "$HTML"
grep -Fq 'tailscale serve' "$HTML"
grep -Fq 'https://developers.openai.com/codex/' "$README" "$HTML"
grep -Fq 'Grilling is a planner capability' "$ROOT/skills/planner/SKILL.md"
grep -Fq 'Do not tell them to validate every mapped' "$ROOT/skills/setup/SKILL.md"
grep -Fq 'not required to plan' "$README"
grep -Fq -- '--display herdr' "$HTML"
grep -Fq -- '--display background' "$HTML"
grep -Fq 'HERDR_ENV=1' "$HTML"
! grep -Fq 'https://omnigent.ai/' "$README" "$HTML"
! grep -Fq 'omnigent' "$HTML"

diff -u <(jq -S . "$ROLES") <(
  sed -n '/id="routing"/,/id="herdr"/p' "$HTML" |
    sed -n '/<pre><code>{/,/}<\/code><\/pre>/p' |
    sed '1s/.*<pre><code>//; $s/<\/code><\/pre>.*//' |
    jq -S .
)

for anchor in routing herdr monorepo; do
  grep -Fq "vinicius91carvalho.github.io/harness-engineering/#$anchor" "$README"
done

for file in "$HTML"; do
  grep -Fq "$ROLES_URL" "$file"
  grep -Fq '.harness/projects.json' "$file"
  grep -Fq 'run_completed' "$file"
  grep -Fq 'implementation and .qa and .integration' "$file"
done
grep -Fq 'config/roles.example.json' "$README"
grep -Fq '.harness/projects.json' "$README"
grep -Fq 'run_completed' "$README"
grep -Fq 'implementation and .qa and .integration' "$README"

for str in 'A long unattended run with monitoring/pause/resume' 'To independently re-audit an already-integrated integration branch' 'An existing working app, just adopting the harness (no new goal)' '(existing-codebase mode)' 'still draining its retry queue (up to 5 attempts per context)' 'HARNESS_LEASE_TIMEOUT_SECONDS'; do
  grep -Fq -- "$str" "$README"
  grep -Fq -- "$str" "$HTML"
done

! grep -Eq 'Hermes|Telegram' "$HTML"

# README Quickstart: install is terminal, skills are chat (no blanket "type these in chat" covering install)
! grep -Fq 'Type these in your **coding tool''s chat**' "$README"
grep -Fq 'Install once in a terminal' "$README"
grep -Fq 'Then type these in your coding tool' "$README"

# Install contract: release tags, not main tip
grep -Fq 'latest GitHub Release tag' "$README"
grep -Fq 'latest GitHub Release tag' "$HTML"

# README file structure examples
grep -Fq 'id="AC-001"' "$README"
grep -Fq 'WI-AC-001' "$README"

# Site: plan integration branch model (not Goal Review on main)
grep -Fq 'plan integration branch' "$HTML"
! grep -Fq 'Final independent audit of the whole spec on <code>main</code>' "$HTML"
! grep -Fq 'Checks run again after merging into current <code>main</code>' "$HTML"
! grep -Fq 'proves completion on <code>main</code>' "$HTML"

echo 'ok - README is a short quick-start pointing into the complete site, which documents the full workflow, role routing, and optional herdr visibility'
