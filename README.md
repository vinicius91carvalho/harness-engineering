# harness-engineering

My personal Claude Code workspace, packaged as a plugin marketplace. One command
sets up a fresh machine with every plugin I use.

## Setup

On a new machine with [Claude Code](https://claude.com/claude-code) already installed:

**macOS / Linux / Windows (Git Bash or WSL):**

```sh
curl -sSL https://raw.githubusercontent.com/vinicius91carvalho/harness-engineering/main/install.sh | sh
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/vinicius91carvalho/harness-engineering/main/install.ps1 | iex
```

Then restart Claude Code. The script is idempotent — safe to re-run any time to
pick up new plugins.

Run it non-interactively by answering every prompt up front:

```sh
curl -sSL .../install.sh | sh -s -- --yes   # or --no
```

```powershell
irm .../install.ps1 -OutFile install.ps1; ./install.ps1 -Yes   # or -No
```

`--yes`/`-Yes` accepts every prompt, `--no`/`-No` declines them all.

### Manual install

```sh
claude plugin marketplace add vinicius91carvalho/harness-engineering
claude plugin install harness@vinicius91carvalho
claude plugin install ponytail@vinicius91carvalho
```

## Plugins

The installer always installs the required plugins and **prompts** for each optional one.

| Plugin | Required? | Namespace | Source | What it does |
| --- | --- | --- | --- | --- |
| `harness` | required | `/harness:*` | this repo | My own commands, skills, agents, and hooks. |
| `ponytail` | required | `/ponytail:*` | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | Lazy senior-dev mode — forces the simplest solution that works (YAGNI, stdlib first, no unrequested abstractions). |
| `last30days` | optional | `/last30days:*` | [mvanhorn/last30days-skill](https://github.com/mvanhorn/last30days-skill) | Surfaces what changed in Claude Code over the last 30 days. |
| `remember` | optional | `/remember:*` | [Digital-Process-Tools/claude-remember](https://github.com/Digital-Process-Tools/claude-remember) | Saves session state to `.remember/` for clean continuation across sessions. |
| `context7` | optional | MCP server | [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Up-to-date, version-specific library docs pulled into context (Upstash Context7). |
| `skill-creator` | optional | `/skill-creator:*` | [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Create, improve, and benchmark skills. |
| `playwright` | optional | MCP server | [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Browser automation / E2E testing via Microsoft Playwright. |
| `claude-md-management` | optional | `/claude-md-management:*` | [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Audit and maintain CLAUDE.md files and project memory. |
| `typescript-lsp` | optional | LSP | [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | TypeScript/JavaScript language server for code intelligence. |
| `ralph-loop` | optional | `/ralph-loop:*` | [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Self-referential iterative loops (the Ralph Wiggum technique). |
| `claude-code-setup` | optional | `/claude-code-setup:*` | [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Recommends tailored Claude Code automations for a codebase. |
| `pyright-lsp` | optional | LSP | [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Python (Pyright) language server for type checking. |
| `hookify` | optional | `/hookify:*` | [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Create custom hooks to prevent unwanted behaviors. |
| `rust-analyzer-lsp` | optional | LSP | [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Rust language server for code intelligence. |

## Extras

After the plugins, the installer **prompts** to turn on each of these (they
write `~/.claude/settings.json`). Skip the prompts entirely with `--yes`/`--no`.

| Extra | Prompt | Sets | What it does |
| --- | --- | --- | --- |
| Status line | _Enable the harness status line?_ | `statusLine` → bundled `scripts/statusline.sh` | Two lines: **line 1** model badge + 📁 dir + 🌿 branch (+worktrees); **line 2** context bar + % + tokens, $ session cost, ⏱ countdown to the next 5h window, 5h / 7d rate limits, tmux session. |
| Shared config | _Apply Vinicius's shared Claude config?_ | merges `config/settings.json` → `model`, `worktree`, `preferredNotifChannel`, `inputNeededNotifEnabled`, `agentPushNotifEnabled`, and `remoteControlAtStartup: true` | Deep-merges my shareable settings into `~/.claude/settings.json` (the file's keys win). Includes [Remote Control](https://code.claude.com/docs/en/remote-control) on startup — drive sessions from the Claude mobile/web app without typing `/remote-control`. Machine-specific keys (status line path, enabled plugins) are excluded. Installs `jq` if missing; skips safely if the file or `jq` is unavailable. |

### Status line preview

![Status line with full parameters](assets/statusline.svg)

### Enabling by hand

```json
"statusLine": {
  "type": "command",
  "command": "bash ~/.claude/plugins/cache/vinicius91carvalho/harness/<version>/scripts/statusline.sh"
}
```

For the shared config, merge the keys in [`config/settings.json`](config/settings.json)
into your `~/.claude/settings.json` (e.g. `jq -s '.[0] * .[1]' ~/.claude/settings.json config/settings.json`).

## Keeping the config backup in sync

`/harness:update-project` regenerates `config/settings.json` from your live
`~/.claude/settings.json` (via `scripts/sync-config.sh`, which keeps only the
shareable subset) and reconciles the docs. It reports a diff and commits nothing
unless asked.

CI (`.github/workflows/ci.yml`) checks JSON validity, shell syntax, the
`statusline.sh` / `sync-config.sh` selftests, and the skill frontmatter on every
push and PR.
