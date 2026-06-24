# harness-engineering

My personal Claude Code workspace, packaged as a plugin marketplace. One command
sets up a fresh machine with every plugin I use.

## Setup

On a new machine with [Claude Code](https://claude.com/claude-code) already installed:

**macOS / Linux / Windows (Git Bash or WSL):**

```sh
curl -sSL https://raw.githubusercontent.com/vinicius91carvalho/harness-engineering/master/install.sh | sh
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/vinicius91carvalho/harness-engineering/master/install.ps1 | iex
```

Then restart Claude Code. The script is idempotent — safe to re-run any time to
pick up new plugins.

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

## Status line

`scripts/statusline.sh` is a standalone status line bundled with the `harness`
plugin. It shows: context used % + token counts, 5h / 7d rate-limit usage
(Pro/Max), current branch + worktree, all worktrees (current marked `*`), and
the tmux session name.

![Status line with full parameters](assets/statusline.svg)

The installer offers to enable it for you — answer `y` to the status-line
prompt and it points `~/.claude/settings.json` at the installed script.

To enable it by hand instead, set this in `~/.claude/settings.json` (point at
the installed script):

```json
"statusLine": {
  "type": "command",
  "command": "bash ~/.claude/plugins/cache/vinicius91carvalho/harness/<version>/scripts/statusline.sh"
}
```

## Remote Control

The installer also offers to **Enable Remote Control for all sessions** — answer
`y` and it sets `remoteControlAtStartup: true` in `~/.claude/settings.json`, so
every interactive session connects to [Remote Control](https://code.claude.com/docs/en/remote-control)
on startup (control sessions from the Claude mobile/web app without typing
`/remote-control`).

To set it by hand:

```json
"remoteControlAtStartup": true
```
