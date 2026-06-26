---
name: update-project
description: Back up sanitized, restorable configuration for every detected Claude Code, Codex, and OpenCode host without copying credentials, caches, histories, or sessions.
---

# Update project

Back up each detected host independently. Never infer that one host's schema is
valid for another. Locate the plugin root through `CLAUDE_PLUGIN_ROOT` (Claude),
`PLUGIN_ROOT` (Codex), or this installed skill directory (OpenCode).

## Safety boundary

Before writing, show the source and destination inventory and ask through the
active host's native question facility. Never read or copy credentials, tokens,
history, conversations, sessions, caches, logs, indexes, telemetry, or installed
plugin payloads. Preserve `${PLACEHOLDER}` values in committed MCP inventories.
`remember` is a Claude-only optional marketplace plugin. Never delete existing
`.remember/` data or silently uninstall a live plugin. `codebase-memory-mcp` is a
separate optional MCP/tool integration, not a marketplace plugin.

## Host backups

- Claude Code: sanitize the shareable subset of `~/.claude/settings.json`; record
  enabled marketplace plugins; copy only user-authored `skills/`, `commands/`,
  `agents/`, `hooks/`, `keybindings.json`, and `CLAUDE.md` to
  `config/home/claude/`. Sanitize user/local MCP entries from `~/.claude.json`.
- Codex: sanitize `~/.codex/config.toml`; copy user-authored skills, agents,
  hooks, and instruction files to `config/home/codex/`. Exclude auth files,
  session/history directories, logs, caches, and marketplace snapshots.
- OpenCode: sanitize `~/.config/opencode/opencode.json` (or `.jsonc`, retaining a
  pre-normalization backup outside the committed tree); copy only user-authored
  `skills/`, `agents/`, `commands/`, `tools/`, and instruction files to
  `config/home/opencode/`. Exclude auth, storage, logs, caches, and sessions.

Keep host MCP shapes distinct: Claude uses `mcpServers`, Codex uses TOML
`mcp_servers`/native `codex mcp`, and OpenCode uses `mcp` entries whose local
`command` is an array. Ask for every secret at restore time; Enter skips a server.

## Reconciliation

Reconcile the Claude and Codex marketplace catalogs, both installers, README,
AGENTS.md, and CLAUDE.md. Optional tools absent from a live setup are not automatic
deletions; ask before removing an offering. Never reintroduce `remember` or list
`codebase-memory-mcp` as a marketplace plugin. Keep `remember` Claude-only.

Run the same checks as CI:

```sh
jq empty .claude-plugin/*.json .codex-plugin/*.json .agents/plugins/marketplace.json opencode.json config/*.json
sh -n install.sh && bash -n skills/generator/claim.sh scripts/*.sh
bash tests/install_test.sh && bash tests/orchestrator_test.sh && bash tests/claim_test.sh
bash scripts/statusline.sh --selftest && bash scripts/sync-config.sh --selftest
```

Report changed paths and verification results. Do not commit unless asked.
