#!/bin/sh
# Install the full harness workspace into a fresh Claude Code setup.
# Usage: curl -sSL https://raw.githubusercontent.com/vinicius91carvalho/harness-engineering/master/install.sh | sh
# Works on macOS, Linux, and Windows (Git Bash / WSL).
set -e

MARKETPLACE="vinicius91carvalho/harness-engineering"
MARKETPLACE_NAME="vinicius91carvalho"
REQUIRED="harness ponytail"     # always installed
OPTIONAL="last30days"           # prompted for, one by one

if ! command -v claude >/dev/null 2>&1; then
  echo "Claude Code CLI not found. Install it first: https://claude.com/claude-code" >&2
  exit 1
fi

# Ask a yes/no question on the terminal. Reads /dev/tty so it works under `curl | sh`
# (where stdin is the script). No terminal (non-interactive pipe) -> default No.
ask() {
  [ -e /dev/tty ] || return 1
  printf "%s [y/N] " "$1" > /dev/tty
  read ans < /dev/tty || return 1
  case "$ans" in [yY]*) return 0 ;; *) return 1 ;; esac
}

install_plugin() {
  echo "==> Installing: $1@$MARKETPLACE_NAME"
  claude plugin install "$1@$MARKETPLACE_NAME" || echo "   (skipped $1 — already installed or failed)" >&2
}

# Point ~/.claude/settings.json at the bundled status line. Idempotent.
enable_statusline() {
  command -v jq >/dev/null 2>&1 || { echo "   (jq not found — enable the status line by hand, see README)" >&2; return 1; }
  script=$(ls -dt "$HOME"/.claude/plugins/cache/*/harness/*/scripts/statusline.sh 2>/dev/null | head -n1)
  [ -n "$script" ] || { echo "   (statusline.sh not found — is the harness plugin installed?)" >&2; return 1; }
  settings="$HOME/.claude/settings.json"
  mkdir -p "$HOME/.claude"
  [ -f "$settings" ] || echo '{}' > "$settings"
  tmp=$(mktemp)
  jq --arg cmd "bash $script" '.statusLine = {type:"command", command:$cmd}' "$settings" > "$tmp" && mv "$tmp" "$settings"
  echo "==> Status line enabled in $settings"
}

# Set remoteControlAtStartup so Remote Control connects for every session. Idempotent.
enable_remote_control() {
  command -v jq >/dev/null 2>&1 || { echo "   (jq not found — set remoteControlAtStartup by hand, see README)" >&2; return 1; }
  settings="$HOME/.claude/settings.json"
  mkdir -p "$HOME/.claude"
  [ -f "$settings" ] || echo '{}' > "$settings"
  tmp=$(mktemp)
  jq '.remoteControlAtStartup = true' "$settings" > "$tmp" && mv "$tmp" "$settings"
  echo "==> Remote Control enabled for all sessions in $settings"
}

echo "==> Adding marketplace: $MARKETPLACE"
claude plugin marketplace add "$MARKETPLACE" || claude plugin marketplace update "$MARKETPLACE_NAME"

for p in $REQUIRED; do
  install_plugin "$p"
done

if ask "Enable the harness status line (context %, rate limits, git, tmux)?"; then
  enable_statusline
fi

if ask "Enable Remote Control for all sessions (control sessions from the mobile/web app)?"; then
  enable_remote_control
fi

for p in $OPTIONAL; do
  if ask "Install optional plugin '$p'?"; then
    install_plugin "$p"
  else
    echo "==> Skipping optional: $p"
  fi
done

echo "==> Done. Restart Claude Code to load everything."
