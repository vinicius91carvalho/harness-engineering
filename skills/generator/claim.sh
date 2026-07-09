#!/usr/bin/env bash
# claim.sh — atomic, cross-session coordination for parallel /generator runs.
#
# All shared state lives under the repo's single shared .git (so every worktree
# sees the same registry):
#   .git/generator-claims.json     map: context -> {branch,worktree,port,session,status,started,featureIds}
#   .git/harness-locks/generator-state  atomic mkdir lock for claim mutations
#   .git/harness-locks/generator-merge  mkdir mutex for serialized merges
#
# Implementation lives in lib/claim-lease.mjs; this script is a thin CLI wrapper.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/lib/claim-lease-cli.mjs" "$@"
