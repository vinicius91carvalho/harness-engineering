#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP=${TMPDIR:-/tmp}/harness-orchestrator-test.$$
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/work"
cat >"$TMP/work/feature_list.json" <<'JSON'
[{"id":"F1","context":"core","description":"works","implementation":false,"qa":false}]
JSON
cat >"$TMP/bin/claude" <<'SH'
#!/bin/sh
set -eu
count_file="$PWD/.calls"; count=0; [ ! -f "$count_file" ] || count=$(cat "$count_file")
count=$((count + 1)); echo "$count" >"$count_file"
prompt=""; for arg in "$@"; do prompt=$arg; done
tmp="$PWD/feature_list.json.tmp"
if printf '%s' "$prompt" | grep -q 'CODING'; then
  # First coding response lies. The state machine must inspect the file and retry.
  [ "$count" -gt 1 ] && jq 'map(if .id=="F1" then .implementation=true else . end)' feature_list.json >"$tmp" && mv "$tmp" feature_list.json
else
  jq 'map(if .id=="F1" and .implementation==true then .qa=true else . end)' feature_list.json >"$tmp" && mv "$tmp" feature_list.json
fi
printf '{"ok":true}\n'
SH
chmod +x "$TMP/bin/claude"

NODE=$(command -v node)
PATH="$TMP/bin:$(dirname "$NODE"):/usr/bin:/bin" "$NODE" "$ROOT/skills/generator/orchestrator.mjs" \
  --host claude --workdir "$TMP/work" --port 5170 --features F1 >"$TMP/result.json"
jq -e '.passed == 1 and .results[0].status == "passed"' "$TMP/result.json" >/dev/null || { cat "$TMP/result.json" >&2; exit 1; }
[ "$(cat "$TMP/work/.calls")" -eq 3 ] || { echo 'not ok - expected retry plus QA' >&2; exit 1; }
echo 'ok - orchestrator retries and trusts feature_list state, not agent output'

if node "$ROOT/skills/generator/orchestrator.mjs" --host invalid --workdir "$TMP/work" --features F1 2>"$TMP/err"; then
  echo 'not ok - invalid host accepted' >&2; exit 1
fi
grep -q 'claude, codex, or opencode' "$TMP/err"
echo 'ok - orchestrator exposes only supported host adapters'
