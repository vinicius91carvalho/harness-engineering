#!/bin/sh
# Install the harness plugin and optional integrations for Claude Code, Codex, OpenCode, Pi, and Cursor Agent.
set -eu

MARKETPLACE_REPO="vinicius91carvalho/harness-engineering"
CLAUDE_MARKETPLACE="harness-engineering"
CODEX_MARKETPLACE="harness-engineering"
REPO_URL="https://github.com/$MARKETPLACE_REPO.git"
NO_MISTAKES_INSTALLER="https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.sh"
TREEHOUSE_INSTALLER="https://kunchenguid.github.io/treehouse/install.sh"
REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || true)
DEFAULT_OPTIONAL="hallmark no-mistakes treehouse skill-creator playwright crawl4ai status-line shared-config"
OPTIONAL=$DEFAULT_OPTIONAL
if [ -n "$REPO_ROOT" ] && [ -f "$REPO_ROOT/config/installable-catalog.json" ] && command -v node >/dev/null 2>&1; then
  OPTIONAL=$(node "$REPO_ROOT/scripts/install-reconcile.mjs" optional-ids 2>/dev/null) || OPTIONAL=$DEFAULT_OPTIONAL
fi
RECEIPT_DIR=$HOME/.local/share/harness

ASSUME=""
DRY=""
CLI_REQUEST=""
SCOPE=""
TEMP_REPO=""
OWN_TEMP_REPO=""
VERSION=${VERSION:-${HARNESS_INSTALL_REF:-}}

usage() {
  cat <<'EOF'
Usage: install.sh [--yes|--no] [--dry-run]
                  [--version <tag>|--version=<tag>]
                  [--cli claude|codex|opencode|pi|agent|all]
                  [--scope user|project|local]

--yes/--no choose checklist contents; --cli chooses target hosts.
--version pins the GitHub release tag to stage (e.g. v2.0.0); default is latest.
--scope is valid only when Claude Code is the sole target.
EOF
}

die() { echo "install.sh: $*" >&2; exit 1; }
has_word() { case " $1 " in *" $2 "*) return 0 ;; *) return 1 ;; esac; }
cleanup() { [ -z "$OWN_TEMP_REPO" ] || rm -rf "$OWN_TEMP_REPO"; }
trap cleanup EXIT HUP INT TERM

while [ "$#" -gt 0 ]; do
  case "$1" in
    -y|--yes) [ "$ASSUME" != no ] || die '--yes and --no are mutually exclusive'; ASSUME=yes ;;
    -n|--no) [ "$ASSUME" != yes ] || die '--yes and --no are mutually exclusive'; ASSUME=no ;;
    --dry-run) DRY=1 ;;
    --cli=*) CLI_REQUEST=${1#*=} ;;
    --cli) shift; [ "$#" -gt 0 ] || die '--cli requires a value'; CLI_REQUEST=$1 ;;
    --scope=*) SCOPE=${1#*=} ;;
    --scope) shift; [ "$#" -gt 0 ] || die '--scope requires a value'; SCOPE=$1 ;;
    --user) SCOPE=user ;;
    --project) SCOPE=project ;;
    --local) SCOPE=local ;;
    --version=*) VERSION=${1#*=} ;;
    --version) shift; [ "$#" -gt 0 ] || die '--version requires a value'; VERSION=$1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

case "$CLI_REQUEST" in ""|claude|codex|opencode|pi|agent|all) ;; *) die "invalid --cli value: $CLI_REQUEST" ;; esac
case "$SCOPE" in ""|user|project|local) ;; *) die "invalid --scope value: $SCOPE" ;; esac

command -v node >/dev/null 2>&1 || die 'Node.js 18 or newer is required'
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null) || die 'could not determine the Node.js version'
[ "$NODE_MAJOR" -ge 18 ] 2>/dev/null || die 'Node.js 18 or newer is required'

cli_installed() {
  cli=$1
  command -v "$cli" >/dev/null 2>&1 && return 0
  if [ "$cli" = opencode ]; then
    # The official OpenCode installer writes here before the updated PATH is
    # visible to the current shell. Also honor its documented custom locations.
    for path in \
      "${OPENCODE_INSTALL_DIR:-}/opencode" \
      "${XDG_BIN_DIR:-}/opencode" \
      "$HOME/bin/opencode" \
      "$HOME/.opencode/bin/opencode"
    do
      [ "$path" != /opencode ] && [ -x "$path" ] && return 0
    done
    return 1
  fi
  if [ "$cli" = agent ]; then
    for path in \
      "${CURSOR_AGENT_BIN:-}" \
      "$HOME/.local/bin/agent" \
      "$HOME/bin/agent"
    do
      [ -n "$path" ] && [ -x "$path" ] && return 0
    done
    return 1
  fi
  return 1
}

detected_clis=""
for cli in claude codex opencode pi agent; do
  cli_installed "$cli" && detected_clis="$detected_clis $cli"
done
detected_clis=${detected_clis# }
[ -n "$detected_clis" ] || die 'no supported CLI found (install Claude Code, Codex, OpenCode, Pi, or Cursor Agent)'

tty_available() { [ -r /dev/tty ] && [ -w /dev/tty ] && (set +e; : </dev/tty) >/dev/null 2>&1; }
word_count() { set -- $1; echo "$#"; }
word_at() { list=$1; wanted=$2; i=1; for value in $list; do [ "$i" -eq "$wanted" ] && { echo "$value"; return; }; i=$((i + 1)); done; }

MENU_DIM=$(printf '\033[2m')
MENU_RESET=$(printf '\033[0m')

menu_item_blurb() {
  case "${MENU_LABEL_KIND:-}:$1" in
    host:claude) printf '%s' "Anthropic agentic coding CLI with plugins, skills, and MCP." ;;
    host:codex) printf '%s' "OpenAI Codex CLI with plugins and MCP support." ;;
    host:opencode) printf '%s' "Open-source AI coding agent with skills, agents, and MCP." ;;
    host:pi) printf '%s' "Pi CLI for headless agent workflows." ;;
    host:agent) printf '%s' "Cursor Agent CLI for headless workflows in Cursor." ;;
    host:all) printf '%s' "Install to every detected host above." ;;
    install:harness) printf '%s' "Spec→build→QA pipeline with planner, generator, evaluator, supervisor, learning loop, and project backup." ;;
    install:hallmark) printf '%s' "Anti-AI-slop design skill. Installs the hallmark skill globally via npx skills." ;;
    install:no-mistakes) printf '%s' "Git push gate with AI validation. Installs the upstream binary; run no-mistakes init per repository afterward." ;;
    install:treehouse) printf '%s' "Reusable git worktree pool for agents. Installs the upstream treehouse CLI." ;;
    install:skill-creator) printf '%s' "Multi-agent pipeline to create, evaluate, benchmark, and refine AI coding skills." ;;
    install:playwright) printf '%s' "Browser automation and E2E testing through Microsoft official Playwright MCP server." ;;
    install:crawl4ai) printf '%s' "Web crawling and structured extraction. Installs the Python package plus a bundled skill per host." ;;
    install:status-line) printf '%s' "Custom status bar for Claude; built-in status items for Codex (model, git branch, context usage)." ;;
    install:shared-config) printf '%s' "Atomically merge the project shareable Claude settings while preserving your existing preferences." ;;
  esac
}

menu_print_item() {
  item=$1 pointer=$2 box=${3:-}
  blurb=$(menu_item_blurb "$item")
  if [ -n "$box" ]; then
    printf '%s%s %s\n' "$pointer" "$box" "$item" >/dev/tty
    indent='      '
  else
    printf '%s%s\n' "$pointer" "$item" >/dev/tty
    indent='    '
  fi
  if [ -n "$blurb" ]; then
    printf '%s%s%s%s\n' "$indent" "$MENU_DIM" "$blurb" "$MENU_RESET" >/dev/tty
  fi
}

# Read one keypress from the terminal and echo a logical token (arrows, Enter,
# Space, etc). Runs inside $() so its locals never leak.
menu_key() {
  c=$(dd if=/dev/tty bs=1 count=1 2>/dev/null || true)
  case "$c" in
    "") printf enter ;;
    " ") printf space ;;
    q|Q) printf quit ;;
    a|A) printf all ;;
    k|K) printf up ;;
    j|J) printf down ;;
    [1-9]) printf 'num:%s' "$c" ;;
    "$(printf '\033')")
      s=$(dd if=/dev/tty bs=1 count=1 2>/dev/null || true)
      t=$(dd if=/dev/tty bs=1 count=1 2>/dev/null || true)
      case "$s$t" in "[A") printf up ;; "[B") printf down ;; *) printf other ;; esac ;;
    *) printf other ;;
  esac
}

# Arrow-key menu drawn on the alternate screen buffer: every frame repaints from
# the top, so navigation never duplicates lines and it can't corrupt when the
# list is longer than the window (it clips instead of scrolling old frames in).
# ponytail: assumes the terminal is taller than the list; add a scrolling
# viewport only if tiny windows ever matter.
# In:  MENU_MODE=single|multi, MENU_ITEMS (space list), MENU_CHECKED (multi only),
#      MENU_TITLE.  Out: MENU_RESULT (multi: checked items; single: chosen one).
select_menu() {
  total=$(word_count "$MENU_ITEMS")
  [ "$total" -gt 0 ] || { MENU_RESULT=; return; }
  cursor=1; checked=" $MENU_CHECKED "
  saved=$(stty -g </dev/tty)
  menu_restore() { stty "$saved" </dev/tty 2>/dev/null || true; printf '\033[?1049l' >/dev/tty; }
  trap 'menu_restore; cleanup; exit 130' HUP INT TERM
  stty -echo -icanon min 1 </dev/tty
  printf '\033[?1049h' >/dev/tty
  while :; do
    printf '\033[H\033[J%s\n\n' "$MENU_TITLE" >/dev/tty
    i=1
    for item in $MENU_ITEMS; do
      [ "$i" -eq "$cursor" ] && pointer='> ' || pointer='  '
      if [ "$MENU_MODE" = multi ]; then
        case "$checked" in *" $item "*) box='[x]' ;; *) box='[ ]' ;; esac
        menu_print_item "$item" "$pointer" "$box"
      else
        menu_print_item "$item" "$pointer"
      fi
      i=$((i + 1))
    done
    if [ "$MENU_MODE" = multi ]; then
      printf '\n  up/down: move   space: toggle   a: all/none   enter: confirm   q: cancel\n' >/dev/tty
    else
      printf '\n  up/down: move   enter: select   q: cancel\n' >/dev/tty
    fi
    key=$(menu_key)
    case "$key" in
      up) [ "$cursor" -gt 1 ] && cursor=$((cursor - 1)) ;;
      down) [ "$cursor" -lt "$total" ] && cursor=$((cursor + 1)) ;;
      space)
        [ "$MENU_MODE" = multi ] || continue
        cur=$(word_at "$MENU_ITEMS" "$cursor")
        case "$checked" in
          *" $cur "*) checked=$(printf '%s' "$checked" | sed "s/ $cur / /") ;;
          *) checked="$checked$cur " ;;
        esac ;;
      all)
        [ "$MENU_MODE" = multi ] || continue
        on=1; for item in $MENU_ITEMS; do case "$checked" in *" $item "*) ;; *) on=0 ;; esac; done
        [ "$on" -eq 1 ] && checked=' ' || checked=" $MENU_ITEMS " ;;
      num:*)
        n=${key#num:}
        if [ "$n" -le "$total" ]; then cursor=$n; [ "$MENU_MODE" = single ] && break; fi ;;
      enter) break ;;
      quit) menu_restore; trap cleanup EXIT HUP INT TERM; die 'cancelled' ;;
    esac
  done
  menu_restore
  trap cleanup EXIT HUP INT TERM
  if [ "$MENU_MODE" = multi ]; then MENU_RESULT=$(echo $checked); else MENU_RESULT=$(word_at "$MENU_ITEMS" "$cursor"); fi
}

select_cli() {
  if [ -n "$CLI_REQUEST" ]; then
    if [ "$CLI_REQUEST" = all ]; then CLI="$detected_clis"; else
      has_word "$detected_clis" "$CLI_REQUEST" || die "requested CLI is not installed: $CLI_REQUEST"
      CLI="$CLI_REQUEST"
    fi
    return
  fi
  count=$(word_count "$detected_clis")
  if [ "$count" -eq 1 ]; then CLI=$detected_clis; return; fi
  tty_available || die "multiple CLIs detected ($detected_clis); pass --cli claude|codex|opencode|pi|agent|all"

  MENU_MODE=single; MENU_TITLE='Select target host:'; MENU_ITEMS="$detected_clis all"; MENU_CHECKED=; MENU_LABEL_KIND=host
  select_menu
  [ "$MENU_RESULT" = all ] && CLI=$detected_clis || CLI=$MENU_RESULT
}
select_cli

if [ -n "$SCOPE" ] && [ "$CLI" != claude ]; then die '--scope is only valid when Claude is the sole selected host'; fi
[ -n "$SCOPE" ] || SCOPE=user

catalog_repo() {
  if [ -n "$TEMP_REPO" ] && [ -f "$TEMP_REPO/config/installable-catalog.json" ]; then
    printf '%s\n' "$TEMP_REPO"
  elif [ -n "$REPO_ROOT" ] && [ -f "$REPO_ROOT/config/installable-catalog.json" ]; then
    printf '%s\n' "$REPO_ROOT"
  fi
  # Always succeed: missing catalog is normal for curl|sh before staging.
  return 0
}

record_receipt() {
  module=$1
  json=$2
  [ -n "$DRY" ] && return
  repo=$(catalog_repo) || true
  [ -n "$repo" ] || return 0
  [ -f "$repo/scripts/install-reconcile.mjs" ] || return 0
  mkdir -p "$RECEIPT_DIR"
  node "$repo/scripts/install-reconcile.mjs" record-receipt "$RECEIPT_DIR" "$module" "$json" >/dev/null 2>&1 || true
}

plugin_clis() {
  name=$1
  repo=$(catalog_repo)
  if [ -n "$repo" ] && [ -f "$repo/scripts/install-reconcile.mjs" ]; then
    hosts=$(node "$repo/scripts/install-reconcile.mjs" hosts "$name" 2>/dev/null) && { printf '%s\n' "$hosts"; return; }
  fi
  case "$name" in
    harness) echo 'claude codex opencode pi agent' ;;
    skill-creator) echo 'claude codex opencode pi agent' ;;
    hallmark) echo 'claude codex opencode agent' ;;
    no-mistakes) echo 'claude codex opencode pi agent' ;;
    treehouse) echo 'claude codex opencode agent' ;;
    playwright) echo 'claude codex opencode agent' ;;
    crawl4ai) echo 'claude codex opencode pi agent' ;;
    status-line) echo 'claude codex' ;;
    shared-config) echo claude ;;
  esac
}

select_items() {
  if [ "$ASSUME" = no ]; then SELECTED=harness; return; fi
  if [ "$ASSUME" = yes ]; then SELECTED="harness $OPTIONAL"; return; fi
  tty_available || { SELECTED=harness; return; }
  candidates=harness
  for item in $OPTIONAL; do
    supported=0; for cli in $CLI; do has_word "$(plugin_clis "$item")" "$cli" && supported=1; done
    [ "$supported" -eq 1 ] && candidates="$candidates $item"
  done
  MENU_MODE=multi; MENU_TITLE='Select what to install (harness recommended):'; MENU_ITEMS="$candidates"; MENU_CHECKED=harness; MENU_LABEL_KIND=install
  select_menu
  SELECTED=$MENU_RESULT
}
select_items

for item in $SELECTED; do
  supported=0; for cli in $CLI; do has_word "$(plugin_clis "$item")" "$cli" && supported=1; done
  [ "$supported" -eq 1 ] || SELECTED=$(printf ' %s ' "$SELECTED" | sed "s/ $item / /" | xargs)
done

run() {
  if [ -n "$DRY" ]; then printf 'DRY RUN —'; printf ' %s' "$@"; printf '\n'; return; fi
  "$@"
}

resolve_install_ref() {
  if [ -n "$VERSION" ]; then
    printf '%s\n' "$VERSION"
    return 0
  fi
  ref=$(git ls-remote --tags --refs "$REPO_URL" 2>/dev/null \
    | awk -F/ '{print $NF}' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    | sort -V \
    | tail -1) || true
  [ -n "$ref" ] || return 1
  printf '%s\n' "$ref"
}

ensure_repo() {
  [ -n "$TEMP_REPO" ] && return
  script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || true)
  if [ -n "$script_dir" ] && [ -f "$script_dir/.claude-plugin/marketplace.json" ]; then TEMP_REPO=$script_dir; return; fi
  if [ -n "$DRY" ]; then
    if [ -n "$VERSION" ]; then
      ref=$VERSION
    elif ref=$(resolve_install_ref 2>/dev/null); then
      :
    else
      ref=latest-release-tag
    fi
    printf 'DRY RUN — git clone --depth 1 --branch %s %s <temp>\n' "$ref" "$REPO_URL"
    TEMP_REPO='<staged harness repository>'
    return
  fi
  REF=$(resolve_install_ref) || die 'could not resolve latest release tag'
  TEMP_REPO=$(mktemp -d "${TMPDIR:-/tmp}/harness-installer.XXXXXX")
  OWN_TEMP_REPO=$TEMP_REPO
  echo "install.sh: staging release $REF"
  git clone --depth 1 --branch "$REF" "$REPO_URL" "$TEMP_REPO" || die 'could not download the harness repository'
}

install_claude_marketplace() {
  [ -n "$DRY" ] && { run claude plugin marketplace update "$CLAUDE_MARKETPLACE"; return; }
  claude plugin marketplace update "$CLAUDE_MARKETPLACE" >/dev/null 2>&1 || claude plugin marketplace add "$REPO_URL"
}

install_codex_marketplace() {
  [ -n "$DRY" ] && { run codex plugin marketplace upgrade "$CODEX_MARKETPLACE"; return; }
  codex plugin marketplace upgrade "$CODEX_MARKETPLACE" >/dev/null 2>&1 || codex plugin marketplace add "$MARKETPLACE_REPO"
}

cleanup_opencode_plugin_files() {
  name=$1; base=${XDG_CONFIG_HOME:-$HOME/.config}/opencode
  for dir in skills agents commands; do
    [ ! -d "$base/$dir" ] && continue
    for path in "$base/$dir/$name-"*; do
      [ -e "$path" ] || continue
      rm -rf "$path"
    done
  done
}

install_opencode_plugin() {
  name=$1
  [ -n "$DRY" ] && { echo "DRY RUN — install namespaced OpenCode skills, agents, and commands for $name"; return; }
  ensure_repo
  base=${XDG_CONFIG_HOME:-$HOME/.config}/opencode
  mkdir -p "$base/skills" "$base/agents" "$base/commands"
  if [ -d "$TEMP_REPO/packages/$name" ]; then
    dest="$base/skills/$name"
    node "$TEMP_REPO/scripts/install-reconcile.mjs" project-bundle "$name" "$dest" \
      || die "bundle projection failed for $name"
    return
  fi
  if [ "$name" = harness ]; then
    node "$TEMP_REPO/scripts/install-reconcile.mjs" project-harness-opencode "$TEMP_REPO" "$base" \
      || die 'harness OpenCode projection failed'
    return
  fi
  source=$TEMP_REPO
  if [ -d "$source/skills" ]; then
    for path in "$source"/skills/*; do [ -d "$path" ] || continue; dest="$base/skills/$name-$(basename "$path")"; mkdir -p "$dest"; cp -R "$path"/. "$dest"/; done
  fi
  if [ -d "$source/agents" ]; then
    for path in "$source"/agents/*.md; do [ -f "$path" ] || continue; cp "$path" "$base/agents/$name-$(basename "$path")"; done
  fi
  if [ -d "$source/commands" ]; then
    for path in "$source"/commands/*.md; do [ -f "$path" ] || continue; cp "$path" "$base/commands/$name-$(basename "$path")"; done
  fi
}

install_pi_extension() {
  # Install harness skills at the user skill root (~/.agents/skills) so they win
  # over package-cloned copies under ~/.pi/agent/git/... and avoid Pi skill collisions.
  command -v pi >/dev/null 2>&1 || die 'pi is required to install harness skills for Pi'
  if [ -n "$DRY" ]; then
    echo "DRY RUN — copy harness skills into $HOME/.agents/skills"
    echo "DRY RUN — pi remove https://github.com/$MARKETPLACE_REPO (ignore if absent)"
    return
  fi
  ensure_repo
  dest_root=$HOME/.agents/skills
  mkdir -p "$dest_root"
  for path in "$TEMP_REPO"/skills/*; do
    [ -d "$path" ] || continue
    name=$(basename "$path")
    mkdir -p "$dest_root/$name"
    cp -R "$path"/. "$dest_root/$name"/
  done
  # Drop a prior package install of this repo if present; user-level skills replace it.
  pi remove "https://github.com/$MARKETPLACE_REPO" >/dev/null 2>&1 || true
  pi remove "git:github.com/$MARKETPLACE_REPO" >/dev/null 2>&1 || true
}

clean_stale_agent_plugin_pollution() {
  name=$1
  dest=$HOME/.cursor/plugins/local/$name
  [ -d "$dest" ] || return 0
  [ -n "$DRY" ] && return 0
  polluted=0
  if [ -d "$dest/skills/supervisor" ]; then polluted=1; fi
  manifest=$dest/.cursor-plugin/plugin.json
  if [ -f "$manifest" ] && [ "$(jq -r .name "$manifest" 2>/dev/null || echo)" = harness ]; then
    polluted=1
  fi
  [ "$polluted" -eq 1 ] && rm -rf "$dest"
}

install_agent_plugin() {
  name=$1
  if [ -n "$DRY" ]; then echo "DRY RUN — install Cursor Agent plugin at $HOME/.cursor/plugins/local/$name"; return; fi
  command -v agent >/dev/null 2>&1 || cli_installed agent || die 'agent is required to install the harness Cursor Agent plugin'
  ensure_repo
  dest=$HOME/.cursor/plugins/local/$name
  node "$TEMP_REPO/scripts/install-reconcile.mjs" project-agent "$name" "$TEMP_REPO" "$dest" \
    || die "Cursor Agent projection failed for $name"
}

install_plugin() {
  name=$1; cli=$2
  has_word "$(plugin_clis "$name")" "$cli" || return 0
  case "$cli" in
    claude)
      if [ -n "$DRY" ]; then run claude plugin update "$name@$CLAUDE_MARKETPLACE" --scope "$SCOPE"
      else claude plugin update "$name@$CLAUDE_MARKETPLACE" --scope "$SCOPE" || claude plugin install "$name@$CLAUDE_MARKETPLACE" --scope "$SCOPE"
      fi ;;
    codex) run codex plugin add "$name@$CODEX_MARKETPLACE" ;;
    opencode) install_opencode_plugin "$name" ;;
    pi) [ "$name" = harness ] && install_pi_extension ;;
    agent)
      case "$name" in
        harness) install_agent_plugin "$name" ;;
        *) clean_stale_agent_plugin_pollution "$name" ;;
      esac
      ;;
  esac
}

ensure_jq() { command -v jq >/dev/null 2>&1 || die 'jq is required for atomic JSON configuration updates'; }

atomic_claude_filter() {
  filter=$1; shift
  ensure_jq; dir=$HOME/.claude; cfg=$dir/settings.json; mkdir -p "$dir"
  [ -f "$cfg" ] || printf '{}\n' >"$cfg"
  cp "$cfg" "$cfg.pre-harness.bak"
  tmp=$(mktemp "$dir/settings.json.XXXXXX")
  jq "$@" "$filter" "$cfg" >"$tmp" || { rm -f "$tmp"; die "invalid Claude settings JSON in $cfg (backup retained)"; }
  mv "$tmp" "$cfg"
}

enable_status_line() {
  [ -n "$DRY" ] && { echo 'DRY RUN — atomically enable the Claude status line'; return; }
  ensure_repo; script=$TEMP_REPO/scripts/statusline.sh
  [ -f "$script" ] || die 'bundled statusline.sh is missing'
  dest=$HOME/.claude/statusline.sh
  mkdir -p "$HOME/.claude"; cp "$script" "$dest"
  atomic_claude_filter '.statusLine = {type:"command", command:$command}' --arg command "bash $dest"
}

# ponytail: assumes any existing `status_line = [...]` line is single-line
# (matches what this installer and Codex itself write); a hand-edited
# multi-line array would leave orphaned continuation lines behind.
enable_codex_status_line() {
  [ -n "$DRY" ] && { echo 'DRY RUN — atomically enable the Codex status line'; return; }
  dir=$HOME/.codex; cfg=$dir/config.toml; mkdir -p "$dir"
  [ -f "$cfg" ] || : >"$cfg"
  cp "$cfg" "$cfg.pre-harness.bak"
  items='"model", "current-dir", "git-branch", "context-used", "five-hour-limit", "weekly-limit"'
  tmp=$(mktemp "$dir/config.toml.XXXXXX")
  awk -v items="$items" '
    /^\[tui\]/ {
      print
      in_tui = 1
      next
    }
    /^\[/ {
      if (in_tui && !done) { print "status_line = [" items "]"; done = 1 }
      in_tui = 0
      print
      next
    }
    in_tui && /^status_line[ \t]*=/ {
      print "status_line = [" items "]"
      done = 1
      next
    }
    { print }
    END {
      if (in_tui && !done) { print "status_line = [" items "]"; done = 1 }
      if (!done) { print ""; print "[tui]"; print "status_line = [" items "]" }
    }
  ' "$cfg" >"$tmp"
  mv "$tmp" "$cfg"
}

apply_shared_config() {
  [ -n "$DRY" ] && { echo 'DRY RUN — atomically merge Claude shared config'; return; }
  ensure_repo; shared=$TEMP_REPO/config/settings.json; ensure_jq
  [ -f "$shared" ] || die 'bundled shared config is missing'
  dir=$HOME/.claude; cfg=$dir/settings.json; mkdir -p "$dir"; [ -f "$cfg" ] || printf '{}\n' >"$cfg"
  cp "$cfg" "$cfg.pre-harness.bak"; tmp=$(mktemp "$dir/settings.json.XXXXXX")
  jq -s '.[0] * .[1]' "$cfg" "$shared" >"$tmp" || { rm -f "$tmp"; die "could not merge Claude settings (backup retained)"; }
  mv "$tmp" "$cfg"
}

atomic_opencode_json() {
  filter=$1; shift
  base=${XDG_CONFIG_HOME:-$HOME/.config}/opencode; cfg=$base/opencode.json
  ensure_jq; mkdir -p "$base"
  [ ! -f "$base/opencode.jsonc" ] || cfg=$base/opencode.jsonc
  [ -f "$cfg" ] || printf '{}\n' >"$cfg"
  cp "$cfg" "$cfg.pre-harness.bak"
  normalized=$(mktemp "$base/opencode.normalized.XXXXXX")
  if [ "$cfg" = "$base/opencode.jsonc" ]; then
    ensure_repo; command -v node >/dev/null 2>&1 || die 'Node.js is required to safely normalize existing OpenCode JSONC'
    node "$TEMP_REPO/scripts/jsonc-normalize.js" <"$cfg" >"$normalized" || { rm -f "$normalized"; die "invalid OpenCode JSONC in $cfg (backup retained)"; }
  else cp "$cfg" "$normalized"; fi
  tmp=$(mktemp "$base/opencode.json.XXXXXX")
  jq "$@" "$filter" "$normalized" >"$tmp" || { rm -f "$tmp" "$normalized"; die "invalid OpenCode JSON in $cfg (backup retained)"; }
  rm -f "$normalized"
  mv "$tmp" "$cfg"
}

atomic_opencode_mcp() {
  name=$1; server=$2
  atomic_opencode_json '.mcp = (.mcp // {}) | .mcp[$name] = $server' --arg name "$name" --argjson server "$server"
}

atomic_opencode_plugin_add() {
  name=$1; spec=$2
  atomic_opencode_json '.plugin = (.plugin // []) | if (.plugin | index($spec)) then . else .plugin += [$spec] end' --arg spec "$spec"
}

atomic_cursor_mcp() {
  name=$1; server=$2
  ensure_jq; dir=$HOME/.cursor; cfg=$dir/mcp.json; mkdir -p "$dir"
  [ -f "$cfg" ] || printf '{}\n' >"$cfg"
  cp "$cfg" "$cfg.pre-harness.bak"
  tmp=$(mktemp "$dir/mcp.json.XXXXXX")
  jq --arg name "$name" --argjson server "$server" \
    '.mcpServers = (.mcpServers // {}) | .mcpServers[$name] = $server' "$cfg" >"$tmp" \
    || { rm -f "$tmp"; die "invalid Cursor MCP JSON in $cfg (backup retained)"; }
  mv "$tmp" "$cfg"
}

install_skill_creator() {
  for cli in $CLI; do
    has_word "$(plugin_clis "skill-creator")" "$cli" || continue
    case "$cli" in
      claude)
        if [ -n "$DRY" ]; then echo "DRY RUN — install skill-creator to ~/.claude/skills/"
        else
          ensure_repo
          dest="$HOME/.claude/skills/skill-creator"
          mkdir -p "$HOME/.claude/skills"
          node "$TEMP_REPO/scripts/install-reconcile.mjs" project-bundle skill-creator "$dest" \
            || die 'skill-creator projection failed'
        fi ;;
      opencode) install_opencode_plugin skill-creator ;;
      codex) install_plugin skill-creator "$cli" ;;
      pi)
        if [ -n "$DRY" ]; then echo "DRY RUN — install skill-creator to ~/.agents/skills/skill-creator"
        else
          ensure_repo
          dest="$HOME/.agents/skills/skill-creator"
          mkdir -p "$(dirname "$dest")"
          node "$TEMP_REPO/scripts/install-reconcile.mjs" project-bundle skill-creator "$dest" \
            || die 'skill-creator projection failed'
        fi ;;
      agent) install_agent_plugin skill-creator ;;
    esac
  done
}

install_crawl4ai_skill() {
  dest=$1
  ensure_repo
  mkdir -p "$(dirname "$dest")"
  node "$TEMP_REPO/scripts/install-reconcile.mjs" project-bundle crawl4ai "$dest" \
    || die 'crawl4ai projection failed'
}

install_crawl4ai_pip() {
  if [ -n "$DRY" ]; then
    echo 'DRY RUN — pip install -U crawl4ai'
    echo 'DRY RUN — crawl4ai-setup'
    echo 'DRY RUN — crawl4ai-doctor'
    return
  fi
  crawl4ai_venv=$HOME/.local/share/harness/crawl4ai-venv
  crawl4ai_pip() {
    if command -v pip3 >/dev/null 2>&1; then pip3 "$@"
    elif command -v pip >/dev/null 2>&1; then pip "$@"
    elif command -v python3 >/dev/null 2>&1; then python3 -m pip "$@"
    else die 'pip or python3 is required to install crawl4ai'
    fi
  }
  if crawl4ai_pip install -U crawl4ai 2>/dev/null; then :;
  else
    command -v python3 >/dev/null 2>&1 || die 'python3 is required to install crawl4ai in a virtual environment'
    mkdir -p "$(dirname "$crawl4ai_venv")"
    if [ ! -x "$crawl4ai_venv/bin/python" ]; then
      python3 -m venv "$crawl4ai_venv" || die 'could not create crawl4ai virtual environment'
    fi
    "$crawl4ai_venv/bin/pip" install -U crawl4ai || die 'pip install crawl4ai failed'
    mkdir -p "$HOME/.local/bin"
    for tool in crawl4ai-setup crawl4ai-doctor; do
      [ -x "$crawl4ai_venv/bin/$tool" ] || continue
      ln -sf "$crawl4ai_venv/bin/$tool" "$HOME/.local/bin/$tool"
    done
    case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$HOME/.local/bin:$PATH" ;; esac
  fi
  command -v crawl4ai-setup >/dev/null 2>&1 || die 'crawl4ai-setup not found after pip install'
  crawl4ai-setup || die 'crawl4ai-setup failed'
  crawl4ai-doctor || die 'crawl4ai-doctor reported installation problems'
  crawl4ai_version=$(pip3 show crawl4ai 2>/dev/null | awk '/^Version:/{print $2; exit}')
  [ -n "$crawl4ai_version" ] || crawl4ai_version=$(pip show crawl4ai 2>/dev/null | awk '/^Version:/{print $2; exit}')
  record_receipt crawl4ai "{\"pip\":\"crawl4ai\",\"version\":\"${crawl4ai_version:-unknown}\"}"
}

install_crawl4ai() {
  install_crawl4ai_pip
  for cli in $CLI; do
    has_word "$(plugin_clis crawl4ai)" "$cli" || continue
    case "$cli" in
      claude)
        if [ -n "$DRY" ]; then echo 'DRY RUN — install crawl4ai skill to ~/.claude/skills/crawl4ai'
        else install_crawl4ai_skill "$HOME/.claude/skills/crawl4ai"
        fi ;;
      opencode)
        if [ -n "$DRY" ]; then echo 'DRY RUN — install crawl4ai skill to ~/.config/opencode/skills/crawl4ai'
        else
          base=${XDG_CONFIG_HOME:-$HOME/.config}/opencode
          install_crawl4ai_skill "$base/skills/crawl4ai"
        fi ;;
      codex|pi)
        if [ -n "$DRY" ]; then echo 'DRY RUN — install crawl4ai skill to ~/.agents/skills/crawl4ai'
        else install_crawl4ai_skill "$HOME/.agents/skills/crawl4ai"
        fi ;;
      agent)
        if [ -n "$DRY" ]; then echo 'DRY RUN — install crawl4ai skill to ~/.cursor/skills/crawl4ai'
        else install_crawl4ai_skill "$HOME/.cursor/skills/crawl4ai"
        fi ;;
    esac
  done
}

install_hallmark() {
  if [ -n "$DRY" ]; then
    echo 'DRY RUN - npx skills add nutlope/hallmark --skill hallmark -g'
    return
  fi
  command -v npx >/dev/null 2>&1 || die 'npx is required to install the hallmark skill'
  npx skills add nutlope/hallmark --skill hallmark -g || die 'hallmark skill install failed'
  record_receipt hallmark '{"skills":"nutlope/hallmark","skill":"hallmark","global":true}'
}

install_no_mistakes() {
  if [ -n "$DRY" ]; then
    echo "DRY RUN — curl -fsSL $NO_MISTAKES_INSTALLER | sh"
    echo 'DRY RUN — note: run no-mistakes init in each repository you want to gate (not run by the harness installer)'
    return
  fi
  command -v curl >/dev/null 2>&1 || die 'curl is required to install no-mistakes'
  curl -fsSL "$NO_MISTAKES_INSTALLER" | sh || die 'no-mistakes installer failed; inspect the upstream installer output'
  binary=$(command -v no-mistakes 2>/dev/null || true)
  version=$([ -n "$binary" ] && "$binary" --version 2>/dev/null || true)
  record_receipt no-mistakes "{\"binary\":\"${binary:-unknown}\",\"version\":\"${version:-unknown}\"}"
  echo 'install.sh: run no-mistakes init in each repository you want to gate'
}

install_treehouse() {
  if [ -n "$DRY" ]; then
    echo "DRY RUN — curl -fsSL $TREEHOUSE_INSTALLER | sh"
    return
  fi
  command -v curl >/dev/null 2>&1 || die 'curl is required to install treehouse'
  curl -fsSL "$TREEHOUSE_INSTALLER" | sh || die 'treehouse installer failed; inspect the upstream installer output'
  binary=$(command -v treehouse 2>/dev/null || true)
  version=$([ -n "$binary" ] && "$binary" --version 2>/dev/null || true)
  record_receipt treehouse "{\"binary\":\"${binary:-unknown}\",\"version\":\"${version:-unknown}\"}"
}

install_playwright_mcp() {
  name=playwright
  json='{"type":"stdio","command":"npx","args":["-y","@playwright/mcp@latest"]}'
  if [ -n "$DRY" ]; then echo "DRY RUN — configure $name MCP for:$CLI"; return; fi
  ensure_jq
  for cli in $CLI; do
    case "$cli" in
      claude)
        claude mcp remove "$name" --scope user >/dev/null 2>&1 || true
        claude mcp add-json --scope user "$name" "$json" || die "Claude MCP configuration failed for $name" ;;
      codex)
        codex mcp remove "$name" >/dev/null 2>&1 || true
        codex mcp add "$name" -- "$(printf '%s' "$json" | jq -r .command)" -y "$(printf '%s' "$json" | jq -r '.args[-1]')" \
          || die "Codex MCP configuration failed for $name" ;;
      opencode)
        server=$(printf '%s' "$json" | jq -c '{type:"local",command:([.command]+.args),enabled:true}')
        atomic_opencode_mcp "$name" "$server" ;;
      agent)
        server=$(printf '%s' "$json" | jq -c '{type:"stdio",command:.command,args:(.args//[])}')
        atomic_cursor_mcp "$name" "$server" ;;
    esac
  done
}

[ -n "$DRY" ] || case " $SELECTED " in
  *' status-line '*|*' shared-config '*|*' playwright '*)
    ensure_jq ;;
esac

if [ -n "$DRY" ]; then
  script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || true)
  if [ -z "$script_dir" ] || [ ! -f "$script_dir/.claude-plugin/marketplace.json" ]; then
    ensure_repo
  fi
fi

for cli in $CLI; do
  case "$cli" in claude) install_claude_marketplace ;; codex) install_codex_marketplace ;; esac
done

for item in $SELECTED; do
  case "$item" in
    skill-creator) install_skill_creator ;;
    crawl4ai) install_crawl4ai ;;
    hallmark) install_hallmark ;;
    no-mistakes) install_no_mistakes ;;
    treehouse) install_treehouse ;;
    playwright) install_playwright_mcp ;;
    status-line) for cli in $CLI; do case "$cli" in claude) enable_status_line ;; codex) enable_codex_status_line ;; esac; done ;;
    shared-config) apply_shared_config ;;
    *) for cli in $CLI; do install_plugin "$item" "$cli"; done ;;
  esac
done

case " $SELECTED " in
  *' harness '*) record_receipt harness "{\"marketplace\":\"$CLAUDE_MARKETPLACE\"}" ;;
esac

echo "Harness installation complete for:$CLI"
