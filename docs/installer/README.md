# Installer behavior

The shell and PowerShell installers target Claude Code, Codex, OpenCode, Cursor
Agent, and Pi (shell). Both require Node.js 18 or newer and `jq`, and stop
before making changes when Node is missing or too old. `jq` is not auto-installed.

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
./install.sh --cli opencode --scope project --project-dir /path/to/app --no
```

```powershell
.\install.ps1 -Cli codex -No
.\install.ps1 -Cli all -Yes -DryRun
.\install.ps1 -Version v2.0.0 -Cli codex -No
.\install.ps1 -Cli claude -Scope project -ProjectDir C:\repo -No
.\install.ps1 -Project -Cli opencode -No
```

`--cli`/`-Cli` selects hosts. `--yes`/`-Yes` selects every compatible checklist
item; `--no`/`-No` selects only harness. With several detected CLIs and no usable
terminal, `--cli` is required. Interactively, the host selector, install-scope
selector (`user` / `project`, plus `local` when Claude is the sole host), and the
plugin checklist all move with Up/Down (the host menu also accepts numbers) and
confirm with Enter; in the checklist, Space toggles the highlighted item, `a`
selects or clears all (harness starts checked but is toggleable), and `q`
cancels. Each option shows a dim description on the line below its name. Both
menus repaint in place on the alternate screen, so navigation never duplicates
lines and the terminal mode is always restored on exit.

OpenCode detection checks `PATH` plus the official installer's user binary
location (`~/.opencode/bin`), so it remains selectable before the current shell
reloads its startup file.

`--scope` / `-Scope`, `--project-dir` / `-ProjectDir`, and the
`--user`/`--project`/`--local` (or `-User`/`-Project`/`-Local`) aliases choose
where assets land. Default is `user` when scope is omitted on a non-interactive
run (`--yes`/`-Yes`, `--no`/`-No`, or no TTY). Interactively, a scope menu runs
after host selection. `project` writes under `--project-dir` (default: current
directory) for OpenCode (`.opencode/`), Pi (`.agents/skills/`), Cursor
(`.cursor/`), Claude skills (`.claude/skills/`), and Claude plugins
(`--scope project`). `local` is valid only when Claude is the sole selected host.
User-only extras (`status-line`, `shared-config`) are hidden from the checklist
and skipped under `project` scope. `hallmark` uses `npx skills add` with `-g` for
user/global scope, and without `-g` (in `--project-dir`) for project scope.
`no-mistakes` project scope also runs `no-mistakes init` in the project.
Codex `project` scope copies `.codex-plugin/plugin.json` and
`.agents/plugins/marketplace.json` into the project, registers that directory as
a marketplace, then runs `codex plugin add`. Receipts stay under
`~/.local/share/harness` and record scope plus `projectDir` when set.

```sh
./install.sh --cli claude --scope user --no
./install.sh --cli opencode --scope project --project-dir /path/to/app --no
```

```powershell
.\install.ps1 -Cli claude -Scope user -No
.\install.ps1 -Cli opencode -Scope project -ProjectDir C:\repo -No
```

Dry-run is a strict zero-write mode: it does not clone, download, invoke host
CLIs, normalize configuration, install dependencies, or run post-install actions.

Claude and Codex use their marketplace/plugin CLIs (Codex project scope also
projects marketplace manifests). OpenCode receives namespaced skills, agents, and
commands under `~/.config/opencode` (user) or `$PROJECT/.opencode` (project).
Pi copies harness skills into `~/.agents/skills/` or `$PROJECT/.agents/skills/`
and, for user scope, removes any prior package clone of this repo under
`~/.pi/agent/git/...`. A piped PowerShell run stages the repository before it
needs assets, because `$PSScriptRoot` is empty.

Playwright and Crawl4AI are optional integrations on all hosts.

Optional role routing uses `config/roles.example.json` copied to `.harness/roles.json`.
The [complete guide](../../README.md#optional-role-routing) shows routing and background worker monitoring.
