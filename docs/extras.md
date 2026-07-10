# Optional integrations

| Integration | Hosts | Behavior |
| --- | --- | --- |
| `codebase-memory-mcp` | Claude, Codex, OpenCode | Runs the upstream signed-binary installer with `--skip-config`, verifies the executable, enables auto-indexing, then writes only the selected hosts' native MCP entries. |
| Context7 | Claude, Codex, OpenCode | Registers Upstash's remote MCP endpoint for current library documentation. |
| Playwright | Claude, Codex, OpenCode | Registers Microsoft's `@playwright/mcp` server through `npx`. |
| Crawl4AI | Claude, Codex, OpenCode, Pi, Cursor Agent | Runs `pip install -U crawl4ai`, `crawl4ai-setup`, and `crawl4ai-doctor`, then copies the bundled crawl4ai skill into each selected host's native skill directory. |
| Status line | Claude, Codex | Claude: bundled `scripts/statusline.sh`, copied to `~/.claude/statusline.sh` and wired via `~/.claude/settings.json` (a persistent copy, not a reference into the installer's temp clone). Codex: native `[tui] status_line` array in `~/.codex/config.toml` (built-in items only — model, current-dir, git-branch, context-used, five-hour-limit, weekly-limit — no custom script). OpenCode has no native status-line hook yet; see the upstream [feature request](https://github.com/anomalyco/opencode/issues/30295), currently closed and unimplemented. |
| Shared config | Claude | Atomically merges the sanitized `config/settings.json`, preserving unrelated settings and a backup. |
| MCP inventory | Claude, Codex, OpenCode | Prompts once for redacted secrets and writes selected servers to every selected host. |

Role routing uses project-local `.harness/roles.json` copied from `config/roles.example.json`.
See the [routing guide](../README.md#optional-role-routing-and-herdr).

OpenCode MCP entries use its native local/remote shapes. Codex uses `codex mcp
add`; Claude uses `claude mcp add-json`.
Dry-run performs none of these writes or downloads.
