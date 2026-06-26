# Extras

> *"Keep it secret. Keep it safe."*

These appear as their own rows at the bottom of the installer's checklist. Leave them unchecked to skip, or use `--yes`/`--no` to decide for the whole list at once. (Status line and shared config write `~/.claude/settings.json`; MCP servers, if checked, kick off a short per-server prompt after the plugins install.)

| Extra | Prompt | Sets | What it does |
| --- | --- | --- | --- |
| Status line | _Enable the harness status line?_ | `statusLine` → bundled `scripts/statusline.sh` | Two lines: **line 1** model badge + 📁 dir + 🌿 branch (+worktrees); **line 2** context bar + % + tokens, $ session cost, ⏱ countdown to the next 5h window, 5h / 7d rate limits, tmux session. |
| Shared config | _Apply Vinicius's shared Claude config?_ | merges `config/settings.json` → `model`, `worktree`, `preferredNotifChannel`, `inputNeededNotifEnabled`, `agentPushNotifEnabled`, and `remoteControlAtStartup: true` | Deep-merges my shareable settings into `~/.claude/settings.json` (the file's keys win). Includes [Remote Control](https://code.claude.com/docs/en/remote-control) on startup — drive sessions from the Claude mobile/web app without typing `/remote-control`. Machine-specific keys (status line path, enabled plugins) are excluded. Installs `jq` if missing; skips safely if the file or `jq` is unavailable. |
| MCP servers | _Add MCP server "X"? → value for TOKEN?_ | **Claude Code:** registers each chosen server at **user** scope via `claude mcp add-json`. **Opencode/Codex:** writes to `.mcp.json` and (for opencode) merges into `opencode.json`. | Walks the servers in `config/mcp.json` one by one (Brightdata, Playwright). For each you say yes to, it prompts (input hidden) for any API key/token the server needs. Don't want it, or don't have the key? Press **ENTER** to skip that one and continue. Servers with unresolved `${...}` placeholders are excluded automatically. Works identically across all three CLIs. |

`config/mcp.json` is a sanitized inventory of my locally-configured MCP servers (backed up by `/harness:update-project`). Secrets are redacted to `${PLACEHOLDER}`; the installer's **MCP servers** step prompts for the real values at install time. To add one by hand instead: `claude mcp add-json <name> '<json>' --scope user`.

## Status line preview

![Status line with full parameters](../assets/statusline.svg)

## Enabling by hand

**Claude Code:**
```json
"statusLine": {
  "type": "command",
  "command": "bash ~/.claude/plugins/cache/vinicius91carvalho/harness/<version>/scripts/statusline.sh"
}
```

**Opencode:** add to your `~/.config/opencode/opencode.jsonc`:
```json
{
  "skills": { "paths": ["./skills"] },
  "agent": {
    "initializer": { "description": "Scaffolds the project once.", "mode": "subagent", "model": "anthropic/sonnet-4-6" },
    "coding-agent": { "description": "Implements one feature.", "mode": "subagent", "model": "anthropic/sonnet-4-6" },
    "qa-agent": { "description": "Independently QA's one feature.", "mode": "subagent", "model": "anthropic/sonnet-4-6" }
  },
  "command": {
    "harness:planner": { "description": "...", "template": "..." },
    "harness:generator": { "description": "...", "template": "..." },
    "harness:evaluator": { "description": "...", "template": "..." },
    "harness:learning-loop": { "description": "...", "template": "..." },
    "harness:update-project": { "description": "...", "template": "..." }
  },
  "mcp": {
    "brightdata": { "type": "sse", "url": "https://mcp.brightdata.com/sse?token=YOUR_TOKEN" },
    "playwright": { "type": "local", "command": ["npx", "-y", "@playwright/mcp"], "enabled": true }
  }
}
```

**Codex:** ensure `.codex-plugin/plugin.json` exists in your project root (it does — shipped with this repo). It contains the same agents, commands, and skills. MCP servers go in `.mcp.json` at the project root.

For the shared config, merge the keys in [`config/settings.json`](../config/settings.json) into your CLI's config file:
- Claude Code: `~/.claude/settings.json`
- Opencode: `~/.config/opencode/opencode.jsonc`
- Codex: `.codex-plugin/plugin.json`
