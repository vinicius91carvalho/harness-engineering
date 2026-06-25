# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code **plugin marketplace** plus one in-repo plugin (`harness`). The repo root *is* the `harness` plugin — `.claude-plugin/plugin.json` defines it and the marketplace entry uses `source: "./"`. External plugins (`ponytail`, `remember`) are referenced by their GitHub repos in `marketplace.json`, not vendored here.

There is no build, test, or lint step. Changes are validated by installing the marketplace and running Claude Code.

## Always keep scripts and README in sync

When you change any bundled script (e.g. `scripts/statusline.sh`) or a plugin's
behavior, update `README.md` in the same change to match. Docs that drift from
the scripts are worse than no docs.

## Layout

- `.claude-plugin/marketplace.json` — the marketplace: lists every plugin and its source.
- `scripts/` — standalone scripts bundled with the `harness` plugin: `statusline.sh` (status line) and `sync-config.sh` (extracts the shareable config subset; `--selftest`).
- `config/settings.json` — committed shareable subset of `~/.claude/settings.json`, merged in by the installer's "shared config" prompt. Regenerate with `/harness:update-project`.
- `config/mcp.json` — sanitized inventory of locally-configured MCP servers (user/local scope from `~/.claude.json`), written by `/harness:update-project`. Secrets are redacted to `${PLACEHOLDER}`. The installer's "MCP servers" checklist row walks these one by one, prompts (hidden) for each secret, and registers chosen servers at user scope via `claude mcp add-json`; ENTER on a prompt skips that server. Absent until there's an MCP server to back up.
- `config/home/` — backup of loose user content (`skills/`, `commands/`, `agents/`, `hooks/`, `keybindings.json`, global `CLAUDE.md`) authored directly under `~/.claude`. Populated by `/harness:update-project`, restored by the installer's `restore_home`/`Restore-Home`. Absent until there's something to back up (most setups put everything in plugins).
- `skills/update-project/SKILL.md` — `/harness:update-project`: a complete backup of the live Claude setup — regenerates `config/settings.json`, reconciles the plugin roster against live `enabledPlugins`, mirrors loose user content into `config/home/`, and reconciles docs.
- `.github/workflows/ci.yml` — CI: JSON validity, shell syntax, selftests, skill frontmatter.
- `.github/workflows/release.yml` — on push to `main`, computes the next semver from Conventional Commits, tags it, and publishes a GitHub Release. No bump = no release. Keep commit subjects conventional (`feat:`, `fix:`, `feat!:`/`BREAKING CHANGE:` for majors).
- `CHANGELOG.md` — generated. `release.yml` prepends each release's notes under `## [Unreleased]` and commits back (`[skip ci]`). Don't hand-edit released sections; conventional commit subjects *are* the changelog. Optionally stage extra prose under `## [Unreleased]` before a release.
- `.claude-plugin/plugin.json` — manifest for the `harness` plugin itself.
- `install.sh` / `install.ps1` — idempotent installers (sh for macOS/Linux/Git Bash/WSL, ps1 for PowerShell). They add the marketplace, then present a single **arrow-key checklist** (`select_menu` / `Select-Menu`) listing every `REQUIRED` plugin (pre-checked, but toggleable), every `OPTIONAL` plugin, and the three extras (status line, shared config, MCP servers); the whole selection is applied in one pass (MCP servers, if checked, run a per-server secret prompt after the plugins install). `--yes`/`-Yes` checks everything, `--no`/`-No` keeps requireds only, and both that fallback and a missing/unopenable `/dev/tty` skip the TUI. `--dry-run`/`-DryRun` walks the checklist and prints what *would* be installed without changing anything (the local repro tool). They install `jq` if missing.
- Other `harness` plugin content (commands/agents/hooks) would live in the conventional `commands/`, `agents/`, `hooks/` dirs at the repo root — none exist yet.

## Adding a plugin (keep these four in sync)

1. `.claude-plugin/marketplace.json` — add an entry. `source: "./"` for a plugin in this repo, or `{ "source": "github", "repo": "owner/name" }` for external.
2. `install.sh` — add the name to `REQUIRED` or `OPTIONAL`.
3. `install.ps1` — add the name to `$Required` or `$Optional`.
4. `README.md` — add a row to the Plugins table.

## Testing a marketplace change

```sh
claude plugin marketplace update vinicius91carvalho   # refresh after editing marketplace.json
claude plugin install <name>@vinicius91carvalho
```

The marketplace name is `vinicius91carvalho` (from `marketplace.json`'s `name`), distinct from the repo slug `vinicius91carvalho/harness-engineering` used to *add* the marketplace.
