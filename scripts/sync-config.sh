#!/usr/bin/env bash
# Extract the shareable subset of a Claude Code settings.json.
# Drops machine-specific keys (statusLine, enabledPlugins, extraKnownMarketplaces)
# and omits any key that's absent, rather than writing it as null.
#
#   sync-config.sh [SRC]   # print subset of SRC (default ~/.claude/settings.json)
#   sync-config.sh --selftest

FILTER='{model, worktree, preferredNotifChannel, remoteControlAtStartup,
         inputNeededNotifEnabled, agentPushNotifEnabled}
        | with_entries(select(.value != null))'

if [ "$1" = "--selftest" ]; then
  sample='{"model":"opus","statusLine":{"type":"command"},"enabledPlugins":["x"],
           "remoteControlAtStartup":true,"agentPushNotifEnabled":false}'
  out=$(printf '%s' "$sample" | jq "$FILTER")
  echo "$out" | jq -e 'has("statusLine") | not'      >/dev/null || { echo "statusLine not stripped"; exit 1; }
  echo "$out" | jq -e 'has("enabledPlugins") | not'  >/dev/null || { echo "enabledPlugins not stripped"; exit 1; }
  echo "$out" | jq -e '.remoteControlAtStartup==true' >/dev/null || { echo "remoteControlAtStartup lost"; exit 1; }
  echo "$out" | jq -e 'has("model")'                 >/dev/null || { echo "model lost"; exit 1; }
  echo "$out" | jq -e 'has("preferredNotifChannel")|not' >/dev/null || { echo "absent key not dropped"; exit 1; }
  echo "selftest ok"; exit 0
fi

SRC="${1:-$HOME/.claude/settings.json}"
jq "$FILTER" "$SRC"
