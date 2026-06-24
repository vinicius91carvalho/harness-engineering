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

## Extras

After the plugins, the installer **prompts** to turn on each of these (they
write `~/.claude/settings.json`). Skip the prompts entirely with `--yes`/`--no`.

| Extra | Prompt | Sets | What it does |
| --- | --- | --- | --- |
| Status line | _Enable the harness status line?_ | `statusLine` → bundled `scripts/statusline.sh` | Context % + tokens, 5h / 7d rate limits, git branch + worktrees, tmux session. |
| Remote Control | _Enable Remote Control for all sessions?_ | `remoteControlAtStartup: true` | Every session connects to [Remote Control](https://code.claude.com/docs/en/remote-control) on startup — drive it from the Claude mobile/web app without typing `/remote-control`. |

### Status line preview

![Status line with full parameters](assets/statusline.svg)

### Enabling by hand

```json
"statusLine": {
  "type": "command",
  "command": "bash ~/.claude/plugins/cache/vinicius91carvalho/harness/<version>/scripts/statusline.sh"
},
"remoteControlAtStartup": true
```
