# Optional integrations

| Integration | Hosts | Behavior |
| --- | --- | --- |
| `codebase-memory-mcp` | Claude, Codex, OpenCode | Runs the upstream signed-binary installer with `--skip-config`, verifies the executable, then writes only the selected hosts' native MCP entries. |
| Status line | Claude | Uses the bundled `scripts/statusline.sh`. No Codex or OpenCode status-line support is claimed. |
| Shared config | Claude | Atomically merges the sanitized `config/settings.json`, preserving unrelated settings and a backup. |
| MCP inventory | Claude, Codex, OpenCode | Prompts once for redacted secrets and writes selected servers to every selected host. |

OpenCode MCP entries use its native local/remote shapes. Codex uses `codex mcp
add`; Claude uses `claude mcp add-json`.
Dry-run performs none of these writes or downloads.
