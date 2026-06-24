# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code **plugin marketplace** plus one in-repo plugin (`harness`). The repo root *is* the `harness` plugin — `.claude-plugin/plugin.json` defines it and the marketplace entry uses `source: "./"`. External plugins (`ponytail`, `last30days`) are referenced by their GitHub repos in `marketplace.json`, not vendored here.

There is no build, test, or lint step. Changes are validated by installing the marketplace and running Claude Code.

## Always keep scripts and README in sync

When you change any bundled script (e.g. `scripts/statusline.sh`) or a plugin's
behavior, update `README.md` in the same change to match. Docs that drift from
the scripts are worse than no docs.

## Layout

- `.claude-plugin/marketplace.json` — the marketplace: lists every plugin and its source.
- `scripts/` — standalone scripts bundled with the `harness` plugin: `statusline.sh` (status line) and `sync-config.sh` (extracts the shareable config subset; `--selftest`).
- `config/settings.json` — committed shareable subset of `~/.claude/settings.json`, merged in by the installer's "shared config" prompt. Regenerate with `/harness:update-project`.
- `skills/update-project/SKILL.md` — `/harness:update-project`: regenerates `config/settings.json` from live config and reconciles docs.
- `.github/workflows/ci.yml` — CI: JSON validity, shell syntax, selftests, skill frontmatter.
- `.claude-plugin/plugin.json` — manifest for the `harness` plugin itself.
- `install.sh` / `install.ps1` — idempotent installers (sh for macOS/Linux/Git Bash/WSL, ps1 for PowerShell). They add the marketplace, install `REQUIRED` plugins unconditionally, prompt per-plugin for `OPTIONAL` ones, and prompt for extras (status line, shared config). They install `jq` if missing.
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
