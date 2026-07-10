#!/usr/bin/env sh
# Helpers for Execution Ledger assertions in shell tests.
set -eu

harness_ledger_file() {
  repo=$1
  project_id=${2:-root}
  printf '%s/.git/harness-ledger/%s.json\n' "$repo" "$project_id"
}

harness_ledger_set_item() {
  repo=$1
  item_id=$2
  shift 2
  ledger=$(harness_ledger_file "$repo")
  mkdir -p "$(dirname "$ledger")"
  if [ ! -f "$ledger" ]; then
    printf '%s\n' '{"version":1,"items":{},"updatedAt":null}' >"$ledger"
  fi
  tmp="$ledger.tmp"
  jq --arg id "$item_id" "$@" "$ledger" >"$tmp" && mv "$tmp" "$ledger"
}

harness_ledger_mark_integrated() {
  repo=$1
  item_id=$2
  harness_ledger_set_item "$repo" "$item_id" \
    '.items[$id] = ((.items[$id] // {}) + {"implementation":true,"qa":true,"integration":true,"blocked":false,"retries":0})'
}

harness_evidence_file() {
  repo=$1
  pattern=$2
  find "$repo/.git/harness-evidence" -name "$pattern" 2>/dev/null | head -1
}
