# Installer contracts and maintained decisions

The implementation follows the official host contracts:

- [Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference):
  add/update the marketplace, then `claude plugin install name@marketplace
  --scope ...`. Only Claude has installer scope selection and the bundled status
  line/shared settings extras. The Git URL form preserves the marketplace's
  declared name; the `owner/repo` shorthand is not used.
- [Codex plugin authoring](https://developers.openai.com/codex/plugins/build):
  `.codex-plugin/plugin.json` is the manifest; the compatible catalog lives at
  `.agents/plugins/marketplace.json`; marketplace sources are managed with
  `codex plugin marketplace add/upgrade`. The installer uses the target CLI's
  plugin-add operation and never copies a manifest into the current project.
- [OpenCode configuration](https://opencode.ai/docs/config): user-wide assets use
  plural directories below `~/.config/opencode`. Local MCP servers use the
  [native `mcp` shape](https://opencode.ai/docs/mcp-servers): `type: "local"` and
  an array-valued `command`.

Maintained decisions:

- Ponytail is compatible with all three hosts. Other third-party plugins appear
  only where their upstream packaging is documented.
- MCP inventory entries are translated to each selected host's native shape;
  secrets are resolved before writing, never left as literal placeholders.
  Same-name user entries are replaced so repeated installs remain idempotent.
  Codex URL registration verifies the saved entry when optional OAuth discovery
  exits nonzero, and suppresses OAuth URLs because they can contain query secrets.
- `remember` is a Claude-only optional plugin. Existing user `.remember/` data is
  never deleted and a live installation is never silently removed.
- [`codebase-memory-mcp`](https://github.com/DeusData/codebase-memory-mcp#installation)
  is an MCP/tool integration, never a marketplace plugin. Its signed/checksummed
  platform binary is installed through upstream `--skip-config`, then configured
  host-by-host. This also follows upstream's multi-agent contract.
- Existing model choices win. No manifest or workflow pins vendor model IDs.
- JSON configuration writes retain a pre-normalization backup and replace files
  atomically while preserving unrelated keys.
