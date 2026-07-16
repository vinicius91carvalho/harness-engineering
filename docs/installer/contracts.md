# Installer contracts and maintained decisions

The implementation follows the official host contracts:

- [Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference):
  add/update the marketplace, then `claude plugin update name@marketplace
  --scope ...`, falling back to `plugin install` when needed. Only Claude has
  installer scope selection and the bundled shared settings extra. The Git URL
  form preserves the marketplace's declared name; the `owner/repo` shorthand
  is not used.
- [Codex plugin authoring](https://developers.openai.com/codex/plugins/build):
  `.codex-plugin/plugin.json` is the manifest; the compatible catalog lives at
  `.agents/plugins/marketplace.json`; marketplace sources are managed with
  `codex plugin marketplace add/upgrade`. The installer uses the target CLI's
  plugin-add operation and never copies a manifest into the current project.
  Codex is the only other host with a status-line extra, wired through its own
  native `[tui] status_line` config rather than a script (see Maintained
  decisions below).
- [OpenCode configuration](https://opencode.ai/docs/config): user-wide assets use
  plural directories below `~/.config/opencode`. Local MCP servers use the
  [native `mcp` shape](https://opencode.ai/docs/mcp-servers): `type: "local"` and
  an array-valued `command`.

Maintained decisions:

- `hallmark`, `no-mistakes`, and `treehouse` are not Claude marketplace plugins.
  The catalog records their real acquisition policy:
  - `skills` — `npx skills add <repo> --skill <name>` with optional `global`
    for user-wide install (hallmark).
  - `installer` / `installerWindows` — upstream shell or PowerShell one-liner
    (no-mistakes, treehouse). `no-mistakes init` is a per-repository follow-up
    the harness installer does not run.
- Playwright uses Microsoft's upstream host-neutral MCP server.
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
