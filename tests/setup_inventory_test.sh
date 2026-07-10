#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP=${TMPDIR:-/tmp}/harness-setup-inventory-test.$$
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/repo/docs/handbook" "$TMP/repo/src/connectors" "$TMP/repo/infra"

printf '%s\n' 'Clerk auth. Optional Stripe billing degrades to free plans. Anthropic AI, Hindsight memory, and Composio connectors. Legacy docs name Firebase; current code uses PostgreSQL.' >"$TMP/repo/docs/handbook/platforms.md"
printf '%s\n' '{"dependencies":{"@clerk/backend":"1","stripe":"1","@anthropic-ai/sdk":"1","hindsight-client":"1","composio-core":"1"}}' >"$TMP/repo/package.json"
printf '%s\n' 'STRIPE_API_KEY=' >"$TMP/repo/.env.example"
printf '%s\n' "import * as cdk from 'aws-cdk-lib'" >"$TMP/repo/infra/app.ts"
printf '%s\n' "export const database = 'postgresql'" >"$TMP/repo/src/connectors/database.ts"

cat >"$TMP/repo/.harness-technology-inventory.json" <<'JSON'
{"technologies":[
  {"name":"Clerk","section":"integrations","evidence":[{"path":"package.json","kind":"manifest"}]},
  {"name":"Stripe","section":"integrations","evidence":[{"path":".env.example","kind":"configuration"}]},
  {"name":"Anthropic","section":"integrations","evidence":[{"path":"docs/handbook/platforms.md","kind":"documentation"}]},
  {"name":"Hindsight","section":"integrations","evidence":[{"path":"package.json","kind":"manifest"}]},
  {"name":"AWS CDK","section":"technology_stack","evidence":[{"path":"infra/app.ts","kind":"iac"}]},
  {"name":"Composio","section":"integrations","evidence":[{"path":"package.json","kind":"manifest"}]},
  {"name":"PostgreSQL","section":"technology_stack","evidence":[{"path":"src/connectors/database.ts","kind":"adapter"}]}
],"contradictions":[{"documentation":"legacy database","implementation":"PostgreSQL","resolution":"implementation prevails; docs stale"}]}
JSON

node "$ROOT/skills/setup/inventory.mjs" "$TMP/repo" .harness-technology-inventory.json --inventory-only >/dev/null
printf '<project_specification><technology_stack>PostgreSQL</technology_stack><integrations>Clerk</integrations><prerequisites/></project_specification>\n' >"$TMP/repo/project_specs.xml"
if node "$ROOT/skills/setup/inventory.mjs" "$TMP/repo" 2>"$TMP/error"; then
  echo 'not ok - incomplete integration inventory accepted' >&2; exit 1
fi
grep -q 'Stripe \[integrations\] (.env.example)' "$TMP/error"
grep -q 'AWS CDK \[technology_stack\] (infra/app.ts)' "$TMP/error"

names='Clerk Stripe Anthropic Hindsight Composio'
resolution='implementation prevails; docs stale'
printf '<project_specification><technology_stack>AWS CDK PostgreSQL</technology_stack><integrations>%s<contradictions>%s</contradictions></integrations><prerequisites/></project_specification>\n' "$names" "$resolution" >"$TMP/repo/project_specs.xml"
node "$ROOT/skills/setup/inventory.mjs" "$TMP/repo" >/dev/null
grep -q 'spec review HTML loop' "$ROOT/skills/setup/SKILL.md"
grep -q 'spec-review.mjs' "$ROOT/skills/planner/SKILL.md"
grep -q 'failure_behavior' "$ROOT/skills/planner/project_specs.template.xml"
grep -q 'planning_decisions' "$ROOT/skills/planner/project_specs.template.xml"
grep -q '<domain>' "$ROOT/skills/planner/project_specs.template.xml"
grep -q 'Ready Gate' "$ROOT/skills/grilling/SKILL.md"
grep -q 'ambiguous requirements' "$ROOT/skills/planner/SKILL.md"
echo 'ok - setup checks a repository-derived integration inventory'
