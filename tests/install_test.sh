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
for cli in omni; do
  cat >"$TMP/bin/$cli" <<'EOF'
#!/bin/sh
printf '%s %s\n' "$(basename "$0")" "$*" >>"$HARNESS_TEST_LOG"
EOF
  chmod +x "$TMP/bin/$cli"
done
for tool in pip pip3 crawl4ai-setup crawl4ai-doctor npx curl git; do
  cat >"$TMP/bin/$tool" <<'EOF'
#!/bin/sh
printf '%s %s\n' "$(basename "$0")" "$*" >>"$HARNESS_TEST_LOG"
exit 0
EOF
  chmod +x "$TMP/bin/$tool"
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

if "$ROOT/install.sh" --cli codex --scope local --no </dev/null >"$TMP/out" 2>"$TMP/err"; then
  fail '--scope local must be rejected for non-Claude selections'
fi
grep -q 'local is only valid when Claude' "$TMP/err" || fail 'local scope error should identify Claude restriction'
pass 'local scope is Claude-only'

: >"$HARNESS_TEST_LOG"
before=$(find "$HOME" -mindepth 1 -print | sort)
"$ROOT/install.sh" --cli all --yes --dry-run </dev/null >"$TMP/out"
after=$(find "$HOME" -mindepth 1 -print | sort)
[ "$before" = "$after" ] || fail 'dry-run wrote into HOME'
[ ! -s "$HARNESS_TEST_LOG" ] || fail 'dry-run executed a host command'
grep -q 'configure playwright MCP for:claude codex opencode pi agent (scope: user)' "$TMP/out" || fail 'Playwright should target every host'
grep -q 'pip install -U crawl4ai' "$TMP/out" || fail 'Crawl4AI pip install should appear in dry-run'
grep -q "install crawl4ai skill to $HOME/.claude/skills/crawl4ai" "$TMP/out" || fail 'Crawl4AI Claude skill install should appear in dry-run'
grep -q 'npx skills add nutlope/hallmark --skill hallmark -g --yes' "$TMP/out" || fail 'user-scope hallmark must use -g'

grep -q 'curl -fsSL https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.sh | sh' "$TMP/out" || fail 'no-mistakes installer should appear in dry-run'
grep -q 'no-mistakes init in each repository' "$TMP/out" || fail 'no-mistakes init follow-up should appear in dry-run'
grep -q 'curl -fsSL https://kunchenguid.github.io/treehouse/install.sh | sh' "$TMP/out" || fail 'treehouse installer should appear in dry-run'
pass 'dry-run performs no writes or host commands'

PROJECT=$TMP/project
mkdir -p "$PROJECT"
# Match install.sh resolve_project_dir (pwd -P on macOS avoids /var vs /private/var drift).
if PROJECT=$(CDPATH= cd -- "$PROJECT" && pwd -P 2>/dev/null); then
  :
else
  PROJECT=$(CDPATH= cd -- "$PROJECT" && pwd)
fi
rm -rf "$HOME/.config/opencode" "$HOME/.cursor/plugins/local" "$HOME/.agents/skills"
: >"$HARNESS_TEST_LOG"
before=$(find "$HOME" -mindepth 1 -print | sort)
before_project=$(find "$PROJECT" -mindepth 1 -print 2>/dev/null | sort || true)
"$ROOT/install.sh" --cli opencode --scope project --project-dir "$PROJECT" --yes --dry-run </dev/null >"$TMP/out"
after=$(find "$HOME" -mindepth 1 -print | sort)
after_project=$(find "$PROJECT" -mindepth 1 -print 2>/dev/null | sort || true)
[ "$before" = "$after" ] || fail 'project dry-run wrote into HOME'
[ "$before_project" = "$after_project" ] || fail 'project dry-run wrote into project dir'
[ ! -s "$HARNESS_TEST_LOG" ] || fail 'project dry-run executed a host command'
grep -q "install namespaced OpenCode skills, agents, and commands for harness into $PROJECT/.opencode" "$TMP/out" \
  || fail 'OpenCode project dry-run should target .opencode'
grep -q "cd $PROJECT && npx skills add nutlope/hallmark --skill hallmark --yes" "$TMP/out" \
  || fail 'project scope should install hallmark in project dir without -g'
if grep -q 'npx skills add nutlope/hallmark --skill hallmark -g' "$TMP/out"; then
  fail 'project-scope hallmark must not use -g'
fi
grep -q "cd $PROJECT && no-mistakes init" "$TMP/out" \
  || fail 'project scope should run no-mistakes init in project dir'
grep -q 'skip no-mistakes upstream installer under project scope' "$TMP/out" \
  || fail 'project scope must not run the global no-mistakes installer'
grep -q 'skip crawl4ai pip under project scope' "$TMP/out" \
  || fail 'project scope must not run crawl4ai pip'
if grep -q 'curl -fsSL' "$TMP/out"; then
  fail 'project-scope dry-run must not invoke global curl installers'
fi
grep -q "install crawl4ai skill to $PROJECT/.opencode/skills/crawl4ai" "$TMP/out" \
  || fail 'project-scope crawl4ai skill should target project .opencode'
"$ROOT/install.sh" --cli claude --scope project --project-dir "$PROJECT" --yes --dry-run </dev/null >"$TMP/out"
grep -q 'skipping status-line (user scope only)' "$TMP/out" || fail 'project scope should skip status-line for Claude'
grep -q 'skipping shared-config (user scope only)' "$TMP/out" || fail 'project scope should skip shared-config'
grep -q 'skipping treehouse (user scope only)' "$TMP/out" || fail 'project scope should skip treehouse'
pass 'project-scope dry-run targets project paths and skips user-only extras'

: >"$HARNESS_TEST_LOG"
"$ROOT/install.sh" --cli opencode --scope project --project-dir "$PROJECT" --no </dev/null >"$TMP/out"
test -f "$PROJECT/.opencode/skills/harness-generator/SKILL.md" || fail 'OpenCode project skill missing'
test ! -e "$HOME/.config/opencode/skills/harness-generator/SKILL.md" \
  || fail 'OpenCode project install must not write user config skills'
[ ! -s "$HARNESS_TEST_LOG" ] || fail 'OpenCode project install should not invoke another host'
pass 'OpenCode project scope installs under .opencode'

: >"$HARNESS_TEST_LOG"
"$ROOT/install.sh" --cli agent --scope project --project-dir "$PROJECT" --no </dev/null >"$TMP/out"
test -f "$PROJECT/.cursor/plugins/local/harness/.cursor-plugin/plugin.json" \
  || fail 'Cursor project plugin missing'
test ! -e "$HOME/.cursor/plugins/local/harness/.cursor-plugin/plugin.json" \
  || fail 'Cursor project install must not write user plugin dir'
pass 'Cursor project scope installs under .cursor/plugins/local'

: >"$HARNESS_TEST_LOG"
"$ROOT/install.sh" --cli pi --scope project --project-dir "$PROJECT" --no </dev/null >"$TMP/out"
test -f "$PROJECT/.agents/skills/planner/SKILL.md" || fail 'Pi project planner skill missing'
test ! -e "$HOME/.agents/skills/planner/SKILL.md" || fail 'Pi project install must not write user skills'
if grep -Eq '^pi remove ' "$HARNESS_TEST_LOG"; then fail 'Pi project install must not remove user package clones'; fi
pass 'Pi project scope installs under .agents/skills'

: >"$HARNESS_TEST_LOG"
"$ROOT/install.sh" --cli codex --scope project --project-dir "$PROJECT" --no </dev/null >"$TMP/out"
test -f "$PROJECT/.codex-plugin/plugin.json" || fail 'Codex project plugin manifest missing'
test -f "$PROJECT/.agents/plugins/marketplace.json" || fail 'Codex project marketplace missing'
grep -q "codex plugin marketplace add $PROJECT" "$HARNESS_TEST_LOG" \
  || grep -q "codex plugin marketplace upgrade $PROJECT" "$HARNESS_TEST_LOG" \
  || fail 'Codex project marketplace registration missing'
grep -q '^codex plugin add harness@harness-engineering$' "$HARNESS_TEST_LOG" || fail 'Codex project plugin add missing'
pass 'Codex project scope installs marketplace layout into project'

: >"$HARNESS_TEST_LOG"
"$ROOT/install.sh" --cli claude --scope project --project-dir "$PROJECT" --no </dev/null >"$TMP/out"
grep -q '^claude plugin update harness@harness-engineering --scope project$' "$HARNESS_TEST_LOG" \
  || fail 'Claude project plugin refresh must use --scope project'
pass 'Claude project scope forwards --scope project'

bases=$(node "$ROOT/scripts/install-reconcile.mjs" resolve-install-bases project "$PROJECT")
printf '%s' "$bases" | jq -e --arg p "$PROJECT" '
  .opencode == ($p + "/.opencode") and
  .agentsSkills == ($p + "/.agents/skills") and
  .cursorPluginsLocal == ($p + "/.cursor/plugins/local")
' >/dev/null || fail 'resolve-install-bases project paths mismatch'
node "$ROOT/scripts/install-reconcile.mjs" scopes hallmark | grep -Eq '(^| )project( |$)' \
  || fail 'hallmark scopes should include project'
node "$ROOT/scripts/install-reconcile.mjs" scopes 'status-line' | grep -qx user \
  || fail 'status-line scopes should be user-only'
node "$ROOT/scripts/install-reconcile.mjs" scopes treehouse | grep -qx user \
  || fail 'treehouse scopes should be user-only'
user_only=$(node "$ROOT/scripts/install-reconcile.mjs" user-only-ids)
printf '%s' "$user_only" | grep -Eq '(^| )treehouse( |$)' || fail 'user-only-ids should include treehouse'
printf '%s' "$user_only" | grep -Eq '(^| )status-line( |$)' || fail 'user-only-ids should include status-line'
node "$ROOT/scripts/install-reconcile.mjs" skills-add-args hallmark | jq -e '
  .repo == "nutlope/hallmark" and .skill == "hallmark" and .globalWhenUserScope == true
' >/dev/null || fail 'skills-add-args should project hallmark acquisition from catalog'
pass 'install-reconcile resolves scope bases and module scopes'

# Regression: macOS TMPDIR is /var/folders/... while Node resolves import.meta.url
# to /private/var/...; install-reconcile must still execute as a CLI.
var_sim=$TMP/var-path-sim
mkdir -p "$var_sim/private/var/repo/config" "$var_sim/private/var/repo/scripts" "$var_sim/private/var/repo/skills/generator/lib"
ln -sfn "$var_sim/private/var" "$var_sim/var"
cp "$ROOT/config/installable-catalog.json" "$var_sim/private/var/repo/config/"
cp "$ROOT/scripts/install-reconcile.mjs" "$var_sim/private/var/repo/scripts/"
cp "$ROOT/skills/generator/lib/canonical-path.mjs" "$var_sim/private/var/repo/skills/generator/lib/"
script=$var_sim/var/repo/scripts/install-reconcile.mjs
test -f "$script" || fail 'install-reconcile regression fixture is missing'
hallmark_args=$("$SYSTEM_NODE" "$script" skills-add-args hallmark) \
  || fail 'install-reconcile CLI must run when argv crosses /var -> /private/var symlinks'
printf '%s' "$hallmark_args" | jq -e '.repo == "nutlope/hallmark" and .skill == "hallmark"' >/dev/null \
  || fail 'install-reconcile CLI must return hallmark skills-add-args via symlinked /var paths'
pass 'install-reconcile CLI entry survives macOS-style symlinked temp paths'

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
"$ROOT/install.sh" --cli opencode --no </dev/null >"$TMP/out"
test ! -e "$HOME/.config/opencode/skills/crawl4ai/SKILL.md" \
  || fail 'harness-only install must not include crawl4ai'
test ! -e "$HOME/.config/opencode/skills/crawl4ai" \
  || fail 'harness-only install must not create crawl4ai skill root'
pass 'harness-only install excludes optional package roots'

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
rm -rf "$HOME/.cursor/plugins/local"
# Simulate prior harness pollution under optional plugin dirs.
mkdir -p "$HOME/.cursor/plugins/local/crawl4ai/.cursor-plugin" \
  "$HOME/.cursor/plugins/local/crawl4ai/skills/supervisor"
printf '%s\n' '{"name":"harness"}' >"$HOME/.cursor/plugins/local/crawl4ai/.cursor-plugin/plugin.json"
# --yes would also run crawl4ai pip/setup; project-bundle the skill path directly.
node "$ROOT/scripts/install-reconcile.mjs" project-agent crawl4ai "$ROOT" \
  "$HOME/.cursor/plugins/local/crawl4ai" >/dev/null
"$ROOT/install.sh" --cli agent --no </dev/null >"$TMP/out"
test -f "$HOME/.cursor/plugins/local/harness/skills/supervisor/SKILL.md" \
  || fail 'harness supervisor skill missing after agent install'
test ! -e "$HOME/.cursor/plugins/local/crawl4ai/skills/supervisor" \
  || fail 'crawl4ai must not retain harness supervisor skill'
test -f "$HOME/.cursor/plugins/local/crawl4ai/skills/crawl4ai/SKILL.md" \
  || fail 'crawl4ai skill missing after agent optional-bundle install'
c4_name=$(jq -r .name "$HOME/.cursor/plugins/local/crawl4ai/.cursor-plugin/plugin.json")
[ "$c4_name" = crawl4ai ] || fail "crawl4ai manifest must be crawl4ai, got $c4_name"
if node "$ROOT/scripts/install-reconcile.mjs" project-agent hallmark "$ROOT" "$HOME/.cursor/plugins/local/hallmark" 2>"$TMP/err"; then
  fail 'project-agent must fail closed for external hallmark'
fi
grep -q 'unsupported agent module hallmark' "$TMP/err" \
  || fail 'project-agent hallmark error should explain unsupported module'
pass 'Cursor Agent optional plugins exclude harness skill duplicates'

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
if grep -Eq '"name": "(hallmark|lavish|lavish-axi|no-mistakes|treehouse)"' "$ROOT/.claude-plugin/marketplace.json"; then
  fail 'non-marketplace externals must not be listed in the Claude marketplace'
fi
if grep -Eq 'skill-creator|hookify|claude-md-management|claude-code-setup|ralph-loop|typescript-lsp|pyright-lsp|rust-analyzer-lsp|"name": "remember"|"name": "codex"' "$ROOT/.claude-plugin/marketplace.json"; then
  fail 'Claude-only plugins must not remain in the marketplace'
fi
pass 'plugin catalogs keep externals and Claude-only integrations out of marketplaces'

node "$ROOT/scripts/install-reconcile.mjs" validate >/dev/null \
  || fail 'install-reconcile validate (marketplaces + AGENTS/CLAUDE projection) failed'
pass 'install-reconcile validate is clean (generated marketplaces + agent docs)'

node -e '
const fs = require("fs");
const catalog = JSON.parse(fs.readFileSync("config/installable-catalog.json", "utf8"));
const md = fs.readFileSync("docs/plugins.md", "utf8");
const ids = ["harness", "hallmark", "no-mistakes", "treehouse", "playwright", "crawl4ai"];
for (const id of ids) {
  const mod = catalog.modules.find((row) => row.id === id);
  if (!mod) throw new Error("catalog missing " + id);
  const needle = "| `" + id + "` |";
  const row = md.split("\n").find((line) => line.includes(needle));
  if (!row) throw new Error("docs/plugins.md missing table row for " + id);
  for (const host of mod.hosts || []) {
    if (!row.includes(host)) throw new Error(id + " docs row missing host " + host);
  }
}
' || fail 'docs/plugins.md host columns must match config/installable-catalog.json'
pass 'docs/plugins.md host columns match installable catalog'

if grep -qi 'brightdata' "$ROOT/.mcp.json" "$ROOT/.codex-plugin/mcp.json"; then
  fail 'active MCP manifests must not ship Bright Data'
fi
pass 'active MCP manifests do not ship removed integrations'

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

cat >"$TMP/bin/git" <<'EOF'
#!/bin/sh
printf '%s %s\n' "$(basename "$0")" "$*" >>"$HARNESS_TEST_LOG"
exit 0
EOF
chmod +x "$TMP/bin/git"

"$ROOT/install.sh" --help >"$TMP/out" 2>&1 || fail '--help should succeed'
grep -q -- '--version' "$TMP/out" || fail 'help should document --version'
grep -q -- '--project-dir' "$TMP/out" || fail 'help should document --project-dir'
grep -q -- '--scope' "$TMP/out" || fail 'help should document --scope'
pass 'help documents --version and scope flags'

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

# Regression: HUP/INT/TERM must exit after cleanup. A cleanup-only INT trap lets
# the installer resume after CTRL+C and print a false completion banner.
if grep -E 'trap cleanup EXIT HUP INT TERM' "$ROOT/install.sh" >/dev/null; then
  fail 'install.sh must not use a cleanup-only HUP/INT/TERM trap'
fi
grep -q 'on_signal()' "$ROOT/install.sh" || fail 'install.sh must define on_signal'
grep -Eq 'trap on_signal HUP INT TERM' "$ROOT/install.sh" || fail 'install.sh must trap signals with on_signal'
grep -q 'exit 130' "$ROOT/install.sh" || fail 'install.sh signal trap must exit 130'
pass 'signal traps exit instead of resuming into the completion banner'

# Project-scope isolation matrix: every host × every project-capable plugin must
# land under --project-dir and must not write user skill/plugin/MCP trees.
assert_no_global_host_trees() {
  host=$1
  for path in \
    "$HOME/.claude/skills" \
    "$HOME/.config/opencode" \
    "$HOME/.agents/skills" \
    "$HOME/.cursor/plugins/local" \
    "$HOME/.cursor/skills"
  do
    if [ -e "$path" ] && [ -n "$(find "$path" -type f 2>/dev/null | head -n 1)" ]; then
      fail "project scope ($host) wrote global host tree: $path"
    fi
  done
  if [ -f "$HOME/.cursor/mcp.json" ]; then
    fail "project scope ($host) wrote global Cursor MCP config"
  fi
  if [ -d "$HOME/.local/bin" ] && [ -n "$(find "$HOME/.local/bin" -type f 2>/dev/null | head -n 1)" ]; then
    fail "project scope ($host) wrote global ~/.local/bin"
  fi
  if [ -d "$HOME/.local/share/harness/crawl4ai-venv" ]; then
    fail "project scope ($host) created global crawl4ai venv"
  fi
}

cat >"$TMP/bin/npx" <<'EOF'
#!/bin/sh
printf '%s\n' "npx $*" >>"$HARNESS_TEST_LOG"
case " $* " in
  *" skills add "*)
    case " $* " in *" -g "*|*" -g")
      echo "npx skills must not use -g under project scope" >&2
      exit 1
      ;;
    esac
    mkdir -p .claude/skills/hallmark
    printf '# hallmark\n' >.claude/skills/hallmark/SKILL.md
    ;;
esac
exit 0
EOF
chmod +x "$TMP/bin/npx"

cat >"$TMP/bin/no-mistakes" <<'EOF'
#!/bin/sh
printf '%s\n' "no-mistakes $*" >>"$HARNESS_TEST_LOG"
if [ "$1" = init ]; then
  mkdir -p .no-mistakes
  printf 'ok\n' >.no-mistakes/initialized
fi
exit 0
EOF
chmod +x "$TMP/bin/no-mistakes"

cat >"$TMP/bin/curl" <<'EOF'
#!/bin/sh
printf '%s\n' "curl $*" >>"$HARNESS_TEST_LOG"
echo "project scope must not curl global installers" >&2
exit 1
EOF
chmod +x "$TMP/bin/curl"

for tool in pip pip3 crawl4ai-setup crawl4ai-doctor; do
  cat >"$TMP/bin/$tool" <<'EOF'
#!/bin/sh
printf '%s\n' "$(basename "$0") $*" >>"$HARNESS_TEST_LOG"
echo "project scope must not run global crawl4ai runtime tooling" >&2
exit 1
EOF
  chmod +x "$TMP/bin/$tool"
done

for host in claude codex opencode pi agent; do
  MATRIX_PROJECT=$TMP/matrix-$host
  rm -rf "$MATRIX_PROJECT" \
    "$HOME/.claude" "$HOME/.codex" "$HOME/.config" "$HOME/.agents" "$HOME/.cursor" \
    "$HOME/.local/bin" "$HOME/.local/share/harness/crawl4ai-venv"
  mkdir -p "$MATRIX_PROJECT"
  if MATRIX_PROJECT=$(CDPATH= cd -- "$MATRIX_PROJECT" && pwd -P 2>/dev/null); then
    :
  else
    MATRIX_PROJECT=$(CDPATH= cd -- "$MATRIX_PROJECT" && pwd)
  fi
  : >"$HARNESS_TEST_LOG"
  "$ROOT/install.sh" --cli "$host" --scope project --project-dir "$MATRIX_PROJECT" --yes \
    </dev/null >"$TMP/matrix-$host.out" 2>"$TMP/matrix-$host.err" \
    || fail "project-scope --yes failed for $host"
  assert_no_global_host_trees "$host"

  case "$host" in
    claude)
      grep -q '^claude plugin update harness@harness-engineering --scope project$' "$HARNESS_TEST_LOG" \
        || fail 'Claude project matrix must refresh harness with --scope project'
      grep -q '^claude mcp add-json --scope project playwright ' "$HARNESS_TEST_LOG" \
        || fail 'Claude project matrix must configure playwright MCP with --scope project'
      test -f "$MATRIX_PROJECT/.claude/skills/crawl4ai/SKILL.md" \
        || fail 'Claude project matrix missing crawl4ai skill'
      test -f "$MATRIX_PROJECT/.claude/skills/hallmark/SKILL.md" \
        || fail 'Claude project matrix missing hallmark skill'
      ;;
    codex)
      test -f "$MATRIX_PROJECT/.codex-plugin/plugin.json" || fail 'Codex project matrix missing plugin manifest'
      test -f "$MATRIX_PROJECT/.agents/plugins/marketplace.json" || fail 'Codex project matrix missing marketplace'
      test -f "$MATRIX_PROJECT/.agents/skills/crawl4ai/SKILL.md" || fail 'Codex project matrix missing crawl4ai skill'
      test -f "$MATRIX_PROJECT/.claude/skills/hallmark/SKILL.md" || fail 'Codex project matrix missing hallmark skill'
      if grep -Eq '^codex mcp ' "$HARNESS_TEST_LOG"; then
        fail 'Codex project matrix must not configure global playwright MCP'
      fi
      grep -q 'skipping playwright MCP for Codex under project scope' "$TMP/matrix-$host.out" \
        || fail 'Codex project matrix should announce playwright skip'
      ;;
    opencode)
      test -f "$MATRIX_PROJECT/.opencode/skills/harness-generator/SKILL.md" \
        || fail 'OpenCode project matrix missing harness skill'
      test -f "$MATRIX_PROJECT/.opencode/skills/crawl4ai/SKILL.md" \
        || fail 'OpenCode project matrix missing crawl4ai skill'
      test -f "$MATRIX_PROJECT/.claude/skills/hallmark/SKILL.md" \
        || fail 'OpenCode project matrix missing hallmark skill'
      jq -e '.mcp.playwright' "$MATRIX_PROJECT/.opencode/opencode.json" >/dev/null \
        || fail 'OpenCode project matrix missing playwright MCP'
      ;;
    pi)
      test -f "$MATRIX_PROJECT/.agents/skills/planner/SKILL.md" || fail 'Pi project matrix missing planner skill'
      test -f "$MATRIX_PROJECT/.agents/skills/crawl4ai/SKILL.md" || fail 'Pi project matrix missing crawl4ai skill'
      test ! -e "$MATRIX_PROJECT/.claude/skills/hallmark" || fail 'Pi project matrix must not install hallmark'
      ;;
    agent)
      test -f "$MATRIX_PROJECT/.cursor/plugins/local/harness/.cursor-plugin/plugin.json" \
        || fail 'Cursor project matrix missing harness plugin'
      test -f "$MATRIX_PROJECT/.cursor/skills/crawl4ai/SKILL.md" \
        || fail 'Cursor project matrix missing crawl4ai skill'
      test -f "$MATRIX_PROJECT/.claude/skills/hallmark/SKILL.md" \
        || fail 'Cursor project matrix missing hallmark skill'
      jq -e '.mcpServers.playwright' "$MATRIX_PROJECT/.cursor/mcp.json" >/dev/null \
        || fail 'Cursor project matrix missing playwright MCP'
      ;;
  esac

  test -f "$MATRIX_PROJECT/.no-mistakes/initialized" \
    || fail "project matrix ($host) must run no-mistakes init in the project"
  grep -q '^no-mistakes init$' "$HARNESS_TEST_LOG" \
    || fail "project matrix ($host) must invoke no-mistakes init"
  if grep -Eq '^(curl|pip|pip3|crawl4ai-setup|crawl4ai-doctor) ' "$HARNESS_TEST_LOG"; then
    fail "project matrix ($host) must not invoke global installers"
  fi
  if grep -Eq 'npx skills add .* -g' "$HARNESS_TEST_LOG"; then
    fail "project matrix ($host) must not pass -g to npx skills"
  fi
  case "$host" in
    claude|codex|opencode|agent)
      grep -q 'skipping treehouse (user scope only)' "$TMP/matrix-$host.out" \
        || fail "project matrix ($host) must skip treehouse"
      ;;
  esac
  case "$host" in
    claude|codex)
      grep -q 'skipping status-line (user scope only)' "$TMP/matrix-$host.out" \
        || fail "project matrix ($host) must skip status-line"
      ;;
  esac
  case "$host" in
    claude)
      grep -q 'skipping shared-config (user scope only)' "$TMP/matrix-$host.out" \
        || fail 'project matrix (claude) must skip shared-config'
      ;;
  esac
  pass "project-scope matrix keeps $host installs inside the project folder"
done
pass 'project-scope matrix installs every host/plugin without global host trees'
