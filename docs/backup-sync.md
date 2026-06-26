# Keeping the backup in sync

> *"I have no memory of this config — so it is written down, against the dark."*

`/harness:update-project` makes this repo a restorable backup of your live AI coding setup (Claude Code, Opencode, or Codex). Each run it:

- regenerates `config/settings.json` from `~/.claude/settings.json` (via `scripts/sync-config.sh`, which keeps only the shareable subset);
- reconciles the **plugin roster** against your live `enabledPlugins` — anything you've enabled gets a marketplace entry, an installer line, and a README row, so a fresh `install.sh` reinstalls it (skills/agents/hooks ride along inside their plugins);
- mirrors any **loose user content** (`~/.claude/skills`, `commands`, `agents`, `hooks`, `keybindings.json`, global `CLAUDE.md`) into `config/home/`, which the installer's restore step copies back on a fresh machine. Secrets, history, and caches are never copied.

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

CI (`.github/workflows/ci.yml`) checks JSON validity, shell syntax, the `statusline.sh` / `sync-config.sh` selftests, and the skill frontmatter on every push and PR.
