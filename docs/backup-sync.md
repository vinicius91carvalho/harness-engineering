# Keeping the backup in sync

> *"I have no memory of this config — so it is written down, against the dark."*

`/harness:update-project` builds separate sanitized backups for every detected
host. Claude content goes under `config/home/claude`, Codex under
`config/home/codex`, and OpenCode under `config/home/opencode`. It preserves only
user-authored skills, agents, commands, hooks, and instruction files.

Credentials, tokens, histories, conversations, sessions, caches, logs, indexes,
telemetry, and installed plugin payloads are excluded. MCP secrets become named
`${PLACEHOLDER}` values and each host retains its native MCP schema.
`codebase-memory-mcp` remains a separately installed MCP/tool integration.

Two more files are written at the repository root, not under `config/home/`:

- `config/settings.json` — a committed, shareable subset of `~/.claude/settings.json`
  (e.g. `model`, `worktree.baseRef`, notification preferences). Merged in by the
  installer's "shared config" prompt.
- `config/mcp.json` — a sanitized inventory of locally-configured MCP servers
  (user/local scope from `~/.claude.json`). Secrets are redacted to
  `${PLACEHOLDER}`; the installer's MCP checklist prompts for each secret and
  registers chosen servers with `claude mcp add-json`.

Both are absent until there's something to back up, and both are regenerated
by `/harness:update-project`, not hand-edited.

`CHANGELOG.md` is unrelated to this backup: `release.yml` prepends each
release's notes to it automatically from Conventional Commit subjects on
push to `main`.

Skills installed by a package manager aren't vendored here — they're reinstalled from source. The ones I use from [Matt Pocock's pack](https://github.com/mattpocock/skills) (symlinked into `~/.claude/skills`) restore with `npx skills@latest add mattpocock/skills`:

- `design-an-interface` — generate several radically different interface/API designs in parallel.
- `domain-modeling` — build and sharpen a project's domain model / ubiquitous language.
- `grilling` — a relentless interview that stress-tests a plan or design before building.
- `grill-with-docs` — grilling that also writes ADRs and a glossary as it goes.
- `improve-codebase-architecture` — scan for deepening opportunities, report them, then grill the one you pick.
- `prototype` — build a throwaway prototype to flesh out a design.
- `tdd` — test-driven development (red-green-refactor, integration tests).
- `teach` — teach a new skill or concept within the workspace.

It reports a diff and commits nothing unless asked.

CI checks JSON/assets, shell syntax, installer behavior, portable orchestration,
concurrent locking, PowerShell parsing, and bundled script selftests.
