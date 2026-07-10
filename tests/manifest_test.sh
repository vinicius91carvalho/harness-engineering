#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

# ---- (i) command/trigger parity: docs, skill dirs, and manifests must all agree -----------------
# Every documented `/harness:<name>` command must resolve to a real skills/<name>/ dir whose
# frontmatter `name:` matches, and every skill dir's frontmatter must match its own dirname (the
# convention every manifest below relies on to discover skills).

documented=$(grep -ohE '/harness:[a-z][a-z-]*' README.md site/index.html | sed 's#/harness:##' | sort -u)
test -n "$documented"

for name in $documented; do
  skill="skills/$name/SKILL.md"
  test -f "$skill" || { echo "not ok - documented /harness:$name has no skills/$name/SKILL.md" >&2; exit 1; }
  grep -q "^name: $name\$" "$skill" || { echo "not ok - skills/$name/SKILL.md frontmatter name != $name" >&2; exit 1; }
  # site/index.html must document everything README does, and vice versa (single source of truth).
  grep -Fq "/harness:$name" README.md || { echo "not ok - /harness:$name missing from README.md" >&2; exit 1; }
  grep -Fq "/harness:$name" site/index.html || { echo "not ok - /harness:$name missing from site/index.html" >&2; exit 1; }
done
echo 'ok - every documented /harness:<name> command resolves to a matching skill'

for dir in skills/*/; do
  name=$(basename "$dir")
  skill="$dir/SKILL.md"
  test -f "$skill" || { echo "not ok - $dir has no SKILL.md" >&2; exit 1; }
  grep -q "^name: $name\$" "$skill" || { echo "not ok - $skill frontmatter name != directory name $name" >&2; exit 1; }
done
echo 'ok - every skill directory name matches its own SKILL.md frontmatter name'

# Manifests: each surface that fans a skill out into a runnable command keys off this same
# skills/<name>/ convention. Claude discovers skills/ by directory convention once the plugin
# identifies itself; Codex points an explicit field at the directory; OpenCode's installer projects
# skills/*/SKILL.md through scripts/install-reconcile.mjs rather than listing names in opencode.json.
test "$(jq -r .name .claude-plugin/plugin.json)" = "harness"
test "$(jq -r .skills .codex-plugin/plugin.json)" = "./skills/"
test -d "$(jq -r .skills .codex-plugin/plugin.json)"
test "$(jq -r .skills .cursor-plugin/plugin.json)" = "./skills/"
test -d "$(jq -r .skills .cursor-plugin/plugin.json)"
test -f opencode.json
jq empty opencode.json
grep -q 'project-harness-opencode' install.sh
grep -q 'SKILL.md' scripts/install-reconcile.mjs
node scripts/install-reconcile.mjs validate >/dev/null
echo 'ok - Claude, Codex, Cursor Agent, and OpenCode manifests all key off the same skills/ directory convention'

# ---- (ii) verdict parsing: both runtime scripts must import the shared lib ----
GEN=skills/generator/orchestrator.mjs
SUP=skills/supervisor/scripts/harness-control.mjs
LIB=skills/generator/lib/verdict.mjs
grep -q "from './lib/verdict.mjs'" "$GEN" || { echo "not ok - $GEN must import ./lib/verdict.mjs" >&2; exit 1; }
grep -q "importLib('verdict.mjs')" "$SUP" || grep -q "lib/verdict.mjs" "$SUP" || { echo "not ok - $SUP must load skills/generator/lib/verdict.mjs" >&2; exit 1; }
grep -q 'export function parseObject' "$LIB" || { echo "not ok - $LIB must export parseObject" >&2; exit 1; }
echo 'ok - verdict parsing is centralized in skills/generator/lib/verdict.mjs'

echo 'ok - manifest and parseObject parity guards passed'
