#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP=${TMPDIR:-/tmp}/harness-reconcile-test.$$
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP"
cat >"$TMP/project_specs.xml" <<'XML'
<project_specification>
  <project_goal>Users can save work.</project_goal>
  <acceptance_checks>
    <acceptance_check id="AC-001" context="foundation" category="foundation" depends_on="">
      <description>The health endpoint returns ready.</description>
    </acceptance_check>
    <acceptance_check id="AC-002" context="editing" category="functional" depends_on="AC-001">
      <description>A user saves a document and sees it after reload.</description>
    </acceptance_check>
  </acceptance_checks>
</project_specification>
XML
printf '[]\n' >"$TMP/feature_list.json"
node "$ROOT/skills/generator/reconcile.mjs" "$TMP" >"$TMP/result.json"
jq -e '.addedWorkItems == 2 and .addedIds == ["AC-001","AC-002"]' "$TMP/result.json" >/dev/null
jq -e 'length == 2 and .[1].acceptance_checks == ["AC-002"] and .[1].depends_on == ["AC-001"] and .[1].integration == false' "$TMP/feature_list.json" >/dev/null
node "$ROOT/skills/generator/reconcile.mjs" "$TMP" --check >/dev/null
echo 'ok - stable Acceptance Checks reconcile deterministically into mapped Work Items'

sed 's/depends_on="AC-001"/depends_on="AC-404"/' "$TMP/project_specs.xml" >"$TMP/bad.xml"
mv "$TMP/bad.xml" "$TMP/project_specs.xml"
if node "$ROOT/skills/generator/reconcile.mjs" "$TMP" --check 2>"$TMP/error"; then
  echo 'not ok - unknown dependency accepted' >&2; exit 1
fi
grep -q 'unknown acceptance check AC-404' "$TMP/error"
echo 'ok - unknown dependencies fail before execution'

sed 's/depends_on="AC-404"/depends_on="AC-001"/' "$TMP/project_specs.xml" >"$TMP/project_specs.fixed"
mv "$TMP/project_specs.fixed" "$TMP/project_specs.xml"
jq 'map(if .id=="WI-AC-001" then del(.acceptance_checks) else . end)' "$TMP/feature_list.json" >"$TMP/feature_list.invalid"
mv "$TMP/feature_list.invalid" "$TMP/feature_list.json"
if node "$ROOT/skills/generator/reconcile.mjs" "$TMP" --check 2>"$TMP/mapping-error"; then
  echo 'not ok - unmapped Work Item accepted' >&2; exit 1
fi
grep -q 'has no Acceptance Check mapping' "$TMP/mapping-error"
echo 'ok - every Work Item must trace to a stable Acceptance Check'
