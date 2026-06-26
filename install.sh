#!/bin/sh
# Install the full harness workspace into a fresh Claude Code, Opencode, or Codex setup.
# Usage: curl -sSL https://raw.githubusercontent.com/vinicius91carvalho/harness-engineering/main/install.sh | sh
# Works on macOS, Linux, and Windows (Git Bash / WSL).
set -e

MARKETPLACE="vinicius91carvalho/harness-engineering"
MARKETPLACE_NAME="vinicius91carvalho"
REQUIRED="harness"
OPTIONAL="ponytail context7 remember skill-creator claude-md-management claude-code-setup hookify playwright typescript-lsp ralph-loop pyright-lsp rust-analyzer-lsp codex"
REPO_URL="https://github.com/vinicius91carvalho/harness-engineering.git"
TEMP_REPO=""

plugin_clis() {
  case "$1" in
    harness)              echo "claude opencode codex" ;;
    ponytail)             echo "claude opencode" ;;
    context7)             echo "claude" ;;
    remember)             echo "claude" ;;
    skill-creator)        echo "claude" ;;
    claude-md-management) echo "claude" ;;
    claude-code-setup)    echo "claude" ;;
    hookify)              echo "claude" ;;
    playwright)           echo "claude" ;;
    typescript-lsp)       echo "claude" ;;
    ralph-loop)           echo "claude" ;;
    pyright-lsp)          echo "claude" ;;
    rust-analyzer-lsp)    echo "claude" ;;
    codex)                echo "claude" ;;
  esac
}

plugin_supported() {
  local plugin="$1" cli="$2"
  for c in $(plugin_clis "$plugin"); do
    [ "$c" = "$cli" ] && return 0
  done
  return 1
}

ASSUME=""
DRY=""
SCOPE=""
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME=yes ;;
    -n|--no)  ASSUME=no ;;
    --dry-run) DRY=1 ;;
    --scope)  ;; # handled below
    --scope=*) SCOPE="${arg#*=}" ;;
    -h|--help) echo "Usage: install.sh [-y|--yes | -n|--no] [--dry-run] [--scope=user|project|local]"; exit 0 ;;
    --user)    SCOPE=user ;;
    --project) SCOPE=project ;;
    --local)   SCOPE=local ;;
    *) echo "Unknown option: $arg (use -y/--yes, -n/--no, --dry-run, or --scope=user|project|local)" >&2; exit 1 ;;
  esac
done

# Handle --scope value from next argument
i=1
for arg in "$@"; do
  if [ "$arg" = "--scope" ]; then
    next=$((i + 1))
    SCOPE=$(eval "echo \${$next}")
    break
  fi
  i=$((i + 1))
done

# ── Detect ALL available CLIs ────────────────────────────────────────────────
detected_clis=""
if command -v claude   >/dev/null 2>&1; then detected_clis="$detected_clis claude"; fi
if command -v codex    >/dev/null 2>&1; then detected_clis="$detected_clis codex"; fi
if command -v opencode >/dev/null 2>&1; then detected_clis="$detected_clis opencode"; fi

detected_clis=$(echo "$detected_clis" | xargs)  # trim whitespace

if [ -z "$detected_clis" ]; then
  echo "No supported CLI found. Install one of: Claude Code, Opencode, or Codex." >&2
  echo "  Claude Code:  https://claude.com/claude-code" >&2
  echo "  Opencode:     https://opencode.ai" >&2
  echo "  Codex:        https://github.com/openai/codex" >&2
  exit 1
fi

# ── Let user pick which CLI to install for ───────────────────────────────────
select_cli() {
  cli_count=0
  for c in $detected_clis; do cli_count=$((cli_count + 1)); done

  if [ "$cli_count" -eq 1 ]; then
    CLI="$detected_clis"
    echo "==> Detected CLI: $CLI"
    return 0
  fi

  if [ "$ASSUME" = yes ] || [ "$ASSUME" = no ]; then
    CLI="$detected_clis"
    echo "==> Detected CLIs:$detected_clis"
    echo "==> Installing for all detected CLIs"
    return 0
  fi

  if ! { : < /dev/tty; } 2>/dev/null; then
    CLI=$(echo "$detected_clis" | awk '{print $1}')
    echo "==> Detected CLIs:$detected_clis (non-interactive, using: $CLI)"
    return 0
  fi

  printf '\nDetected CLIs:\n' > /dev/tty
  idx=1
  for c in $detected_clis; do
    printf '  \033[36m%d\033[0m) %s\n' "$idx" "$c" > /dev/tty
    idx=$((idx + 1))
  done
  printf '  \033[36m%d\033[0m) all (install for every detected CLI)\n' "$idx" > /dev/tty
  total=$idx
  printf '\nSelect CLI [1-%d] (default: 1): ' "$total" > /dev/tty

  cursor=1
  saved=$(stty -g < /dev/tty)
  stty -echo -icanon min 1 < /dev/tty
  trap 'stty "$saved" < /dev/tty 2>/dev/null' EXIT INT TERM

  while :; do
    key=$(dd if=/dev/tty bs=1 count=1 2>/dev/null)
    case "$key" in
      "$(printf '\033')")
        dd if=/dev/tty bs=1 count=1 2>/dev/null >/dev/null
        arrow=$(dd if=/dev/tty bs=1 count=1 2>/dev/null)
        case "$arrow" in
          A) [ "$cursor" -gt 1 ] && cursor=$((cursor - 1)) ;;
          B) [ "$cursor" -lt "$total" ] && cursor=$((cursor + 1)) ;;
        esac ;;
      "") break ;;
    esac
    printf '\033[%dA' "$total" > /dev/tty
    idx=1
    for c in $detected_clis; do
      if [ "$idx" = "$cursor" ]; then
        printf '\033[36m> [%s]\033[0m %s\n' "$idx" "$c" > /dev/tty
      else
        printf '  [%s] %s\n' "$idx" "$c" > /dev/tty
      fi
      idx=$((idx + 1))
    done
    if [ "$cursor" = "$total" ]; then
      printf '\033[36m> [%s]\033[0m all\n' "$total" > /dev/tty
    else
      printf '  [%s] all\n' "$total" > /dev/tty
    fi
  done

  stty "$saved" < /dev/tty 2>/dev/null
  trap - EXIT INT TERM
  printf '\n' > /dev/tty

  if [ "$cursor" = "$total" ]; then
    CLI="$detected_clis"
    echo "==> Installing for all detected CLIs"
  else
    CLI=$(echo "$detected_clis" | awk -v n="$cursor" '{print $n}')
    echo "==> Detected CLI: $CLI"
  fi
}

select_cli

# ── Plugin installation ──────────────────────────────────────────────────────
install_plugin() {
  [ -n "$DRY" ] && { echo "   DRY RUN — would install: $1"; return 0; }
  for cli in $CLI; do
    case "$cli" in
      claude)
        echo "==> Installing: $1@$MARKETPLACE_NAME (--scope $SCOPE)"
        claude plugin install "$1@$MARKETPLACE_NAME" --scope "$SCOPE" || echo "   (skipped $1 — already installed or failed)" >&2
        ;;
      codex)
        echo "==> Installing: $1 for Codex"
        install_codex_plugin "$1"
        ;;
      opencode)
        echo "==> Installing: $1 for Opencode"
        install_opencode_plugin "$1"
        ;;
    esac
  done
}

install_opencode_plugin() {
  local plugin_name="$1"
  mkdir -p "$HOME/.config/opencode"
  local user_cfg="$HOME/.config/opencode/opencode.jsonc"
  local repo_cfg="$MARKETPLACE_DIR/opencode.json"

  if [ ! -f "$repo_cfg" ]; then
    echo "   (opencode.json not found in repo — skipping opencode config for $plugin_name)" >&2
    return 0
  fi

  if [ ! -f "$user_cfg" ]; then
    echo '{}' > "$user_cfg"
    echo "==> Created $user_cfg"
  fi

  local harness_agents harness_commands harness_mcp
  harness_agents=$(jq -r '.agent // empty' "$repo_cfg" 2>/dev/null)
  harness_commands=$(jq -r '.command // empty' "$repo_cfg" 2>/dev/null)
  harness_mcp=$(jq -r '.mcp // empty' "$repo_cfg" 2>/dev/null)

  # Strip JSONC comments and trailing commas, then deep-merge with user config
  local tmp=$(mktemp)
  jq --argjson ha "${harness_agents:-{}}" \
     --argjson hc "${harness_commands:-{}}" \
     --argjson hm "${harness_mcp:-{}}" \
     '
     # Merge skills.paths (append harness paths, dedupe)
     .skills = (.skills // {}) |
     .skills.paths = (
       ((.skills.paths // []) + ["./skills"] | unique)
     ) |
     # Merge agents (only add missing ones)
     .agent = (.agent // {}) |
     .agent = (.agent | to_entries |
       map({(.key): .value}) | add // {}) |
     .agent = (.agent * $ha) |
     # Merge commands (only add missing ones)
     .command = (.command // {}) |
     .command = (.command | to_entries |
       map({(.key): .value}) | add // {}) |
     .command = (.command * $hc) |
     # Merge MCP servers (only add missing ones)
     .mcp = ((.mcp // {}) * $hm) |
     # Concatenate instructions (append AGENTS.md if missing)
     .instructions = (
       (.instructions // []) as $existing |
       if ($existing | map(. | test("AGENTS\\.md$")) | any)
       then $existing
       else $existing + ["AGENTS.md"]
       end
     )
     ' "$user_cfg" > "$tmp" && mv "$tmp" "$user_cfg"

  echo "==> Updated opencode config: $user_cfg"
}

install_codex_plugin() {
  local plugin_name="$1"
  local codex_cfg=".codex-plugin/plugin.json"
  local repo_cfg="$MARKETPLACE_DIR/.codex-plugin/plugin.json"

  if [ ! -f "$repo_cfg" ]; then
    echo "   (codex plugin.json not found in repo — skipping codex config for $plugin_name)" >&2
    return 0
  fi

  mkdir -p .codex-plugin

  if [ ! -f "$codex_cfg" ]; then
    cp "$repo_cfg" "$codex_cfg"
    echo "==> Created $codex_cfg"
    return 0
  fi

  # Merge agent/command blocks from the harness plugin's opencode.json
  local repo_opencode="$MARKETPLACE_DIR/opencode.json"
  if [ -f "$repo_opencode" ]; then
    local tmp=$(mktemp)
    jq --argjson ha "$(jq '.agent // {}' "$repo_opencode" 2>/dev/null)" \
       --argjson hc "$(jq '.command // {}' "$repo_opencode" 2>/dev/null)" '
       .agent = ((.agent // {}) * $ha) |
       .command = ((.command // {}) * $hc)
    ' "$codex_cfg" > "$tmp" && mv "$tmp" "$codex_cfg"
  fi

  echo "==> Updated codex config: $codex_cfg"
}

# ── Interactive checklist ────────────────────────────────────────────────────
select_menu() {
  items=$(cat)
  n=$(printf '%s\n' "$items" | wc -l | tr -d ' ')

  checked=""
  i=1
  while [ "$i" -le "$n" ]; do
    d=$(printf '%s\n' "$items" | sed -n "${i}p" | cut -d'|' -f4)
    if [ "$ASSUME" = yes ]; then d=1; fi
    checked="$checked $d"
    i=$((i + 1))
  done

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
      "$(printf '\033')")
        dd if=/dev/tty bs=1 count=1 2>/dev/null >/dev/null
        arrow=$(dd if=/dev/tty bs=1 count=1 2>/dev/null)
        case "$arrow" in
          A) [ "$cursor" -gt 1 ] && cursor=$((cursor - 1)) ;;
          B) [ "$cursor" -lt "$n" ] && cursor=$((cursor + 1)) ;;
        esac ;;
      " ")
        new=""; i=1
        for c in $checked; do
          [ "$i" = "$cursor" ] && c=$((1 - c))
          new="$new $c"; i=$((i + 1))
        done
        checked=$new ;;
      "") break ;;
      q) checked=$(echo "$checked" | sed 's/[01]/0/g'); break ;;
    esac
    printf '\033[%dA' "$n" > /dev/tty
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

select_scope() {
  if [ -n "$SCOPE" ]; then
    echo "$SCOPE"
    return 0
  fi

  if [ "$ASSUME" = yes ]; then
    echo "user"
    return 0
  fi

  if ! { : < /dev/tty; } 2>/dev/null; then
    echo "user"
    return 0
  fi

  printf '\nInstallation scope:\n' > /dev/tty
  printf '  \033[36m1\033[0m) \033[1muser\033[0m    — available across all projects\n' > /dev/tty
  printf '  \033[36m2\033[0m) \033[1mproject\033[0m — only in the current directory (.claude-plugin/)\n' > /dev/tty
  printf '  \033[36m3\033[0m) \033[1mlocal\033[0m   — only in the current directory (private, not shared)\n' > /dev/tty
  printf '\nSelect scope [1-3] (default: 1): ' > /dev/tty

  cursor=1
  saved=$(stty -g < /dev/tty)
  stty -echo -icanon min 1 < /dev/tty
  trap 'stty "$saved" < /dev/tty 2>/dev/null' EXIT INT TERM

  while :; do
    key=$(dd if=/dev/tty bs=1 count=1 2>/dev/null)
    case "$key" in
      "$(printf '\033')")
        dd if=/dev/tty bs=1 count=1 2>/dev/null >/dev/null
        arrow=$(dd if=/dev/tty bs=1 count=1 2>/dev/null)
        case "$arrow" in
          A) [ "$cursor" -gt 1 ] && cursor=$((cursor - 1)) ;;
          B) [ "$cursor" -lt 3 ] && cursor=$((cursor + 1)) ;;
        esac ;;
      "1") cursor=1; break ;;
      "2") cursor=2; break ;;
      "3") cursor=3; break ;;
      "") break ;;
    esac
    printf '\033[3A' > /dev/tty
    i=1
    while [ "$i" -le 3 ]; do
      if [ "$i" = "$cursor" ]; then
        printf '\033[36m> [%s]\033[0m\n' "$i" > /dev/tty
      else
        printf '  [%s]\n' "$i" > /dev/tty
      fi
      i=$((i + 1))
    done
  done

  stty "$saved" < /dev/tty 2>/dev/null
  trap - EXIT INT TERM
  printf '\n' > /dev/tty

  case "$cursor" in
    1) echo "user" ;;
    2) echo "project" ;;
    3) echo "local" ;;
  esac
}

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

# ── Helper: find harness repo file in plugin cache or MARKETPLACE_DIR ────────
harness_file() {
  # $1 = relative path inside the harness plugin (e.g. config/settings.json)
  # First try the Claude plugin cache, then fall back to MARKETPLACE_DIR
  local cached
  cached=$(ls -dt "$HOME"/.claude/plugins/cache/*/harness/*/config 2>/dev/null | head -n1)
  if [ -n "$cached" ] && [ -f "$cached/$1" ]; then
    echo "$cached/$1"
  elif [ -n "$MARKETPLACE_DIR" ] && [ -f "$MARKETPLACE_DIR/$1" ]; then
    echo "$MARKETPLACE_DIR/$1"
  fi
}

# ── Status line ──────────────────────────────────────────────────────────────
enable_statusline() {
  ensure_jq || { echo "   (jq required — enable the status line by hand, see README)" >&2; return 1; }

  for cli in $CLI; do
    case "$cli" in
      claude)
        script=$(ls -dt "$HOME"/.claude/plugins/cache/*/harness/*/scripts/statusline.sh 2>/dev/null | head -n1)
        [ -n "$script" ] || script="$MARKETPLACE_DIR/scripts/statusline.sh"
        [ -n "$script" ] && [ -f "$script" ] || { echo "   (statusline.sh not found — is the harness plugin installed?)" >&2; continue; }
        settings="$HOME/.claude/settings.json"
        mkdir -p "$HOME/.claude"
        [ -f "$settings" ] || echo '{}' > "$settings"
        tmp=$(mktemp)
        jq --arg cmd "bash $script" '.statusLine = {type:"command", command:$cmd}' "$settings" > "$tmp" && mv "$tmp" "$settings"
        echo "==> Status line enabled in $settings"
        ;;
      opencode)
        script="$MARKETPLACE_DIR/scripts/statusline.sh"
        [ -n "$script" ] && [ -f "$script" ] || { echo "   (statusline.sh not found)" >&2; continue; }
        mkdir -p "$HOME/.config/opencode"
        user_cfg="$HOME/.config/opencode/opencode.jsonc"
        [ -f "$user_cfg" ] || echo '{}' > "$user_cfg"
        # Strip JSONC comments and trailing commas, add statusLine, re-serialize
        tmp=$(mktemp)
        sed -e 's|//.*$||g' -e 's|/\*.*\*/||g' -e 's|,[[:space:]]*}|}|g' -e 's|,[[:space:]]*\]|]|g' "$user_cfg" \
          | jq --arg cmd "bash $script" '.statusLine = {type:"command", command:$cmd}' > "$tmp" \
          && mv "$tmp" "$user_cfg"
        echo "==> Status line enabled in $user_cfg"
        ;;
      codex)
        echo "   (status line for Codex: not yet supported — configure manually)"
        ;;
    esac
  done
}

# ── Shared config ────────────────────────────────────────────────────────────
apply_config() {
  ensure_jq || { echo "   (jq required — apply the shared config by hand, see README)" >&2; return 0; }

  for cli in $CLI; do
    case "$cli" in
      claude)
        cfg=$(harness_file "config/settings.json")
        [ -n "$cfg" ] || { echo "   (shared config not found — is the harness plugin installed?)" >&2; continue; }
        settings="$HOME/.claude/settings.json"
        mkdir -p "$HOME/.claude"
        [ -f "$settings" ] || echo '{}' > "$settings"
        tmp=$(mktemp)
        jq -s '.[0] * .[1]' "$settings" "$cfg" > "$tmp" && mv "$tmp" "$settings"
        echo "==> Shared config merged into $settings"
        ;;
      opencode)
        cfg=$(harness_file "config/settings.json")
        [ -n "$cfg" ] || { echo "   (shared config not found)" >&2; continue; }
        mkdir -p "$HOME/.config/opencode"
        user_cfg="$HOME/.config/opencode/opencode.jsonc"
        [ -f "$user_cfg" ] || echo '{}' > "$user_cfg"
        tmp=$(mktemp)
        # Strip JSONC, then deep-merge
        sed -e 's|//.*$||g' -e 's|/\*.*\*/||g' -e 's|,[[:space:]]*}|}|g' -e 's|,[[:space:]]*\]|]|g' "$user_cfg" \
          | jq -s '.[0] * .[1]' - "$cfg" > "$tmp" \
          && mv "$tmp" "$user_cfg"
        echo "==> Shared config merged into $user_cfg"
        ;;
      codex)
        cfg=$(harness_file "config/settings.json")
        [ -n "$cfg" ] || { echo "   (shared config not found)" >&2; continue; }
        codex_cfg=".codex-plugin/plugin.json"
        [ -f "$codex_cfg" ] || { echo "   (no .codex-plugin/plugin.json — skipping shared config)" >&2; continue; }
        tmp=$(mktemp)
        jq -s '.[0] * .[1]' "$codex_cfg" "$cfg" > "$tmp" && mv "$tmp" "$codex_cfg"
        echo "==> Shared config merged into $codex_cfg"
        ;;
    esac
  done
}

# ── Restore home content ─────────────────────────────────────────────────────
restore_home() {
  for cli in $CLI; do
    case "$cli" in
      claude)
        home=$(ls -dt "$HOME"/.claude/plugins/cache/*/harness/*/config/home 2>/dev/null | head -n1)
        [ -n "$home" ] && [ -n "$(ls -A "$home" 2>/dev/null)" ] || continue
        mkdir -p "$HOME/.claude"
        cp -R "$home"/. "$HOME/.claude/"
        echo "==> Restored backed-up user content into $HOME/.claude"
        ;;
      opencode)
        home_dir=$(harness_file "config/home")
        [ -n "$home_dir" ] && [ -d "$home_dir" ] && [ -n "$(ls -A "$home_dir" 2>/dev/null)" ] || continue
        mkdir -p "$HOME/.config/opencode"
        cp -R "$home_dir"/. "$HOME/.config/opencode/"
        echo "==> Restored backed-up user content into $HOME/.config/opencode"
        ;;
    esac
  done
}

# ── MCP servers ──────────────────────────────────────────────────────────────
install_mcps() {
  ensure_jq || { echo "   (jq required — add MCP servers by hand, see README)" >&2; return 0; }
  cfg=$(harness_file "config/mcp.json")
  [ -n "$cfg" ] || { echo "   (no MCP inventory found — nothing to add)"; return 0; }
  names=$(jq -r '.mcpServers // {} | keys[]' "$cfg" 2>/dev/null)
  [ -n "$names" ] || { echo "   (no MCP servers in inventory)"; return 0; }

  for cli in $CLI; do
    case "$cli" in
      claude)
        if ! { : < /dev/tty; } 2>/dev/null; then
          echo "   (no terminal — skipping MCP setup; add them later with 'claude mcp add-json')" >&2
          continue
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
            json=$(printf '%s' "$json" | jq -c --arg v "$val" --arg p "$var" 'walk(if type=="string" then gsub("\\$\\{"+$p+"\\}"; $v) else . end)')
          done
          [ -n "$skip" ] && continue
          claude mcp add-json --scope user "$name" "$json" && echo "==> Added MCP server: $name" || echo "   (failed to add $name)" >&2
        done
        ;;
      opencode|codex)
        # Per-server interactive prompt for opencode/codex
        if ! { : < /dev/tty; } 2>/dev/null; then
          echo "   (no terminal — adding MCP servers without unresolved secrets)" >&2
          # Only include servers whose values have no ${...} placeholders
          filtered=$(jq '{mcpServers: (.mcpServers // {} | to_entries | map(select(.value | [.. | strings | test("\\$\\{")] | any | not)) | from_entries)}' "$cfg" 2>/dev/null)
          has_servers=$(echo "$filtered" | jq '.mcpServers | length' 2>/dev/null)
          if [ "${has_servers:-0}" -gt 0 ]; then
            if [ -f .mcp.json ]; then
              tmp=$(mktemp)
              jq -s '.[0] * .[1] | .mcpServers = ((.[0].mcpServers // {}) * (.[1].mcpServers // {}))' .mcp.json "$filtered" > "$tmp" \
                && mv "$tmp" .mcp.json
            else
              echo "$filtered" > .mcp.json
            fi
            echo "==> Added MCP servers to .mcp.json (servers needing secrets were skipped)"
          else
            echo "   (all MCP servers need secrets — none added; configure manually)"
          fi
          continue
        fi

        # Build merged MCP servers from prompt
        merged_mcp="{}"
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
            json=$(printf '%s' "$json" | jq -c --arg v "$val" --arg p "$var" 'walk(if type=="string" then gsub("\\$\\{"+$p+"\\}"; $v) else . end)')
          done
          [ -n "$skip" ] && continue
          merged_mcp=$(printf '%s %s' "$merged_mcp" "$json" | jq -s '.[0] * {mcpServers: {(.[1] | keys[0]): (.[1] | to_entries[0].value // {})}}')
          echo "==> Selected MCP server: $name"
        done

        # Write/update .mcp.json at project root
        tmp=$(mktemp)
        if [ ! -f .mcp.json ]; then
          echo "$merged_mcp" | jq '{mcpServers: .mcpServers}' > .mcp.json
          echo "==> Created .mcp.json with selected MCP servers"
        else
          jq -s '.[0] * .[1] | .mcpServers = ((.[0].mcpServers // {}) * (.[1].mcpServers // {}))' .mcp.json "$merged_mcp" > "$tmp" \
            && mv "$tmp" .mcp.json
          echo "==> Updated .mcp.json with selected MCP servers"
        fi

        # For opencode: also write MCP config into opencode.json
        if [ "$cli" = "opencode" ]; then
          mkdir -p "$HOME/.config/opencode"
          oc_cfg="$HOME/.config/opencode/opencode.jsonc"
          [ -f "$oc_cfg" ] || echo '{}' > "$oc_cfg"
          oc_tmp=$(mktemp)
          # Strip JSONC, merge MCP servers, re-serialize
          sed -e 's|//.*$||g' -e 's|/\*.*\*/||g' -e 's|,[[:space:]]*}|}|g' -e 's|,[[:space:]]*\]|]|g' "$oc_cfg" \
            | jq --argjson mc "$(echo "$merged_mcp" | jq '.mcpServers')" '
              .mcp = ((.mcp // {}) * $mc)
            ' > "$oc_tmp" && mv "$oc_tmp" "$oc_cfg"
          echo "==> MCP servers configured in $oc_cfg"
        fi
        ;;
    esac
  done
}

# ── Post-install: opencode ───────────────────────────────────────────────────
post_install_opencode() {
  ensure_jq || return 0
  [ -n "$MARKETPLACE_DIR" ] || return 0

  mkdir -p "$HOME/.config/opencode"
  local user_cfg="$HOME/.config/opencode/opencode.jsonc"
  local repo_cfg="$MARKETPLACE_DIR/opencode.json"

  [ -f "$repo_cfg" ] || return 0
  [ -f "$user_cfg" ] || echo '{}' > "$user_cfg"

  local ha hc hm
  ha=$(jq '.agent // {}' "$repo_cfg" 2>/dev/null)
  hc=$(jq '.command // {}' "$repo_cfg" 2>/dev/null)
  hm=$(jq '.mcp // {}' "$repo_cfg" 2>/dev/null)

  local tmp=$(mktemp)
  jq --argjson ha "$ha" --argjson hc "$hc" --argjson hm "$hm" '
    .skills = (.skills // {}) |
    .skills.paths = (
      ((.skills.paths // []) + ["./skills"] | unique)
    ) |
    .agent = ((.agent // {}) * $ha) |
    .command = ((.command // {}) * $hc) |
    .mcp = ((.mcp // {}) * $hm) |
    .instructions = (
      (.instructions // []) as $existing |
      if ($existing | map(. | test("AGENTS\\.md$")) | any)
      then $existing
      else $existing + ["AGENTS.md"]
      end
    )
  ' "$user_cfg" > "$tmp" && mv "$tmp" "$user_cfg"

  echo "==> Opencode post-install: skills/agents/commands/mcp configured in $user_cfg"
}

# ── Post-install: codex ──────────────────────────────────────────────────────
post_install_codex() {
  ensure_jq || return 0
  [ -n "$MARKETPLACE_DIR" ] || return 0

  local codex_cfg=".codex-plugin/plugin.json"
  local repo_cfg="$MARKETPLACE_DIR/.codex-plugin/plugin.json"
  local repo_opencode="$MARKETPLACE_DIR/opencode.json"

  [ -f "$repo_cfg" ] || return 0

  mkdir -p .codex-plugin

  if [ ! -f "$codex_cfg" ]; then
    cp "$repo_cfg" "$codex_cfg"
    echo "==> Created $codex_cfg"
  fi

  if [ -f "$repo_opencode" ]; then
    local tmp=$(mktemp)
    jq --argjson ha "$(jq '.agent // {}' "$repo_opencode" 2>/dev/null)" \
       --argjson hc "$(jq '.command // {}' "$repo_opencode" 2>/dev/null)" '
       .agent = ((.agent // {}) * $ha) |
       .command = ((.command // {}) * $hc)
    ' "$codex_cfg" > "$tmp" && mv "$tmp" "$codex_cfg"
    echo "==> Codex post-install: agents/commands configured in $codex_cfg"
  fi
}

# ── Clone harness repo (source of truth for config files) ────────────────────
clone_repo() {
  if [ -d ".claude-plugin/marketplace.json" ] || [ -f "opencode.json" ] || [ -d ".codex-plugin" ]; then
    MARKETPLACE_DIR="$(pwd)"
    echo "==> Using local repo: $MARKETPLACE_DIR"
    return 0
  fi

  TEMP_REPO=$(mktemp -d)
  echo "==> Cloning harness-engineering repo for config files..."
  git clone --depth 1 "$REPO_URL" "$TEMP_REPO/harness-engineering" 2>/dev/null \
    || { echo "   (git clone failed — some setup steps will be skipped)" >&2; return 0; }
  MARKETPLACE_DIR="$TEMP_REPO/harness-engineering"
  echo "==> Repo cloned to $MARKETPLACE_DIR"
}

cleanup() {
  [ -n "$TEMP_REPO" ] && [ -d "$TEMP_REPO" ] && rm -rf "$TEMP_REPO"
}
trap cleanup EXIT

# ── Main ─────────────────────────────────────────────────────────────────────

# Clone repo (or detect local repo) for config files
clone_repo

# Add marketplace for Claude Code (only for first CLI in list)
first_cli=$(echo "$CLI" | awk '{print $1}')
if [ "$first_cli" = "claude" ]; then
  echo "==> Adding marketplace: $MARKETPLACE"
  [ -n "$DRY" ] || claude plugin marketplace add "$MARKETPLACE" || claude plugin marketplace update "$MARKETPLACE_NAME"
fi

# Select installation scope (only for Claude Code)
if [ "$first_cli" = "claude" ]; then
  SCOPE=$(select_scope)
  echo "==> Installation scope: $SCOPE"
fi

# Build checklist menu
menu_items() {
  for p in $REQUIRED; do
    if plugin_supported "$p" "$CLI"; then
      printf 'plugin|%s|%s|1\n' "$p" "$p"
    else
      echo "   (skipped $p — not supported by $CLI)" >&2
    fi
  done
  for p in $OPTIONAL; do
    if plugin_supported "$p" "$CLI"; then
      printf 'plugin|%s|%s|0\n' "$p" "$p"
    fi
  done
  # Extras depend on which CLIs are being installed
  has_claude=0; has_opencode=0; has_codex=0
  for c in $CLI; do
    case "$c" in
      claude)   has_claude=1 ;;
      opencode) has_opencode=1 ;;
      codex)    has_codex=1 ;;
    esac
  done
  if [ "$has_claude" = 1 ]; then
    printf 'extra|statusline|status line — context %%%%, rate limits, git, tmux|0\n'
    printf 'extra|sharedconfig|shared config — model, notifications, Remote Control|0\n'
    printf 'extra|mcpservers|MCP servers — pick which, with your API keys|0\n'
  fi
  if [ "$has_opencode" = 1 ]; then
    printf 'extra|statusline|status line — context %%%%, rate limits, git, tmux|0\n'
    printf 'extra|mcpservers|MCP servers — pick which, with your API keys|0\n'
  fi
  if [ "$has_codex" = 1 ]; then
    printf 'extra|mcpservers|MCP servers — pick which, with your API keys|0\n'
  fi
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

# Post-install: configure opencode and codex after plugins are installed
for cli in $CLI; do
  case "$cli" in
    opencode) post_install_opencode ;;
    codex)    post_install_codex ;;
  esac
done

[ -n "$SELECTED" ] || echo "==> Nothing selected."
echo "==> Done. Restart your CLI to load everything."
