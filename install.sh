#!/bin/sh
# Install the full harness workspace into a fresh Claude Code setup.
# Usage: curl -sSL https://raw.githubusercontent.com/vinicius91carvalho/harness-engineering/main/install.sh | sh
# Works on macOS, Linux, and Windows (Git Bash / WSL).
set -e

MARKETPLACE="vinicius91carvalho/harness-engineering"
MARKETPLACE_NAME="vinicius91carvalho"
REQUIRED="harness ponytail remember"     # always installed
OPTIONAL="last30days context7 skill-creator playwright claude-md-management typescript-lsp ralph-loop claude-code-setup pyright-lsp hookify rust-analyzer-lsp"   # prompted for, one by one

# -y/--yes answers yes to every prompt, -n/--no answers no — for non-interactive runs.
# Pipe usage: curl -sSL .../install.sh | sh -s -- --yes
ASSUME=""
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME=yes ;;
    -n|--no)  ASSUME=no ;;
    -h|--help) echo "Usage: install.sh [-y|--yes | -n|--no]"; exit 0 ;;
    *) echo "Unknown option: $arg (use -y/--yes or -n/--no)" >&2; exit 1 ;;
  esac
done

if ! command -v claude >/dev/null 2>&1; then
  echo "Claude Code CLI not found. Install it first: https://claude.com/claude-code" >&2
  exit 1
fi

# Ask a yes/no question on the terminal. Reads /dev/tty so it works under `curl | sh`
# (where stdin is the script). $ASSUME short-circuits prompts; no terminal -> default No.
ask() {
  [ "$ASSUME" = yes ] && return 0
  [ "$ASSUME" = no ]  && return 1
  [ -e /dev/tty ] || return 1
  printf "%s [y/N] " "$1" > /dev/tty
  read ans < /dev/tty || return 1
  case "$ans" in [yY]*) return 0 ;; *) return 1 ;; esac
}

install_plugin() {
  echo "==> Installing: $1@$MARKETPLACE_NAME"
  claude plugin install "$1@$MARKETPLACE_NAME" || echo "   (skipped $1 — already installed or failed)" >&2
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

echo "==> Adding marketplace: $MARKETPLACE"
claude plugin marketplace add "$MARKETPLACE" || claude plugin marketplace update "$MARKETPLACE_NAME"

for p in $REQUIRED; do
  install_plugin "$p"
done

if ask "Enable the harness status line (context %, rate limits, git, tmux)?"; then
  enable_statusline
fi

if ask "Apply Vinicius's shared Claude config (model, notifications, Remote Control on startup)?"; then
  apply_config || true
fi

for p in $OPTIONAL; do
  if ask "Install optional plugin '$p'?"; then
    install_plugin "$p"
  else
    echo "==> Skipping optional: $p"
  fi
done

echo "==> Done. Restart Claude Code to load everything."
