# Installer behavior

The shell and PowerShell installers target Claude Code, Codex, and OpenCode.

```sh
./install.sh --cli claude --no
./install.sh --cli all --yes --dry-run
```

```powershell
.\install.ps1 -Cli codex -No
.\install.ps1 -Cli all -Yes -DryRun
```

`--cli`/`-Cli` selects hosts. `--yes`/`-Yes` selects every compatible checklist
item; `--no`/`-No` selects only harness. With several detected CLIs and no usable
terminal, `--cli` is required. The interactive host selector accepts numbers,
Up/Down, and Enter and rejects invalid input without changing the terminal mode.

`--scope`/`-Scope` is Claude-only and accepts `user`, `project`, or `local`.
Codex and OpenCode installs are user-wide.

Dry-run is a strict zero-write mode: it does not clone, download, invoke host
CLIs, normalize configuration, install dependencies, or run post-install actions.

Claude and Codex use their marketplace/plugin CLIs. OpenCode receives namespaced
skills, agents, and commands under `~/.config/opencode`. A piped PowerShell run
stages the repository before it needs assets, because `$PSScriptRoot` is empty.

`remember` is offered only to Claude Code. `codebase-memory-mcp` is a separate
optional integration on all hosts: the upstream installer runs with
`--skip-config`, the binary is verified, then only selected hosts are configured.
Existing `.remember/` data is never removed.
