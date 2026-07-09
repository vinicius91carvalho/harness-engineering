# Installer behavior

The shell and PowerShell installers target Claude Code, Codex, and OpenCode;
the shell installer (`install.sh`) also targets Pi. Both require Node.js 18 or
newer and stop before making changes when it is missing or too old.

Remote installs (for example `curl …/main/install.sh | sh`) fetch the installer
script from `main`, then clone the **latest GitHub Release tag** into a
temporary staging directory. Pin a specific release with `--version vX.Y.Z`
(`install.sh`), `-Version vX.Y.Z` (`install.ps1`), or the environment variables
`VERSION` / `HARNESS_INSTALL_REF`. A local checkout that contains
`.claude-plugin/marketplace.json` next to the installer skips cloning and
stages the working tree instead (dev mode).

```sh
./install.sh --cli claude --no
./install.sh --cli all --yes --dry-run
./install.sh --version v2.0.0 --cli claude --no
```

```powershell
.\install.ps1 -Cli codex -No
.\install.ps1 -Cli all -Yes -DryRun
.\install.ps1 -Version v2.0.0 -Cli codex -No
```

`--cli`/`-Cli` selects hosts. `--yes`/`-Yes` selects every compatible checklist
item; `--no`/`-No` selects only harness. With several detected CLIs and no usable
terminal, `--cli` is required. Interactively, the host selector and the plugin
checklist both move with Up/Down (the host menu also accepts numbers) and confirm
with Enter; in the checklist, Space toggles the highlighted item, `a` selects or
clears all (harness starts checked but is toggleable), and `q` cancels. Both menus
repaint in place on the alternate screen, so navigation never duplicates lines and
the terminal mode is always restored on exit.

OpenCode detection checks `PATH` plus the official installer's user binary
location (`~/.opencode/bin`), so it remains selectable before the current shell
reloads its startup file. The MCP inventory is installed into every selected
host. Secret prompts accept pasted values while keeping them masked (shell input
is fully hidden; PowerShell displays `*` per character).

`--scope`/`-Scope` is Claude-only and accepts `user`, `project`, or `local`.
Codex and OpenCode installs are user-wide.

Dry-run is a strict zero-write mode: it does not clone, download, invoke host
CLIs, normalize configuration, install dependencies, or run post-install actions.

Claude and Codex use their marketplace/plugin CLIs. OpenCode receives namespaced
skills, agents, and commands under `~/.config/opencode`. Pi copies harness skills
into the user skill root (`~/.agents/skills/`) and removes any prior package
clone of this repo under `~/.pi/agent/git/...`, so user-level skills win over
package skills and avoid Pi skill-name collisions. A piped PowerShell run stages
the repository before it needs assets, because `$PSScriptRoot` is empty.

`codebase-memory-mcp`, Context7, and Playwright are optional MCP integrations on
all hosts. The memory server's upstream installer runs with `--skip-config`, its
binary is verified, auto-indexing is enabled, then only selected hosts are configured.

Optional role routing uses `config/roles.example.json` copied to `.harness/roles.json`.
The [complete guide](../../README.md#optional-role-routing-and-herdr)
shows routing and herdr visibility.
