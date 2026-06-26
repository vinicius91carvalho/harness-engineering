#!/usr/bin/env bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SYSTEM_NODE=$(command -v node || true)
TMP=${TMPDIR:-/tmp}/harness-installer-test.$$
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/home"

for cli in claude codex opencode; do
  cat >"$TMP/bin/$cli" <<'EOF'
#!/bin/sh
printf '%s %s\n' "$(basename "$0")" "$*" >>"$HARNESS_TEST_LOG"
EOF
  chmod +x "$TMP/bin/$cli"
done

export PATH="$TMP/bin:/usr/bin:/bin"
export HOME="$TMP/home"
export HARNESS_TEST_LOG="$TMP/commands.log"

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

if "$ROOT/install.sh" --no </dev/null >"$TMP/out" 2>"$TMP/err"; then
  fail 'multiple CLIs without --cli must fail without a TTY'
fi
grep -q -- '--cli' "$TMP/err" || fail 'no-TTY error should explain --cli'
pass 'multiple CLIs require an explicit non-interactive host'

if "$ROOT/install.sh" --cli codex --scope user --no </dev/null >"$TMP/out" 2>"$TMP/err"; then
  fail '--scope must be rejected for non-Claude selections'
fi
grep -q 'only valid.*Claude' "$TMP/err" || fail 'scope error should identify Claude restriction'
pass 'scope is Claude-only'

: >"$HARNESS_TEST_LOG"
before=$(find "$HOME" -mindepth 1 -print | sort)
"$ROOT/install.sh" --cli all --yes --dry-run </dev/null >"$TMP/out"
after=$(find "$HOME" -mindepth 1 -print | sort)
[ "$before" = "$after" ] || fail 'dry-run wrote into HOME'
[ ! -s "$HARNESS_TEST_LOG" ] || fail 'dry-run executed a host command'
grep -q 'codebase-memory-mcp' "$TMP/out" || fail 'dry-run should describe memory integration'
pass 'dry-run performs no writes or host commands'

: >"$HARNESS_TEST_LOG"
"$ROOT/install.sh" --cli claude --no </dev/null >"$TMP/out"
grep -q '^claude plugin marketplace' "$HARNESS_TEST_LOG" || fail 'Claude marketplace command missing'
grep -q '^claude plugin install harness@vinicius91carvalho --scope user$' "$HARNESS_TEST_LOG" || fail 'Claude plugin command is not native'
if grep -Eq '^(codex|opencode) ' "$HARNESS_TEST_LOG"; then fail 'unselected host was invoked'; fi
pass 'only the selected Claude host is changed'

: >"$HARNESS_TEST_LOG"
"$ROOT/install.sh" --cli codex --no </dev/null >"$TMP/out"
grep -q '^codex plugin marketplace' "$HARNESS_TEST_LOG" || fail 'Codex marketplace command missing'
grep -q '^codex plugin add harness@harness-engineering$' "$HARNESS_TEST_LOG" || fail 'Codex plugin add command missing'
if grep -Eq '^(claude|opencode) ' "$HARNESS_TEST_LOG"; then fail 'unselected host was invoked'; fi
pass 'only the selected Codex host is changed'

: >"$HARNESS_TEST_LOG"
"$ROOT/install.sh" --cli opencode --no </dev/null >"$TMP/out"
test -f "$HOME/.config/opencode/skills/harness-generator/SKILL.md" || fail 'OpenCode namespaced skill missing'
test -f "$HOME/.config/opencode/agents/harness-coding-agent.md" || fail 'OpenCode namespaced agent missing'
test -f "$HOME/.config/opencode/commands/harness-generator.md" || fail 'OpenCode namespaced command missing'
first=$(find "$HOME/.config/opencode" -type f -exec sha256sum {} \; | sort | sha256sum)
"$ROOT/install.sh" --cli opencode --no </dev/null >"$TMP/out"
second=$(find "$HOME/.config/opencode" -type f -exec sha256sum {} \; | sort | sha256sum)
[ "$first" = "$second" ] || fail 'repeated OpenCode install is not idempotent'
[ ! -s "$HARNESS_TEST_LOG" ] || fail 'OpenCode asset install should not invoke another host'
pass 'OpenCode assets are namespaced and idempotent'

if [ -n "$SYSTEM_NODE" ]; then
  printf '%s\n' '{ // comment' '  "url": "https://example.test/a//b",' '  "items": [1, 2,], /* block */' '}' \
    | "$SYSTEM_NODE" "$ROOT/scripts/jsonc-normalize.js" >"$TMP/normalized.json"
  jq -e '.url == "https://example.test/a//b" and .items == [1,2]' "$TMP/normalized.json" >/dev/null || fail 'JSONC normalization corrupted user values'
  pass 'JSONC normalization preserves strings and accepts comments/trailing commas'
fi

grep -q 'Digital-Process-Tools/claude-remember' "$ROOT/.claude-plugin/marketplace.json" || fail 'Claude remember plugin is missing'
if grep -q '"name": "remember"' "$ROOT/.agents/plugins/marketplace.json"; then fail 'remember must remain Claude-only'; fi
if grep -q 'codebase-memory-mcp' "$ROOT/.claude-plugin/marketplace.json"; then
  fail 'memory MCP must not be represented as a marketplace plugin'
fi
pass 'plugin catalogs keep remember Claude-only and memory out of marketplaces'
