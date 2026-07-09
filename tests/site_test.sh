#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
HTML="$ROOT/site/index.html"
README="$ROOT/README.md"
ROLES="$ROOT/omnigent/harness-engineering/roles.example.json"
ROLES_URL='https://github.com/vinicius91carvalho/harness-engineering/blob/main/omnigent/harness-engineering/roles.example.json'

test -s "$HTML"
test -s "$ROOT/site/styles.css"
test -s "$ROOT/.github/workflows/pages.yml"

for id in why architecture language journey delegate workflow phases prerequisites install commands start worked-example add-feature files spec-format queue-format runtime-state monorepo operate troubleshoot advanced omnigent routing run-omnigent mobile maintenance help; do
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
grep -Fq 'run setup **without a goal, feature, scope, or other text**' "$README"
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
grep -Fq '<strong>route coding, validation, repair planning, and Goal Review to ordered tool/model candidates;</strong>' "$HTML"
grep -Fq 'https://omnigent.ai/' "$README" "$HTML"
grep -Fq 'https://tailscale.com/' "$README" "$HTML"
grep -Fq 'https://developers.openai.com/codex/' "$README" "$HTML"
grep -Fq 'Grilling is a planner capability' "$ROOT/skills/planner/SKILL.md"
grep -Fq 'Do not tell them to validate every mapped' "$ROOT/skills/setup/SKILL.md"
grep -Fq 'not required to plan' "$README"
grep -Fq 'without Omnigent' "$HTML"
for str in 'ignores the AGENT spec' '--harness opencode' 'worker route' 'omnigent-ai/omnigent/issues/1816' 'Tailscale Magic DNS hostname' '127.0.0.1' 'localhost:6767' 'omnigent stop' 'owns the runner in-process'; do
  grep -Fq -- "$str" "$HTML"
done
grep -Fq 'Background server already running' "$HTML"
# The obsolete, incorrect port must NOT appear in the mobile flow:
! grep -Fq 'localhost:8000' "$HTML"

# README no longer embeds the routing JSON inline (short pointer + link instead);
# the site keeps the full, verified-against-source block.
diff -u <(jq -S . "$ROLES") <(
  sed -n '/id="routing"/,/id="run-omnigent"/p' "$HTML" |
    sed -n '/<pre><code>{/,/}<\/code><\/pre>/p' |
    sed '1s/.*<pre><code>//; $s/<\/code><\/pre>.*//' |
    jq -S .
)

# README points into the full guide's advanced sections instead of duplicating them:
for anchor in omnigent routing mobile monorepo; do
  grep -Fq "vinicius91carvalho.github.io/harness-engineering/#$anchor" "$README"
done

for file in "$README" "$HTML"; do
  grep -Fq "$ROLES_URL" "$file"
  grep -Fq '.harness/projects.json' "$file"
  grep -Fq 'run_completed' "$file"
  grep -Fq 'implementation and .qa and .integration' "$file"
done

# The "one front door" decision table and the symptom->action troubleshoot table
# must use matching wording between README and the site.
for str in 'A long unattended run with monitoring/pause/resume' 'To independently re-audit an already-integrated main' 'An existing working app, just adopting the harness (no new goal)' '(existing-codebase mode)' 'still draining its retry queue (up to 5 attempts per context)' 'HARNESS_LEASE_TIMEOUT_SECONDS'; do
  grep -Fq -- "$str" "$README"
  grep -Fq -- "$str" "$HTML"
done

grep -q 'sudo tailscale serve --bg http://localhost:6767' "$HTML"
# The obsolete pre-1.52 syntax must NOT appear:
! grep -Fq 'serve https / http://' "$HTML"
! grep -Eq 'Hermes|Telegram' "$HTML"

echo 'ok - README is a short quick-start pointing into the complete site, which documents the full workflow and optional Omnigent routing'
