<p align="center">
  <img src="assets/banner.svg" alt="harness-engineering" width="660">
</p>

<p align="center">
  <a href="https://github.com/vinicius91carvalho/harness-engineering/releases/latest"><img alt="Version" src="https://img.shields.io/github/v/release/vinicius91carvalho/harness-engineering?sort=semver&label=version&color=2496ED"></a>
  <a href="https://github.com/vinicius91carvalho/harness-engineering"><img alt="AI Harness Engineering System" src="https://img.shields.io/badge/AI%20Harness%20Engineering-System-8A2BE2"></a>
  <a href="https://github.com/vinicius91carvalho/harness-engineering/releases"><img alt="Last update" src="https://img.shields.io/github/release-date/vinicius91carvalho/harness-engineering?label=last%20update&color=2EA44F"></a>
</p>

<p align="center">
  <b>A curated Claude Code developer workflow — the best plugins out there, set up with one command.</b>
</p>

> *"YOU SHOULD NOT PASS!"* — on the bad plugins, the boilerplate, and the 3am pages.
>
> *"A wizard is never late, nor is he early — he installs precisely the plugins he means to."*
>
> *"All we have to decide is what to do with the config that is given us."*

## About

> *"Not all those who wander are lost."*

`harness-engineering` is my personal Claude Code workspace, packaged as a plugin marketplace. The goal is a batteries-included **developer workflow** assembled from the best Claude Code plugins available — lazy-senior-dev guardrails, up-to-date library docs, session memory, browser automation, language servers, and more — that drops onto a fresh machine with a single command.

It's opinionated but not precious: **feedback, tips, and plugin suggestions are very welcome** — open an [issue](https://github.com/vinicius91carvalho/harness-engineering/issues) or a PR.

## Setup

> *"When in doubt, always follow your nose."*

On a new machine with [Claude Code](https://claude.com/claude-code) already installed, run:

**macOS / Linux / Windows (Git Bash or WSL)**

```sh
curl -sSL https://raw.githubusercontent.com/vinicius91carvalho/harness-engineering/main/install.sh | sh
```

The installer adds the marketplace, then shows an **arrow-key checklist** — ↑/↓ to move, **SPACE** to toggle, **ENTER** to confirm — where you pick everything in a single pass. Required plugins come pre-checked (you can still uncheck them); optional plugins and the two extras start unchecked. Your whole selection is applied at once, and the script is idempotent, so re-run it any time to pick up new plugins. When you're done, restart Claude Code.

A few text notes instead of extra commands to copy:

- **Native Windows (PowerShell):** run [`install.ps1`](install.ps1) instead — the same arrow-key checklist, driven natively.
- **Non-interactive:** the `--yes` flag selects everything and `--no` keeps only the required plugins (PowerShell: `-Yes` / `-No`) — handy for scripted setups.
- **Preview without installing:** the `--dry-run` flag walks the checklist and prints exactly what *would* be installed, changing nothing on your machine.

## Plugins

> *"Some plugins that ship deserve deleting, and some that are deleted deserve shipping — these are the ones worth keeping."*

Everything below is a row in the installer's checklist. Required plugins are pre-checked; optional ones start unchecked. Toggle whatever you want and confirm once.

| Plugin | Required? | Namespace | Source | What it does |
| --- | --- | --- | --- | --- |
| `harness` | required | `/harness:*` | this repo | My own commands, skills, agents, and hooks. |
| `ponytail` | required | `/ponytail:*` | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | Lazy senior-dev mode — forces the simplest solution that works (YAGNI, stdlib first, no unrequested abstractions). |
| `context7` | required | MCP server | [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Up-to-date, version-specific library docs pulled into context (Upstash Context7). |
| `remember` | required | `/remember:*` | [Digital-Process-Tools/claude-remember](https://github.com/Digital-Process-Tools/claude-remember) | Saves session state to `.remember/` for clean continuation across sessions. |
| `skill-creator` | required | `/skill-creator:*` | [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Create, improve, and benchmark skills. |
| `claude-md-management` | required | `/claude-md-management:*` | [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Audit and maintain CLAUDE.md files and project memory. |
| `claude-code-setup` | required | `/claude-code-setup:*` | [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Recommends tailored Claude Code automations for a codebase. |
| `hookify` | required | `/hookify:*` | [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Create custom hooks to prevent unwanted behaviors. |
| `playwright` | required | MCP server | [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Browser automation / E2E testing via Microsoft Playwright. |
| `last30days` | optional | `/last30days:*` | [mvanhorn/last30days-skill](https://github.com/mvanhorn/last30days-skill) | Surfaces what changed in Claude Code over the last 30 days. |
| `typescript-lsp` | optional | LSP | [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | TypeScript/JavaScript language server for code intelligence. |
| `ralph-loop` | optional | `/ralph-loop:*` | [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Self-referential iterative loops (the Ralph Wiggum technique). |
| `pyright-lsp` | optional | LSP | [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Python (Pyright) language server for type checking. |
| `rust-analyzer-lsp` | optional | LSP | [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Rust language server for code intelligence. |
| `codex` | optional | `/codex:*` | [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) | Delegate tasks and code review to OpenAI Codex from Claude Code — used for adversarial reviews (a second model challenging the diff). Configure with `/codex:setup`; requires an OpenAI account (`codex login`). |

## Extras

> *"Keep it secret. Keep it safe."*

These two appear as their own rows at the bottom of the same checklist (they write `~/.claude/settings.json`). Leave them unchecked to skip, or use `--yes`/`--no` to decide for the whole list at once.

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

For the shared config, merge the keys in [`config/settings.json`](config/settings.json) into your `~/.claude/settings.json` (e.g. `jq -s '.[0] * .[1]' ~/.claude/settings.json config/settings.json`).

## Keeping the backup in sync

> *"I have no memory of this config — so it is written down, against the dark."*

`/harness:update-project` makes this repo a restorable backup of your live Claude Code setup. Each run it:

- regenerates `config/settings.json` from `~/.claude/settings.json` (via `scripts/sync-config.sh`, which keeps only the shareable subset);
- reconciles the **plugin roster** against your live `enabledPlugins` — anything you've enabled gets a marketplace entry, an installer line, and a README row, so a fresh `install.sh` reinstalls it (skills/agents/hooks ride along inside their plugins);
- mirrors any **loose user content** (`~/.claude/skills`, `commands`, `agents`, `hooks`, `keybindings.json`, global `CLAUDE.md`) into `config/home/`, which the installer's restore step copies back on a fresh machine. Secrets, history, and caches are never copied.

It reports a diff and commits nothing unless asked.

CI (`.github/workflows/ci.yml`) checks JSON validity, shell syntax, the `statusline.sh` / `sync-config.sh` selftests, and the skill frontmatter on every push and PR.

## Releases

> *"The Road goes ever on and on — and so do the version tags."*

Versions are cut automatically from [Conventional Commits](https://www.conventionalcommits.org) on every push to `main` (`.github/workflows/release.yml`): the next semver is computed from the commit messages, tagged, and published as a GitHub Release.

The three most recent versions:

[![latest](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fapi.github.com%2Frepos%2Fvinicius91carvalho%2Fharness-engineering%2Freleases&query=%24%5B0%5D.tag_name&label=latest&color=2496ED)](https://github.com/vinicius91carvalho/harness-engineering/releases)
[![previous](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fapi.github.com%2Frepos%2Fvinicius91carvalho%2Fharness-engineering%2Freleases&query=%24%5B1%5D.tag_name&label=previous&color=8A8A8A)](https://github.com/vinicius91carvalho/harness-engineering/releases)
[![2 ago](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fapi.github.com%2Frepos%2Fvinicius91carvalho%2Fharness-engineering%2Freleases&query=%24%5B2%5D.tag_name&label=2%20ago&color=8A8A8A)](https://github.com/vinicius91carvalho/harness-engineering/releases)

Full notes for every version are on the [Releases page](https://github.com/vinicius91carvalho/harness-engineering/releases).
