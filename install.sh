#!/bin/sh
# Install the full harness workspace into a fresh Claude Code setup.
# Usage: curl -sSL https://raw.githubusercontent.com/vinicius91carvalho/harness-engineering/main/install.sh | sh
# Works on macOS, Linux, and Windows (Git Bash / WSL).
set -e

MARKETPLACE="vinicius91carvalho/harness-engineering"
MARKETPLACE_NAME="vinicius91carvalho"
REQUIRED="harness ponytail context7 remember skill-creator claude-md-management claude-code-setup hookify playwright"     # always installed
OPTIONAL="typescript-lsp ralph-loop pyright-lsp rust-analyzer-lsp codex"   # prompted for, one by one

# -y/--yes selects every item, -n/--no keeps required only — for non-interactive
# runs. --dry-run shows what would be installed without touching anything.
# Pipe usage: curl -sSL .../install.sh | sh -s -- --yes
ASSUME=""
DRY=""
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME=yes ;;
    -n|--no)  ASSUME=no ;;
    --dry-run) DRY=1 ;;
    -h|--help) echo "Usage: install.sh [-y|--yes | -n|--no] [--dry-run]"; exit 0 ;;
    *) echo "Unknown option: $arg (use -y/--yes, -n/--no, or --dry-run)" >&2; exit 1 ;;
  esac
done

if ! command -v claude >/dev/null 2>&1; then
  echo "Claude Code CLI not found. Install it first: https://claude.com/claude-code" >&2
  exit 1
fi

install_plugin() {
  [ -n "$DRY" ] && { echo "   DRY RUN — would install: $1"; return 0; }
  echo "==> Installing: $1@$MARKETPLACE_NAME"
  claude plugin install "$1@$MARKETPLACE_NAME" || echo "   (skipped $1 — already installed or failed)" >&2
}

# Arrow-key checkbox multi-select. Items are "type|key|label|default" lines on
# stdin; required plugins default checked, all rows toggleable. Prints the keys
# of checked items, one per line. Reads /dev/tty so it works under `curl | sh`.
# Falls back to defaults when there's no terminal or $ASSUME is set ($ASSUME=yes
# checks everything, =no keeps only the pre-checked rows).
# ponytail: byte-at-a-time arrow decode; swap for a TUI lib only if this proves
# flaky across terminals.
select_menu() {
  items=$(cat)
  n=$(printf '%s\n' "$items" | wc -l | tr -d ' ')

  # Seed checked state from the default column (4th field).
  checked=""
  i=1
  while [ "$i" -le "$n" ]; do
    d=$(printf '%s\n' "$items" | sed -n "${i}p" | cut -d'|' -f4)
    if [ "$ASSUME" = yes ]; then d=1; fi
    checked="$checked $d"
    i=$((i + 1))
  done

  # Non-interactive (flag set, or /dev/tty missing/unopenable): emit defaults
  # without drawing the menu.
  if [ -n "$ASSUME" ] || ! { : < /dev/tty; } 2>/dev/null; then
    i=1
    for c in $checked; do
      [ "$c" = 1 ] && printf '%s\n' "$(printf '%s\n' "$items" | sed -n "${i}p" | cut -d'|' -f2)"
      i=$((i + 1))
    done
    return 0
  fi

  cursor=1
  saved=$(stty -g < /dev/tty)
  stty -echo -icanon min 1 < /dev/tty
  trap 'stty "$saved" < /dev/tty 2>/dev/null' EXIT INT TERM

  draw() {
    i=1
    for c in $checked; do
      line=$(printf '%s\n' "$items" | sed -n "${i}p")
      label=$(printf '%s\n' "$line" | cut -d'|' -f3)
      [ "$c" = 1 ] && box="[x]" || box="[ ]"
      if [ "$i" = "$cursor" ]; then
        printf '\033[36m> %s %s\033[0m\n' "$box" "$label" > /dev/tty
      else
        printf '  %s %s\n' "$box" "$label" > /dev/tty
      fi
      i=$((i + 1))
    done
  }

  printf '\nSelect with \033[36m↑/↓\033[0m, toggle with \033[36mSPACE\033[0m, confirm with \033[36mENTER\033[0m:\n\n' > /dev/tty
  draw
  while :; do
    key=$(dd if=/dev/tty bs=1 count=1 2>/dev/null)
    case "$key" in
      "$(printf '\033')")  # escape sequence — read the next two bytes
        dd if=/dev/tty bs=1 count=1 2>/dev/null >/dev/null   # '['
        arrow=$(dd if=/dev/tty bs=1 count=1 2>/dev/null)
        case "$arrow" in
          A) [ "$cursor" -gt 1 ] && cursor=$((cursor - 1)) ;;   # up
          B) [ "$cursor" -lt "$n" ] && cursor=$((cursor + 1)) ;; # down
        esac ;;
      " ")  # space — toggle the current row
        new=""; i=1
        for c in $checked; do
          [ "$i" = "$cursor" ] && c=$((1 - c))
          new="$new $c"; i=$((i + 1))
        done
        checked=$new ;;
      "")  # enter (read returned empty for newline) — confirm
        break ;;
      q) checked=$(echo "$checked" | sed 's/[01]/0/g'); break ;;
    esac
    printf '\033[%dA' "$n" > /dev/tty   # move cursor back up to redraw in place
    draw
  done

  stty "$saved" < /dev/tty 2>/dev/null
  trap - EXIT INT TERM
  printf '\n' > /dev/tty

  i=1
  for c in $checked; do
    [ "$c" = 1 ] && printf '%s\n' "$(printf '%s\n' "$items" | sed -n "${i}p" | cut -d'|' -f2)"
    i=$((i + 1))
  done
}

# Ensure jq is available, installing it via the first package manager we find.
# Returns non-zero if jq is missing and can't be installed.
ensure_jq() {
  command -v jq >/dev/null 2>&1 && return 0
  echo "==> jq not found — attempting to install it"
  if   command -v brew    >/dev/null 2>&1; then brew install jq
  elif command -v apt-get >/dev/null 2>&1; then sudo apt-get install -y jq
  elif command -v dnf     >/dev/null 2>&1; then sudo dnf install -y jq
  elif command -v pacman  >/dev/null 2>&1; then sudo pacman -S --noconfirm jq
  elif command -v apk     >/dev/null 2>&1; then sudo apk add jq
  else echo "   (no supported package manager — install jq by hand)" >&2; return 1; fi
  command -v jq >/dev/null 2>&1
}

# Point ~/.claude/settings.json at the bundled status line. Idempotent.
enable_statusline() {
  ensure_jq || { echo "   (jq required — enable the status line by hand, see README)" >&2; return 1; }
  script=$(ls -dt "$HOME"/.claude/plugins/cache/*/harness/*/scripts/statusline.sh 2>/dev/null | head -n1)
  [ -n "$script" ] || { echo "   (statusline.sh not found — is the harness plugin installed?)" >&2; return 1; }
  settings="$HOME/.claude/settings.json"
  mkdir -p "$HOME/.claude"
  [ -f "$settings" ] || echo '{}' > "$settings"
  tmp=$(mktemp)
  jq --arg cmd "bash $script" '.statusLine = {type:"command", command:$cmd}' "$settings" > "$tmp" && mv "$tmp" "$settings"
  echo "==> Status line enabled in $settings"
}

# Merge the bundled shareable config into ~/.claude/settings.json (the file's
# keys win). Fail-safe: a missing config or jq failure logs and returns 0 so it
# never aborts the installer under `set -e`.
apply_config() {
  ensure_jq || { echo "   (jq required — apply the shared config by hand, see README)" >&2; return 0; }
  cfg=$(ls -dt "$HOME"/.claude/plugins/cache/*/harness/*/config/settings.json 2>/dev/null | head -n1)
  [ -n "$cfg" ] || { echo "   (shared config not found — is the harness plugin installed?)" >&2; return 0; }
  settings="$HOME/.claude/settings.json"
  mkdir -p "$HOME/.claude"
  [ -f "$settings" ] || echo '{}' > "$settings"
  tmp=$(mktemp)
  jq -s '.[0] * .[1]' "$settings" "$cfg" > "$tmp" && mv "$tmp" "$settings"
  echo "==> Shared config merged into $settings"
}

# Restore loose user content (skills/commands/agents/hooks, keybindings.json,
# global CLAUDE.md) that /harness:update-project backed up into config/home/.
# Guarded: a no-op when nothing was backed up. Existing files are overwritten.
restore_home() {
  home=$(ls -dt "$HOME"/.claude/plugins/cache/*/harness/*/config/home 2>/dev/null | head -n1)
  [ -n "$home" ] && [ -n "$(ls -A "$home" 2>/dev/null)" ] || return 0
  mkdir -p "$HOME/.claude"
  cp -R "$home"/. "$HOME/.claude/"
  echo "==> Restored backed-up user content into $HOME/.claude"
}

# Interactively register the MCP servers backed up in config/mcp.json. For each
# server: ask whether to add it, then prompt (input hidden) for every
# ${PLACEHOLDER} secret it carries. Empty input skips that server — so a user
# without the API key/token just presses ENTER and moves on. Runs after the
# harness plugin is installed, so the inventory is present in the plugin cache.
# Adds at user scope via `claude mcp add-json`.
install_mcps() {
  ensure_jq || { echo "   (jq required — add MCP servers by hand, see README)" >&2; return 0; }
  cfg=$(ls -dt "$HOME"/.claude/plugins/cache/*/harness/*/config/mcp.json 2>/dev/null | head -n1)
  [ -n "$cfg" ] || { echo "   (no MCP inventory found — nothing to add)"; return 0; }
  names=$(jq -r '.mcpServers // {} | keys[]' "$cfg" 2>/dev/null)
  [ -n "$names" ] || { echo "   (no MCP servers in inventory)"; return 0; }
  if ! { : < /dev/tty; } 2>/dev/null; then
    echo "   (no terminal — skipping MCP setup; add them later with 'claude mcp add-json')" >&2
    return 0
  fi
  for name in $names; do
    type=$(jq -r --arg n "$name" '.mcpServers[$n].type // "stdio"' "$cfg")
    printf '\nAdd MCP server "%s" (%s)? [y/N] ' "$name" "$type" > /dev/tty
    read ans < /dev/tty
    case "$ans" in y|Y|yes|YES) ;; *) echo "   (skipped $name)"; continue ;; esac
    json=$(jq -c --arg n "$name" '.mcpServers[$n]' "$cfg")
    skip=
    for ph in $(printf '%s' "$json" | grep -oE '\$\{[A-Za-z0-9_]+\}' | sort -u); do
      var=$(printf '%s' "$ph" | sed 's/^\${//; s/}$//')
      printf '  Value for %s (or ENTER to skip %s): ' "$var" "$name" > /dev/tty
      sttysv=$(stty -g < /dev/tty); stty -echo < /dev/tty
      read val < /dev/tty; stty "$sttysv" < /dev/tty; printf '\n' > /dev/tty
      [ -z "$val" ] && { echo "   (skipped $name — no $var provided)"; skip=1; break; }
      # ponytail: jq walk+gsub needs jq 1.6+; ensure_jq installs current jq.
      json=$(printf '%s' "$json" | jq -c --arg v "$val" --arg p "$var" 'walk(if type=="string" then gsub("\\$\\{"+$p+"\\}"; $v) else . end)')
    done
    [ -n "$skip" ] && continue
    claude mcp add-json --scope user "$name" "$json" && echo "==> Added MCP server: $name" || echo "   (failed to add $name)" >&2
  done
}

echo "==> Adding marketplace: $MARKETPLACE"
[ -n "$DRY" ] || claude plugin marketplace add "$MARKETPLACE" || claude plugin marketplace update "$MARKETPLACE_NAME"

# Build the checklist: required plugins (pre-checked), optional plugins, then the
# two extras. Every row is toggleable — requireds are only checked by default.
menu_items() {
  for p in $REQUIRED; do printf 'plugin|%s|%s (required)|1\n' "$p" "$p"; done
  for p in $OPTIONAL; do printf 'plugin|%s|%s|0\n' "$p" "$p"; done
  printf 'extra|statusline|status line — context %%%%, rate limits, git, tmux|0\n'
  printf 'extra|sharedconfig|shared config — model, notifications, Remote Control|0\n'
  printf 'extra|mcpservers|MCP servers — pick which, with your API keys|0\n'
}

SELECTED=$(menu_items | select_menu)

for sel in $SELECTED; do
  case "$sel" in
    statusline)
      [ -n "$DRY" ] && echo "   DRY RUN — would enable: status line" || enable_statusline ;;
    sharedconfig)
      if [ -n "$DRY" ]; then echo "   DRY RUN — would apply: shared config"; else apply_config || true; restore_home || true; fi ;;
    mcpservers)
      if [ -n "$DRY" ]; then echo "   DRY RUN — would prompt for MCP servers"; else install_mcps || true; fi ;;
    *)
      install_plugin "$sel" ;;
  esac
done

[ -n "$SELECTED" ] || echo "==> Nothing selected."
echo "==> Done. Restart Claude Code to load everything."
