# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Keep this file in sync with `AGENTS.md`** — they serve the same purpose for different CLIs.

## What this is

An AI coding plugin marketplace plus one in-repo plugin (`harness`) for **Claude Code**, **OpenCode**, and **Codex**. Claude and Codex use their native manifests and marketplace catalogs; OpenCode installs namespaced skills, agents, and commands. `codebase-memory-mcp` is an optional MCP/tool integration, never a marketplace plugin.

There is no build, test, or lint step. Changes are validated by installing the marketplace and running Claude Code.

## Always keep scripts and README in sync

When you change any bundled script (e.g. `scripts/statusline.sh`) or a plugin's
behavior, update `README.md` in the same change to match. Docs that drift from
the scripts are worse than no docs.

Pipeline behavior lives in workflow skills (`skills/supervisor/`, `skills/generator/`,
`skills/monorepo-supervisor-ops/`, `skills/learning-loop/`), not in this file.
Learning-loop findings update those skills.

## Layout

- `.claude-plugin/marketplace.json` — the marketplace: lists every plugin and its source.
- `.claude-plugin/plugin.json` — manifest for the `harness` plugin (Claude Code).
- `.codex-plugin/plugin.json` — manifest for the `harness` plugin (Codex).
- `opencode.json` — manifest for the `harness` plugin (Opencode).
- `.mcp.json` — MCP server configuration for Opencode and Codex.
- `scripts/` — bundled helpers: `statusline.sh`, `sync-config.sh`, and `jsonc-normalize.js` (string-safe JSONC normalization used before atomic OpenCode writes).
- `config/settings.json` — committed shareable subset of `~/.claude/settings.json`, merged in by the installer's "shared config" prompt. Regenerate with `/harness:update-project`.
- `config/mcp.json` — sanitized inventory of locally-configured MCP servers (user/local scope from `~/.claude.json`), written by `/harness:update-project`. Secrets are redacted to `${PLACEHOLDER}`. The installer's "MCP servers" checklist row walks these one by one, prompts (hidden) for each secret, and registers chosen servers at user scope via `claude mcp add-json`; ENTER on a prompt skips that server. Absent until there's an MCP server to back up.
- `config/home/` — backup of loose user content (`skills/`, `commands/`, `agents/`, `hooks/`, `keybindings.json`, global `CLAUDE.md`) authored directly under `~/.claude`. Populated by `/harness:update-project`, restored by the installer's `restore_home`/`Restore-Home`. Absent until there's something to back up (most setups put everything in plugins).
- `skills/update-project/SKILL.md` — `/harness:update-project`: a complete backup of the live Claude setup — regenerates `config/settings.json`, reconciles the plugin roster against live `enabledPlugins`, mirrors loose user content into `config/home/`, and reconciles docs.
- `skills/planner/`, `skills/generator/`, `skills/evaluator/`, `skills/supervisor/` + `agents/` — the portable **spec→build→QA→Goal Review pipeline**. `project_specs.xml` owns stable Acceptance Checks; `reconcile.mjs` maps them into the append-only execution queue. `claim.sh` uses atomic-directory leases and resumable Run State. One `orchestrator.mjs` state machine drives every worker host through thin `claude -p`/`codex exec`/`opencode run`/`pi -p`/`agent -p` adapters. `harness-control.mjs` lets long-lived Supervisors admit parallel work deterministically, recover durable state, relay Input Requests, and optionally spawn workers in herdr panes without duplicating execution policy. Keep scripts, skills, tests, and README behavior in sync.
- `site/` + `.github/workflows/pages.yml` — build-free project landing page and lesson-style workflow documentation, deployed as a static GitHub Pages artifact. Keep it synchronized with workflow behavior and cover structural changes in `tests/site_test.sh`.
- `.github/workflows/ci.yml` — CI: JSON validity, shell syntax, selftests, skill frontmatter.
- `.github/workflows/release.yml` — on push to `main`, computes the next semver from Conventional Commits, tags it, publishes a GitHub Release, and (in one `[skip ci]` commit) bumps `.claude-plugin/plugin.json`'s `version` to match and prepends the notes to `CHANGELOG.md`. The plugin version is the install cache key, so that bump is what lets `claude plugin update` reach already-installed machines. No bump = no release. Keep commit subjects conventional (`feat:`, `fix:`, `feat!:`/`BREAKING CHANGE:` for majors).
- `CHANGELOG.md` — generated. `release.yml` prepends each release's notes under `## [Unreleased]` and commits back (`[skip ci]`). Don't hand-edit released sections; conventional commit subjects *are* the changelog. Optionally stage extra prose under `## [Unreleased]` before a release.
- `.claude-plugin/plugin.json` — manifest for the `harness` plugin itself.
- `install.sh` / `install.ps1` — idempotent installers (sh for macOS/Linux/Git Bash/WSL, ps1 for PowerShell). They add the marketplace, then present a single **arrow-key checklist** (`select_menu` / `Select-Menu`) listing `harness` (pre-checked, but toggleable), all external plugins, and the three extras (status line, shared config, MCP servers); the whole selection is applied in one pass (MCP servers, if checked, run a per-server secret prompt after the plugins install). Status line targets Claude (bundled `scripts/statusline.sh`, copied to `~/.claude/statusline.sh` so it survives the installer's own temp-clone cleanup) and Codex (native `[tui] status_line` array in `~/.codex/config.toml`); OpenCode has no equivalent hook upstream. `--yes`/`-Yes` checks everything, `--no`/`-No` selects only `harness`, and both that fallback and a missing/unopenable `/dev/tty` skip the TUI. `--dry-run`/`-DryRun` walks the checklist and prints what *would* be installed without changing anything (the local repro tool). `jq` is a hard requirement on `install.sh` (checked up front, not auto-installed).
- `agents/` exists (pipeline agents above); other `harness` plugin content (`commands/`, `hooks/`) would live in the conventional repo-root dirs — none exist yet.

## Adding a plugin (keep these four in sync)

1. `.claude-plugin/marketplace.json` — add an entry. `source: "./"` for a plugin in this repo, or `{ "source": "github", "repo": "owner/name" }` for external.
2. `install.sh` — add the name to `OPTIONAL`.
3. `install.ps1` — add the name to `$Optional`.
4. `README.md` — add a row to the Plugins table.

## Testing a marketplace change

```sh
claude plugin marketplace update harness-engineering   # refresh after editing marketplace.json
claude plugin install <name>@harness-engineering
```

The marketplace name is `harness-engineering` (from `marketplace.json`'s `name`), distinct from the repo slug `vinicius91carvalho/harness-engineering` used to *add* the marketplace.

For Opencode and Codex, the plugin is discovered via `opencode.json` and `.codex-plugin/plugin.json` respectively — no marketplace update needed.
