#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
HTML="$ROOT/site/index.html"

test -s "$HTML"
test -s "$ROOT/site/styles.css"
test -s "$ROOT/.github/workflows/pages.yml"

for id in install plugin hermes telegram plan monorepo scaffold run notify verify operate files; do
  grep -q "id=\"$id\"" "$HTML"
done
while IFS= read -r id; do
  grep -q "id=\"$id\"" "$HTML"
done < <(sed -n 's/.*href="#\([^"]*\)".*/\1/p' "$HTML")

grep -q 'assets/banner.svg' "$HTML"
grep -q -- '--cli opencode --no' "$HTML"
grep -q '/harness-planner' "$HTML"
grep -q '/harness-generator' "$HTML"
grep -q '/harness-setup' "$HTML"
grep -q '.harness/projects.json' "$HTML"
grep -q 'apps/web/project_specs.xml' "$HTML"
grep -q 'goal:true' "$HTML"
grep -q 'path: site' "$ROOT/.github/workflows/pages.yml"
grep -q 'actions/deploy-pages@v4' "$ROOT/.github/workflows/pages.yml"
! grep -Eq '(href|src)="/[^/]+' "$HTML"

echo 'ok - static site documents the Hermes, Telegram, and OpenCode setup path'
