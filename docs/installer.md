# Installer options

> *"One click to rule them all."*

Both `install.sh` (macOS/Linux/Git Bash/WSL) and `install.ps1` (PowerShell) support the same flags for scripted and non-interactive use.

## Flags

| Flag | Description |
| --- | --- |
| `--yes` / `-Yes` | Selects **everything** in the checklist (plugins + extras). Skips the TUI. |
| `--no` / `-No` | Selects **only `harness`**. Skips the TUI. Handy for minimal setups. |
| `--dry-run` / `-DryRun` | Walks the checklist and prints what *would* be installed, changing nothing. |
| `--scope=user\|project\|local` / `-Scope user\|project\|local` | Sets installation scope without prompting. |

## Scope

The installer prompts for installation scope before the checklist (only for Claude Code):

| Scope | Description |
| --- | --- |
| `user` | Available across all projects (default) |
| `project` | Only in the current directory (`.claude-plugin/` for Claude Code, `.codex-plugin/` for Codex, `opencode.json` for OpenCode) |
| `local` | Only in the current directory (private, not shared) |

## CLI selection

The installer auto-detects all available CLIs on your machine (`claude`, `opencode`, `codex`). If you have multiple, it prompts you to pick one — or install for all of them at once. With `--yes`/`--no`, it installs for all detected CLIs.

## Adding a new plugin

To add a plugin to the installer, update these four files in sync:

1. `.claude-plugin/marketplace.json` — add an entry.
2. `install.sh` — add the name to `OPTIONAL`.
3. `install.ps1` — add the name to `$Optional`.
4. `README.md` — add a row to the [Plugins table](plugins.md).
