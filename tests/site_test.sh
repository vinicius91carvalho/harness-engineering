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

for id in why architecture language journey delegate workflow phases prerequisites install commands start worked-example add-feature files spec-format queue-format runtime-state monorepo operate troubleshoot advanced routing maintenance help; do
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
grep -Fq '/harness:setup` | `/harness-setup` | `/harness-setup' "$README"
grep -Fq '/harness:supervisor` | `/harness-supervisor` | `/harness-supervisor' "$README"
grep -Fq 'Default harness form is `/harness:<command>`' "$README"
grep -Fq '/harness:setup</code></td><td><code>/harness-setup</code></td><td><code>/harness-setup' "$HTML"
grep -Fq '/harness:supervisor</code></td><td><code>/harness-supervisor</code></td><td><code>/harness-supervisor' "$HTML"
grep -Fq 'Default harness form is <code>/harness:&lt;command&gt;</code>' "$HTML"
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
grep -Fq 'false Execution Ledger proofs' "$HTML"
grep -Fq 'mean “not yet proved,” not “the application is broken.”' "$HTML"
grep -Fq 'Older docs called these queue flags.' "$HTML"
grep -Fq 'Execution Ledger records' "$HTML"
grep -Fq 'opaque consumer id' "$HTML"
grep -Fq 'journal consumer name, not a UI' "$HTML"
grep -Fq 'Other mapped Work Items stay untouched' "$HTML"
grep -Fq 'Add reversible note archiving' "$HTML"
grep -Fq '* `implementation` means coding completed.' "$README"
grep -Fq '* `qa` means isolated QA passed.' "$README"
grep -Fq '* `integration` means the behavior passed after merging.' "$README"
grep -Fq 'https://pi.dev/' "$README" "$HTML"
grep -Fq 'Context map' "$HTML"
grep -Fq 'harness-design-long-running-apps' "$HTML"
grep -Fq 'Workers always run in the background' "$README" "$HTML"
grep -Fq 'herdr-notify' "$HTML"
grep -Fq 'https://developers.openai.com/codex/' "$README" "$HTML"
grep -Fq 'Grilling is a planner capability' "$ROOT/skills/planner/SKILL.md"
grep -Fq 'Do not tell them to validate every mapped' "$ROOT/skills/setup/SKILL.md"
grep -Fq 'not required to plan' "$README"
! grep -Fq 'config/mcp.json' "$HTML"
! grep -Fq 'mcp-servers' "$HTML"
! grep -Fq 'https://omnigent.ai/' "$README" "$HTML"
! grep -Fq 'omnigent' "$HTML"
! grep -Fq 'id="herdr"' "$HTML"
! grep -Fq -- '--display' "$HTML"
! grep -Fq -- 'HERDR_ENV' "$HTML"

diff -u <(jq -S . "$ROLES") <(
  sed -n '/id="routing"/,/id="maintenance"/p' "$HTML" |
    sed -n '/<pre><code>{/,/}<\/code><\/pre>/p' |
    sed '1s/.*<pre><code>//; $s/<\/code><\/pre>.*//' |
    jq -S .
)

for anchor in routing monorepo; do
  grep -Fq "vinicius91carvalho.github.io/harness-engineering/#$anchor" "$README"
done

for file in "$HTML"; do
  grep -Fq "$ROLES_URL" "$file"
  grep -Fq '.harness/projects.json' "$file"
  grep -Fq 'run_completed' "$file"
  grep -Fq '.integrated == .total' "$file"
done
grep -Fq 'config/roles.example.json' "$README"
grep -Fq '.harness/projects.json' "$README"
grep -Fq 'run_completed' "$README"
grep -Fq '.integrated == .total' "$README"
grep -Fq '.git/harness-ledger/' "$README" "$HTML"
grep -Fq '.git/harness-evidence/' "$README" "$HTML"

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

# v3 clean break surfaced on README and site
grep -Fq 'v3.0 is a clean break' "$README"
grep -Fq 'v3.0 is a clean break' "$HTML"
grep -Fq 'Confirm is required before mutation' "$HTML"

# README file structure examples
grep -Fq 'id="AC-001"' "$README"
grep -Fq 'WI-AC-001' "$README"

# init.sh lifecycle contract surfaced on the site
grep -Fq 'start|stop|restart|status|help' "$HTML"
grep -Fq 'start|stop|restart|status|help' "$README"

# Site: plan integration branch model (not Goal Review on main)
grep -Fq 'plan integration branch' "$HTML"
! grep -Fq 'Final independent audit of the whole spec on <code>main</code>' "$HTML"
! grep -Fq 'Checks run again after merging into current <code>main</code>' "$HTML"
! grep -Fq 'proves completion on <code>main</code>' "$HTML"

echo 'ok - README is a short quick-start pointing into the complete site, which documents the full workflow, role routing, and background worker monitoring'
