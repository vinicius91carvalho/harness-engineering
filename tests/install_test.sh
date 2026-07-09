#!/usr/bin/env bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SYSTEM_NODE=$(command -v node || true)
TMP=${TMPDIR:-/tmp}/harness-installer-test.$$
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/home"

for cli in claude codex opencode pi agent; do
  cat >"$TMP/bin/$cli" <<'EOF'
#!/bin/sh
printf '%s %s\n' "$(basename "$0")" "$*" >>"$HARNESS_TEST_LOG"
EOF
  chmod +x "$TMP/bin/$cli"
done
for cli in omni codebase-memory-mcp; do
  cat >"$TMP/bin/$cli" <<'EOF'
#!/bin/sh
printf '%s %s\n' "$(basename "$0")" "$*" >>"$HARNESS_TEST_LOG"
EOF
  chmod +x "$TMP/bin/$cli"
done

export PATH="$TMP/bin:/usr/bin:/bin"
export HOME="$TMP/home"
export XDG_CONFIG_HOME="$TMP/home/.config"
export HARNESS_TEST_LOG="$TMP/commands.log"

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

mkdir -p "$TMP/nonode"
ln -s "$(command -v dirname)" "$TMP/nonode/dirname"
if PATH="$TMP/nonode" "$ROOT/install.sh" --cli opencode --no --dry-run >"$TMP/out" 2>"$TMP/err"; then
  fail 'missing Node.js must fail before installation'
fi
grep -q 'Node.js 18 or newer' "$TMP/err" || fail 'missing Node.js error should state the requirement'

cat >"$TMP/bin/node" <<'EOF'
#!/bin/sh
printf '17\n'
EOF
chmod +x "$TMP/bin/node"
if "$ROOT/install.sh" --cli opencode --no --dry-run >"$TMP/out" 2>"$TMP/err"; then
  fail 'Node.js older than 18 must fail before installation'
fi
grep -q 'Node.js 18 or newer' "$TMP/err" || fail 'old Node.js error should state the requirement'
rm "$TMP/bin/node"
[ -n "$SYSTEM_NODE" ] || fail 'installer tests require a current Node.js runtime'
ln -s "$SYSTEM_NODE" "$TMP/bin/node"
pass 'installer requires Node.js 18 or newer'

if "$ROOT/install.sh" --no </dev/null >"$TMP/out" 2>"$TMP/err"; then
  fail 'multiple CLIs without --cli must fail without a TTY'
fi
grep -q -- '--cli' "$TMP/err" || fail 'no-TTY error should explain --cli'
pass 'multiple CLIs require an explicit non-interactive host'

mv "$TMP/bin/opencode" "$TMP/bin/opencode.off"
mkdir -p "$HOME/.opencode/bin"
printf '#!/bin/sh\n' >"$HOME/.opencode/bin/opencode"
chmod +x "$HOME/.opencode/bin/opencode"
"$ROOT/install.sh" --cli opencode --no --dry-run </dev/null >"$TMP/out"
grep -q 'complete for:opencode' "$TMP/out" || fail 'OpenCode fallback install was not selected'
mv "$TMP/bin/opencode.off" "$TMP/bin/opencode"
rm -rf "$HOME/.opencode"
pass 'OpenCode is detected in its official user install directory'

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
grep -q 'configure context7 MCP for:claude codex opencode pi agent' "$TMP/out" || fail 'Context7 should target every host'
grep -q 'configure playwright MCP for:claude codex opencode pi agent' "$TMP/out" || fail 'Playwright should target every host'
grep -q 'MCP inventory for:claude codex opencode pi agent' "$TMP/out" || fail 'MCP inventory should target every selected host'
grep -q 'marketplace upgrade ponytail' "$TMP/out" || fail 'Codex Ponytail marketplace should be idempotent'
grep -q 'plugin add ponytail@ponytail' "$TMP/out" || fail 'Codex Ponytail should use its upstream marketplace'
pass 'dry-run performs no writes or host commands'

: >"$HARNESS_TEST_LOG"
"$ROOT/install.sh" --cli claude --no </dev/null >"$TMP/out"
grep -q '^claude plugin marketplace' "$HARNESS_TEST_LOG" || fail 'Claude marketplace command missing'
grep -q '^claude plugin update harness@harness-engineering --scope user$' "$HARNESS_TEST_LOG" || fail 'Claude plugin refresh command is missing'
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
test -f "$HOME/.config/opencode/skills/harness-setup/SKILL.md" || fail 'OpenCode setup skill missing'
test -f "$HOME/.config/opencode/agents/harness-coding-agent.md" || fail 'OpenCode namespaced agent missing'
test -f "$HOME/.config/opencode/commands/harness-generator.md" || fail 'OpenCode namespaced command missing'
test -f "$HOME/.config/opencode/commands/harness-setup.md" || fail 'OpenCode setup command missing'
first=$(find "$HOME/.config/opencode" -type f -exec shasum -a 256 {} \; | sort | shasum -a 256)
"$ROOT/install.sh" --cli opencode --no </dev/null >"$TMP/out"
second=$(find "$HOME/.config/opencode" -type f -exec shasum -a 256 {} \; | sort | shasum -a 256)
[ "$first" = "$second" ] || fail 'repeated OpenCode install is not idempotent'
[ ! -s "$HARNESS_TEST_LOG" ] || fail 'OpenCode asset install should not invoke another host'
pass 'OpenCode assets are namespaced and idempotent'

: >"$HARNESS_TEST_LOG"
"$ROOT/install.sh" --cli agent --no </dev/null >"$TMP/out"
test -f "$HOME/.cursor/plugins/local/harness/.cursor-plugin/plugin.json" || fail 'Cursor Agent plugin manifest missing'
test -f "$HOME/.cursor/plugins/local/harness/skills/generator/SKILL.md" || fail 'Cursor Agent generator skill missing'
test -f "$HOME/.cursor/plugins/local/harness/commands/harness-generator.md" || fail 'Cursor Agent harness command missing'
first=$(find "$HOME/.cursor/plugins/local/harness" -type f -exec shasum -a 256 {} \; | sort | shasum -a 256)
"$ROOT/install.sh" --cli agent --no </dev/null >"$TMP/out"
second=$(find "$HOME/.cursor/plugins/local/harness" -type f -exec shasum -a 256 {} \; | sort | shasum -a 256)
[ "$first" = "$second" ] || fail 'repeated Cursor Agent install is not idempotent'
[ ! -s "$HARNESS_TEST_LOG" ] || fail 'Cursor Agent asset install should not invoke another host'
pass 'Cursor Agent assets are local-plugin installed and idempotent'

: >"$HARNESS_TEST_LOG"
"$ROOT/install.sh" --cli pi --no </dev/null >"$TMP/out"
test -f "$HOME/.agents/skills/planner/SKILL.md" || fail 'Pi user-level planner skill missing'
test -f "$HOME/.agents/skills/generator/SKILL.md" || fail 'Pi user-level generator skill missing'
test -f "$HOME/.agents/skills/grilling/SKILL.md" || fail 'Pi user-level grilling skill missing'
grep -Eq '^pi remove ' "$HARNESS_TEST_LOG" || fail 'Pi install should remove a prior package clone'
if grep -Eq '^pi install ' "$HARNESS_TEST_LOG"; then fail 'Pi must not package-install into ~/.pi/agent/git'; fi
if grep -Eq '^(claude|codex|opencode) ' "$HARNESS_TEST_LOG"; then fail 'unselected host was invoked'; fi
pass 'Pi installs harness skills at the user skill root'

: >"$HARNESS_TEST_LOG"
test -f "$ROOT/config/roles.example.json" || fail 'roles.example.json missing from config/'
jq -e '
  ([.coding,.validation,.repairPlanning,.goalReview,.noCredits] | all(length > 0)) and
  ([.coding[],.validation[],.repairPlanning[],.goalReview[],.noCredits[]] |
    all((if type == "string" then . else .harness end) as $h |
      ["claude","codex","opencode","pi","agent"] | index($h)))
' "$ROOT/config/roles.example.json" >/dev/null || fail 'roles.example.json schema invalid'
pass 'config/roles.example.json is present and valid'

if [ -n "$SYSTEM_NODE" ]; then
  printf '%s\n' '{ // comment' '  "url": "https://example.test/a//b",' '  "items": [1, 2,], /* block */' '}' \
    | "$SYSTEM_NODE" "$ROOT/scripts/jsonc-normalize.js" >"$TMP/normalized.json"
  jq -e '.url == "https://example.test/a//b" and .items == [1,2]' "$TMP/normalized.json" >/dev/null || fail 'JSONC normalization corrupted user values'
  pass 'JSONC normalization preserves strings and accepts comments/trailing commas'
fi

if grep -q 'codebase-memory-mcp' "$ROOT/.claude-plugin/marketplace.json"; then
  fail 'memory MCP must not be represented as a marketplace plugin'
fi
if grep -Eq 'skill-creator|hookify|claude-md-management|claude-code-setup|ralph-loop|typescript-lsp|pyright-lsp|rust-analyzer-lsp|"name": "remember"|"name": "codex"' "$ROOT/.claude-plugin/marketplace.json"; then
  fail 'Claude-only plugins must not remain in the marketplace'
fi
pass 'plugin catalogs keep memory and Claude-only integrations out of marketplaces'

if grep -q 'BRIGHTDATA_TOKEN' "$ROOT/.mcp.json" "$ROOT/.codex-plugin/mcp.json"; then
  fail 'active MCP manifests must not install unresolved Bright Data secrets'
fi
grep -q 'BRIGHTDATA_TOKEN' "$ROOT/config/mcp.json" || fail 'Bright Data must remain in the prompted MCP inventory'
pass 'secret-backed MCP servers are installed only through the prompted inventory'

# Regression: a "remote" install (no local checkout next to install.sh, as with
# `curl | sh`) clones into a temp dir that its own cleanup trap deletes on
# exit. The statusline command must survive that cleanup, so it has to be a
# persistent copy rather than a path into the ephemeral clone.
: >"$HARNESS_TEST_LOG"
mkdir -p "$TMP/remote" "$TMP/systmp"
cp "$ROOT/install.sh" "$TMP/remote/install.sh"
chmod +x "$TMP/remote/install.sh"
export GIT_STUB_LOG="$TMP/git.log"
: >"$GIT_STUB_LOG"
cat >"$TMP/bin/git" <<EOF
#!/bin/sh
printf '%s\n' "git \$*" >>"\$GIT_STUB_LOG"
if [ "\$1" = clone ]; then
  dest=
  for arg in "\$@"; do dest="\$arg"; done
  mkdir -p "\$dest"
  cp -R "$ROOT/." "\$dest/"
elif [ "\$1" = ls-remote ]; then
  printf '0123456789abcdef\trefs/tags/v2.0.0\n'
else
  echo "unsupported git invocation: \$*" >&2
  exit 1
fi
EOF
chmod +x "$TMP/bin/git"
TMPDIR="$TMP/systmp" VERSION=v2.0.0 "$TMP/remote/install.sh" --cli claude --yes </dev/null >"$TMP/out" 2>"$TMP/err" \
  || fail 'remote-style install should succeed'
grep -q -- '--branch v2.0.0' "$GIT_STUB_LOG" || fail 'remote install must clone the pinned release tag'
grep -q 'staging release v2.0.0' "$TMP/out" "$TMP/err" || fail 'remote install should announce the staged release tag'
cmd=$(jq -r '.statusLine.command' "$HOME/.claude/settings.json")
script_path=${cmd#bash }
[ -f "$script_path" ] || fail 'statusline script must survive installer temp-dir cleanup'
cmp -s "$script_path" "$ROOT/scripts/statusline.sh" || fail 'persisted statusline script must match the bundled one'
[ -z "$(find "$TMP/systmp" -mindepth 1 -maxdepth 1 -name 'harness-installer.*' 2>/dev/null)" ] \
  || fail 'installer temp clone should have been cleaned up'
pass 'statusline persists after the installer cleans up its temp clone'

"$ROOT/install.sh" --help >"$TMP/out" 2>&1 || fail '--help should succeed'
grep -q -- '--version' "$TMP/out" || fail 'help should document --version'
pass 'help documents --version'

mkdir -p "$TMP/remote-dry" "$TMP/systmp2"
cp "$ROOT/install.sh" "$TMP/remote-dry/install.sh"
chmod +x "$TMP/remote-dry/install.sh"
export GIT_STUB_LOG="$TMP/git-dry.log"
: >"$GIT_STUB_LOG"
TMPDIR="$TMP/systmp2" "$TMP/remote-dry/install.sh" --cli claude --yes --dry-run </dev/null >"$TMP/out" 2>"$TMP/err" \
  || fail 'remote dry-run should succeed'
grep -q 'DRY RUN — git clone --depth 1 --branch' "$TMP/out" || fail 'remote dry-run should show tagged clone'
pass 'remote dry-run announces release-tag staging'

# Regression: Codex's native status line is a config.toml upsert, not a
# script. Cover a fresh file, an existing [tui] table with unrelated keys
# (TOML forbids redefining a table, so this is the riskiest surface), and
# idempotent re-runs.
: >"$HARNESS_TEST_LOG"
rm -rf "$HOME/.codex"
"$ROOT/install.sh" --cli codex --yes </dev/null >"$TMP/out" 2>"$TMP/err" || fail 'Codex --yes install should succeed'
grep -q '^\[tui\]$' "$HOME/.codex/config.toml" || fail 'fresh Codex config should gain a [tui] table'
grep -q '^status_line = \["model", "current-dir", "git-branch", "context-used", "five-hour-limit", "weekly-limit"\]$' \
  "$HOME/.codex/config.toml" || fail 'fresh Codex config should gain the expected status_line array'
pass 'Codex status line is added to a fresh config.toml'

cat >"$HOME/.codex/config.toml" <<'EOF'
model = "gpt-5"

[tui]
theme = "dark"
animations = true

[sandbox]
mode = "workspace-write"
EOF
"$ROOT/install.sh" --cli codex --yes </dev/null >"$TMP/out" 2>"$TMP/err" || fail 'Codex install on an existing config should succeed'
[ "$(grep -c '^\[tui\]$' "$HOME/.codex/config.toml")" = 1 ] || fail 'existing [tui] table must not be duplicated'
[ "$(grep -c '^status_line = ' "$HOME/.codex/config.toml")" = 1 ] || fail 'status_line must appear exactly once'
grep -q '^theme = "dark"$' "$HOME/.codex/config.toml" || fail 'unrelated existing tui keys must survive'
grep -q '^\[sandbox\]$' "$HOME/.codex/config.toml" || fail 'other tables must survive'
awk '/^\[tui\]/{t=1} /^\[sandbox\]/{s=1} t && !s && /^status_line = /{found=1} END{exit !found}' \
  "$HOME/.codex/config.toml" || fail 'status_line must be inserted inside the existing [tui] table, before [sandbox]'
pass 'Codex status line is inserted into an existing [tui] table without disturbing it'

first=$(shasum -a 256 "$HOME/.codex/config.toml")
"$ROOT/install.sh" --cli codex --yes </dev/null >"$TMP/out" 2>"$TMP/err" || fail 'repeated Codex install should succeed'
second=$(shasum -a 256 "$HOME/.codex/config.toml")
[ "$first" = "$second" ] || fail 'repeated Codex status-line install is not idempotent'
pass 'Codex status line install is idempotent'
