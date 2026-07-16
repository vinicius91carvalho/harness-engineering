# Installer contracts and maintained decisions

The implementation follows the official host contracts:

- [Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference):
  add/update the marketplace, then `claude plugin update name@marketplace
  --scope ...`, falling back to `plugin install` when needed. Claude accepts
  installer scopes `user`, `project`, and `local`. The Git URL form preserves
  the marketplace's declared name; the `owner/repo` shorthand is not used.
  Shared Claude settings (`shared-config`) and the Claude status-line extra remain
  user-scope only.
- [Codex plugin authoring](https://developers.openai.com/codex/plugins/build):
  `.codex-plugin/plugin.json` is the manifest; the compatible catalog lives at
  `.agents/plugins/marketplace.json` (generated via
  `node scripts/install-reconcile.mjs generate-marketplaces`); marketplace
  sources are managed with `codex plugin marketplace add/upgrade`.
  - **user** scope: the installer uses the target CLI's plugin-add operation
    against the published GitHub marketplace and never copies a manifest into
    the current project.
  - **project** scope: the installer copies `.codex-plugin/plugin.json` and
    `.agents/plugins/marketplace.json` into `--project-dir`, registers that
    directory as a marketplace, then runs `codex plugin add`.
  Codex is the only other host with a status-line extra, wired through its own
  native `[tui] status_line` config rather than a script (see Maintained
  decisions below). That extra is user-scope only.
- [OpenCode configuration](https://opencode.ai/docs/config):
  - **user** scope: plural directories below `~/.config/opencode`.
  - **project** scope: plural directories below `$PROJECT/.opencode`.
  Local MCP servers use the
  [native `mcp` shape](https://opencode.ai/docs/mcp-servers): `type: "local"` and
  an array-valued `command`.

Host × scope destinations (project root = `--project-dir` or cwd):

| Host | user | project |
| --- | --- | --- |
| Claude | marketplace `--scope user`; skills under `~/.claude/skills/` | marketplace `--scope project` (or `local`); skills under `$PROJECT/.claude/skills/` |
| Codex | `codex plugin marketplace add owner/repo` + plugin add | project marketplace layout + `marketplace add $PROJECT` + plugin add |
| OpenCode | `~/.config/opencode/{skills,agents,commands}/` | `$PROJECT/.opencode/{skills,agents,commands}/` |
| Pi | `~/.agents/skills/` | `$PROJECT/.agents/skills/` |
| Cursor Agent | `~/.cursor/plugins/local/<name>/` | `$PROJECT/.cursor/plugins/local/<name>/` |

Maintained decisions:

- `hallmark`, `no-mistakes`, and `treehouse` are not Claude marketplace plugins.
  The catalog records their acquisition policy:
  - `skills` — `npx skills add <repo> --skill <name> --yes` (hallmark).
    Installers read `acquisition.skills` from the catalog (via
    `install-reconcile.mjs skills-add-args`) rather than hardcoding the repo.
    User/global scope passes `-g`; project scope omits `-g` and runs in
    `--project-dir`. ADR-0013 covers marketplace generation, host matrices, and
    this acquisition projection; it does not claim reconcile itself runs `npx`.
  - `installer` / `installerWindows` — upstream shell or PowerShell one-liner
    (no-mistakes, treehouse). These write user-global binaries, so project scope
    never runs them: `treehouse` is user-scope only; `no-mistakes` under project
    scope only runs `no-mistakes init` in `--project-dir` and requires the binary
    already on `PATH` (install it once with `--scope user`).
- Playwright uses Microsoft's upstream host-neutral MCP server and supports
  both `user` and `project` scopes (Claude MCP `--scope` matches the installer
  scope; OpenCode/Cursor write the MCP config under the resolved base). Codex
  MCP has no project scope, so project installs skip Playwright for Codex.
- Crawl4AI under project scope projects only the bundled skill into the host
  project paths; pip/setup remain user-scope so project installs do not write
  global Python tooling.
- Existing model choices win unless a project opts into model candidates through
  `.harness/roles.json`; `config/roles.example.json` is the editable template and
  never a global pin.
- JSON configuration writes retain a pre-normalization backup and replace files
  atomically while preserving unrelated keys.
- The status-line extra copies its script/config into a persistent per-user
  location instead of referencing the installer's ephemeral temp clone (Claude:
  `~/.claude/statusline.sh`); a reference into the temp clone would dangle once
  the installer's own cleanup deletes it. Codex's `~/.codex/config.toml` has no
  bundled dependency for TOML parsing, so its `[tui] status_line` key is
  upserted with a targeted single-pass line rewrite (replace in place if
  present, insert before the next table header otherwise, append a new `[tui]`
  block if absent), backed up first like the JSON writers. OpenCode has no
  native status-line hook upstream (tracked in [its feature
  request](https://github.com/anomalyco/opencode/issues/30295)), so it's
  intentionally excluded rather than faked.
- Install receipts stay under `~/.local/share/harness` and record `scope` plus
  `projectDir` when set.
