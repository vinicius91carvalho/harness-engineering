# Optional integrations

Installer checklist rows that are not marketplace plugins.
Plugin rows (Playwright, Crawl4AI, hallmark, …) live in [plugins.md](plugins.md); the catalog SoT is `config/installable-catalog.json` (ADR-0013).

| Integration | Hosts | Behavior |
| --- | --- | --- |
| Status line | Claude, Codex | Claude: bundled `scripts/statusline.sh` copied to `~/.claude/statusline.sh` and wired via settings. Codex: native `[tui] status_line` in `~/.codex/config.toml`. OpenCode has no equivalent hook yet. |
| Shared config | Claude | Atomically merges sanitized `config/settings.json`, preserving unrelated settings and a backup. |

Role routing uses project-local `.harness/roles.json` from `config/roles.example.json`.
See the [routing guide](../README.md#optional-role-routing).

MCP registration differs by host (`claude mcp add-json`, `codex mcp add`, OpenCode native shapes).
Dry-run performs none of these writes or downloads.
