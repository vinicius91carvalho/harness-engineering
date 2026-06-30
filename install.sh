#!/bin/sh
# Install the harness plugin and optional integrations for Claude Code, Codex, and OpenCode.
set -eu

MARKETPLACE_REPO="vinicius91carvalho/harness-engineering"
CLAUDE_MARKETPLACE="harness-engineering"
CODEX_MARKETPLACE="harness-engineering"
REPO_URL="https://github.com/$MARKETPLACE_REPO.git"
MEMORY_INSTALLER="https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh"
OPTIONAL="ponytail codebase-memory-mcp context7 playwright status-line shared-config mcp-servers"

ASSUME=""
DRY=""
CLI_REQUEST=""
SCOPE=""
TEMP_REPO=""
OWN_TEMP_REPO=""

usage() {
  cat <<'EOF'
Usage: install.sh [--yes|--no] [--dry-run]
                  [--cli claude|codex|opencode|all]
                  [--scope user|project|local]

--yes/--no choose checklist contents; --cli chooses target hosts.
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
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

case "$CLI_REQUEST" in ""|claude|codex|opencode|all) ;; *) die "invalid --cli value: $CLI_REQUEST" ;; esac
case "$SCOPE" in ""|user|project|local) ;; *) die "invalid --scope value: $SCOPE" ;; esac

cli_installed() {
  cli=$1
  command -v "$cli" >/dev/null 2>&1 && return 0
  [ "$cli" = opencode ] || return 1
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
}

detected_clis=""
for cli in claude codex opencode; do
  cli_installed "$cli" && detected_clis="$detected_clis $cli"
done
detected_clis=${detected_clis# }
[ -n "$detected_clis" ] || die 'no supported CLI found (install Claude Code, Codex, or OpenCode)'

tty_available() { [ -r /dev/tty ] && [ -w /dev/tty ] && (set +e; : </dev/tty) >/dev/null 2>&1; }
word_count() { set -- $1; echo "$#"; }
word_at() { list=$1; wanted=$2; i=1; for value in $list; do [ "$i" -eq "$wanted" ] && { echo "$value"; return; }; i=$((i + 1)); done; }

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
        printf '%s%s %s\n' "$pointer" "$box" "$item" >/dev/tty
      else
        printf '%s%s\n' "$pointer" "$item" >/dev/tty
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
  tty_available || die "multiple CLIs detected ($detected_clis); pass --cli claude|codex|opencode|all"

  MENU_MODE=single; MENU_TITLE='Select target host:'; MENU_ITEMS="$detected_clis all"; MENU_CHECKED=
  select_menu
  [ "$MENU_RESULT" = all ] && CLI=$detected_clis || CLI=$MENU_RESULT
}
select_cli

if [ -n "$SCOPE" ] && [ "$CLI" != claude ]; then die '--scope is only valid when Claude is the sole selected host'; fi
[ -n "$SCOPE" ] || SCOPE=user

plugin_clis() {
  case "$1" in
    harness|ponytail) echo 'claude codex opencode' ;;
    codebase-memory-mcp|context7|playwright) echo 'claude codex opencode' ;;
    mcp-servers) echo 'claude codex opencode' ;;
    status-line|shared-config) echo claude ;;
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
  MENU_MODE=multi; MENU_TITLE='Select what to install (harness recommended):'; MENU_ITEMS="$candidates"; MENU_CHECKED=harness
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

ensure_repo() {
  [ -n "$TEMP_REPO" ] && return
  script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || true)
  if [ -n "$script_dir" ] && [ -f "$script_dir/.claude-plugin/marketplace.json" ]; then TEMP_REPO=$script_dir; return; fi
  [ -z "$DRY" ] || { TEMP_REPO='<staged harness repository>'; return; }
  TEMP_REPO=$(mktemp -d "${TMPDIR:-/tmp}/harness-installer.XXXXXX")
  OWN_TEMP_REPO=$TEMP_REPO
  git clone --depth 1 "$REPO_URL" "$TEMP_REPO" || die 'could not download the harness repository'
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
  [ -n "$DRY" ] && { if [ "$name" = ponytail ]; then echo "DRY RUN — npm install @dietrichgebert/ponytail"; echo "DRY RUN — register ponytail in OpenCode plugin config"; else echo "DRY RUN — install namespaced OpenCode skills, agents, and commands for $name"; fi; return; }
  if [ "$name" = ponytail ]; then
    command -v npm >/dev/null 2>&1 || die 'npm is required to install the ponytail OpenCode plugin'
    npm install -g @dietrichgebert/ponytail || die 'npm install of ponytail failed'
    cleanup_opencode_plugin_files ponytail
    atomic_opencode_plugin_add ponytail "@dietrichgebert/ponytail"
    return
  fi
  ensure_repo
  source=$TEMP_REPO
  base=${XDG_CONFIG_HOME:-$HOME/.config}/opencode
  mkdir -p "$base/skills" "$base/agents" "$base/commands"
  if [ -d "$source/skills" ]; then
    for path in "$source"/skills/*; do [ -d "$path" ] || continue; dest="$base/skills/$name-$(basename "$path")"; mkdir -p "$dest"; cp -R "$path"/. "$dest"/; done
  fi
  if [ -d "$source/agents" ]; then
    for path in "$source"/agents/*.md; do [ -f "$path" ] || continue; cp "$path" "$base/agents/$name-$(basename "$path")"; done
  fi
  if [ -d "$source/commands" ]; then
    for path in "$source"/commands/*.md; do [ -f "$path" ] || continue; cp "$path" "$base/commands/$name-$(basename "$path")"; done
  elif [ "$name" = harness ]; then
    for path in "$source"/skills/*/SKILL.md; do [ -f "$path" ] || continue; cp "$path" "$base/commands/harness-$(basename "$(dirname "$path")").md"; done
  fi
}

install_plugin() {
  name=$1; cli=$2
  has_word "$(plugin_clis "$name")" "$cli" || return 0
  case "$cli" in
    claude) run claude plugin install "$name@$CLAUDE_MARKETPLACE" --scope "$SCOPE" ;;
    codex)
      if [ "$name" = ponytail ]; then
        if [ -n "$DRY" ]; then run codex plugin marketplace upgrade ponytail
        else codex plugin marketplace upgrade ponytail >/dev/null 2>&1 || codex plugin marketplace add https://github.com/DietrichGebert/ponytail
        fi
        run codex plugin add ponytail@ponytail
      else
        run codex plugin add "$name@$CODEX_MARKETPLACE"
      fi
      ;;
    opencode) install_opencode_plugin "$name" ;;
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
  atomic_claude_filter '.statusLine = {type:"command", command:$command}' --arg command "bash $script"
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

install_mcp_inventory() {
  [ -n "$DRY" ] && { echo "DRY RUN — prompt for and configure MCP inventory for:$CLI"; return; }
  tty_available || { echo '   MCP inventory requires a TTY for secret prompts; skipped' >&2; return; }
  ensure_repo; inventory=$TEMP_REPO/config/mcp.json; ensure_jq
  [ -f "$inventory" ] || { echo '   no MCP inventory found'; return; }
  for name in $(jq -r '.mcpServers | keys[]' "$inventory"); do
    printf 'Configure MCP server %s? [y/N] ' "$name" >/dev/tty
    IFS= read -r answer </dev/tty || answer=n
    case "$answer" in y|Y|yes|YES) ;; *) continue ;; esac
    json=$(jq -c --arg name "$name" '.mcpServers[$name]' "$inventory")
    for placeholder in $(printf '%s' "$json" | grep -o '\${[A-Za-z0-9_]*}' | sort -u || true); do
      key=$(printf '%s' "$placeholder" | tr -d '${}')
      printf 'Value for %s (input hidden; paste supported; Enter skips %s): ' "$key" "$name" >/dev/tty
      saved=$(stty -g </dev/tty); stty -echo </dev/tty; IFS= read -r value </dev/tty || value=; stty "$saved" </dev/tty; printf '\n' >/dev/tty
      [ -n "$value" ] || { json=; break; }
      json=$(printf '%s' "$json" | jq -c --arg from "$placeholder" --arg to "$value" 'walk(if type=="string" then split($from) | join($to) else . end)')
    done
    [ -n "$json" ] || continue
    for cli in $CLI; do
      case "$cli" in
        claude)
          claude mcp remove "$name" --scope user >/dev/null 2>&1 || true
          claude mcp add-json --scope user "$name" "$json" || die "Claude MCP configuration failed for $name" ;;
        codex)
          url=$(printf '%s' "$json" | jq -r '.url // empty')
          if [ -n "$url" ]; then
            codex mcp remove "$name" >/dev/null 2>&1 || true
            codex mcp add "$name" --url "$url" >/dev/null 2>&1 || codex mcp get "$name" >/dev/null 2>&1 || die "Codex MCP configuration failed for $name"
          else
            command=$(printf '%s' "$json" | jq -r '.command')
            args=$(printf '%s' "$json" | jq -r '.args[]?' | xargs)
            # shellcheck disable=SC2086
            codex mcp add "$name" -- "$command" $args || die "Codex MCP configuration failed for $name"
          fi ;;
        opencode)
          server=$(printf '%s' "$json" | jq -c 'if .url then {type:"remote",url:.url,enabled:true} else {type:"local",command:([.command]+(.args//[])),enabled:true} + (if .env then {environment:.env} else {} end) end')
          atomic_opencode_mcp "$name" "$server" ;;
      esac
    done
  done
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

install_memory() {
  if [ -n "$DRY" ]; then
    echo "DRY RUN — download signed codebase-memory-mcp binary with --skip-config"
    for cli in $CLI; do echo "DRY RUN — configure codebase-memory-mcp for $cli"; done
    return
  fi
  binary=$(command -v codebase-memory-mcp 2>/dev/null || true)
  if [ -z "$binary" ]; then
    command -v curl >/dev/null 2>&1 || die 'curl is required to install codebase-memory-mcp'
    installer=$(mktemp "${TMPDIR:-/tmp}/codebase-memory-install.XXXXXX")
    curl -fsSL "$MEMORY_INSTALLER" -o "$installer" || die 'codebase-memory-mcp download failed; check network access and retry'
    sh "$installer" --skip-config || die 'codebase-memory-mcp installer failed; inspect the upstream installer output'
    rm -f "$installer"
    binary=$(command -v codebase-memory-mcp 2>/dev/null || true)
  fi
  [ -n "$binary" ] && [ -x "$binary" ] || die 'codebase-memory-mcp binary was not found after installation; add it to PATH and retry'
  "$binary" config set auto_index true || die 'could not enable codebase-memory-mcp auto-indexing'
  for cli in $CLI; do
    case "$cli" in
      claude)
        claude mcp remove codebase-memory-mcp --scope user >/dev/null 2>&1 || true
        claude mcp add-json --scope user codebase-memory-mcp "{\"command\":\"$binary\",\"args\":[]}" || die 'Claude MCP configuration failed' ;;
      codex) codex mcp add codebase-memory-mcp -- "$binary" || die 'Codex MCP configuration failed' ;;
      opencode) atomic_opencode_mcp codebase-memory-mcp "$(jq -nc --arg bin "$binary" '{type:"local",command:[$bin],enabled:true}')" ;;
    esac
  done
}

install_portable_mcp() {
  name=$1
  ensure_jq
  case "$name" in
    context7) json='{"type":"http","url":"https://mcp.context7.com/mcp"}' ;;
    playwright) json='{"type":"stdio","command":"npx","args":["-y","@playwright/mcp@latest"]}' ;;
  esac
  if [ -n "$DRY" ]; then echo "DRY RUN — configure $name MCP for:$CLI"; return; fi
  for cli in $CLI; do
    case "$cli" in
      claude)
        claude mcp remove "$name" --scope user >/dev/null 2>&1 || true
        claude mcp add-json --scope user "$name" "$json" || die "Claude MCP configuration failed for $name" ;;
      codex)
        codex mcp remove "$name" >/dev/null 2>&1 || true
        url=$(printf '%s' "$json" | jq -r '.url // empty')
        if [ -n "$url" ]; then codex mcp add "$name" --url "$url"
        else codex mcp add "$name" -- "$(printf '%s' "$json" | jq -r .command)" -y "$(printf '%s' "$json" | jq -r '.args[-1]')"
        fi || die "Codex MCP configuration failed for $name" ;;
      opencode)
        server=$(printf '%s' "$json" | jq -c 'if .url then {type:"remote",url:.url,enabled:true} else {type:"local",command:([.command]+.args),enabled:true} end')
        atomic_opencode_mcp "$name" "$server" ;;
    esac
  done
}

for cli in $CLI; do
  case "$cli" in claude) install_claude_marketplace ;; codex) install_codex_marketplace ;; esac
done

for item in $SELECTED; do
  case "$item" in
    codebase-memory-mcp) install_memory ;;
    context7|playwright) install_portable_mcp "$item" ;;
    status-line) enable_status_line ;;
    shared-config) apply_shared_config ;;
    mcp-servers) install_mcp_inventory ;;
    *) for cli in $CLI; do install_plugin "$item" "$cli"; done ;;
  esac
done

echo "Harness installation complete for:$CLI"
