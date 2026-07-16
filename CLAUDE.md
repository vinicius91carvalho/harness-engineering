# CLAUDE.md

> **Generated from `AGENTS.md`.** Do not hand-edit. Regenerate with `node scripts/install-reconcile.mjs sync-agent-docs`.

This file provides guidance to Opencode, Codex, Claude Code, and other AI coding agents when working with code in this repository.

## What this is

An AI coding plugin marketplace plus one in-repo plugin (`harness`) for **Claude Code**, **OpenCode**, **Codex**, **Cursor Agent**, and **Pi**.
Claude/Codex/Cursor use marketplace catalogs; OpenCode and Pi receive projected skills/agents from the installer.

There is no build artifact.
Changes are validated by CI selftests plus installing the marketplace and running the CLI.

## Always keep scripts and README in sync

When you change any bundled script (e.g. `scripts/statusline.sh`) or a plugin's
behavior, update `README.md` in the same change to match.
Docs that drift from the scripts are worse than no docs.

## Runtime-validate external agent bundles

Static file checks are not sufficient for bundled external-agent formats.
When changing worker host adapters, run headless orchestrator and supervisor
tests with authenticated CLIs; add the smallest regression check for any
runtime defect found.

Pipeline behavior lives in workflow skills (`skills/supervisor/`, `skills/generator/`,
`skills/monorepo-supervisor-ops/`, `skills/learning-loop/`), not in this file.
Learning-loop findings update those skills.

## Layout

- `.claude-plugin/marketplace.json` - generated marketplace (Claude): lists every plugin and its source.
- `.agents/plugins/marketplace.json` - generated marketplace (Codex-compatible).
- `.cursor-plugin/marketplace.json` - generated marketplace (Cursor).
- `.claude-plugin/plugin.json` - manifest for the `harness` plugin (Claude Code).
- `.codex-plugin/plugin.json` - manifest for the `harness` plugin (Codex).
- `config/installable-catalog.json` - source of truth for installable modules, hosts, and optional ids (installers + `scripts/install-reconcile.mjs` read this).
- `.mcp.json` - MCP server configuration for Opencode and Codex.
- `config/roles.example.json` - optional per-role tool/model routing template copied to `.harness/roles.json`.
- `scripts/` - bundled helpers: `statusline.sh`, `sync-config.sh`, `jsonc-normalize.js` (string-safe JSONC normalization used before atomic OpenCode writes), `install-reconcile.mjs` (catalog projection, marketplace generation, agent-doc sync, receipts), and `project-bundle.mjs`.
- `config/settings.json` - committed shareable subset of `~/.claude/settings.json`, merged in by the installer's "shared config" prompt. Regenerate with `/harness:update-project`.
- `config/home/` - sanitized multi-host backup layout (`claude/`, `codex/`, `opencode/`) populated by `/harness:update-project`. See `docs/backup-sync.md`. Absent until there's something to back up (most setups put everything in plugins).
- `skills/update-project/SKILL.md` - `/harness:update-project`: backup of detected host setups - regenerates `config/settings.json`, reconciles the plugin roster, mirrors loose user content into `config/home/`, and reconciles docs.
- `skills/planner/` (bundled `grilling` skill), `skills/generator/`, `skills/evaluator/`, `skills/supervisor/` + `agents/` - the portable **spec→build→QA→Goal Review pipeline**. Planner grills ambiguities, trade-offs, and edge cases into a draft, then `spec-review.mjs open` serves a blocking localhost review until the user submits before `project_specs.xml` is finalized, at which point the project is registered automatically in `.harness/projects.json` for cross-session discovery; `reconcile.mjs` projects Acceptance Checks into immutable `feature_list.json` with `planning_decision_ids`. Mutable progress (implementation, QA, integration, Attempt, Blocking Scope) lives in the Execution Ledger under the shared Git directory. `claim.sh` uses atomic-directory leases and resumable Run State. One `orchestrator.mjs` state machine drives every worker host through thin `claude -p`/`codex exec`/`opencode run`/`pi -p`/`agent -p` adapters. `harness-control.mjs` owns the append-only fail-closed Control Journal, host-wide Resource Governor admission, guarded fleet recovery commands, and long-lived Supervisors that relay Input Requests without duplicating execution policy. Evidence Artifacts are create-only under `.git/harness-evidence/`. Keep scripts, skills, tests, and README behavior in sync.
- `packages/crawl4ai/` - bundled optional plugin installed from `packages/` (not `skills/`).
- `site/` + `.github/workflows/pages.yml` - build-free project landing page and lesson-style workflow documentation, deployed as a static GitHub Pages artifact. Keep it synchronized with workflow behavior and cover structural changes in `tests/site_test.sh`.
- `.github/workflows/ci.yml` - CI: JSON validity, shell syntax, selftests, spec-review Chromium E2E, skill frontmatter.
- `.github/workflows/release.yml` - on push to `main`, computes the next semver from Conventional Commits, tags it, publishes a GitHub Release, and (in one `[skip ci]` commit) bumps `.claude-plugin/plugin.json`'s `version` to match and prepends the notes to `CHANGELOG.md`. The plugin version is the install cache key, so that bump is what lets `claude plugin update` reach already-installed machines. No bump = no release. Keep commit subjects conventional (`feat:`, `fix:`, `feat!:`/`BREAKING CHANGE:` for majors).
- `CHANGELOG.md` - generated. `release.yml` prepends each release's notes under `## [Unreleased]` and commits back (`[skip ci]`). Don't hand-edit released sections; conventional commit subjects *are* the changelog. Optionally stage extra prose under `## [Unreleased]` before a release.
- `.claude-plugin/plugin.json` - manifest for the `harness` plugin itself.
- `install.sh` / `install.ps1` - idempotent installers (sh for macOS/Linux/Git Bash/WSL, ps1 for PowerShell). They detect all available CLIs, then let you pick install scope (`user` global vs `project` folder via `--scope`/`-Scope` and `--project-dir`/`-ProjectDir`; Claude also offers `local`), then present a single **arrow-key checklist** (`select_menu` / `Select-Menu`) listing `harness` (pre-checked, but toggleable), all external plugins, and extras (status line, shared config); the whole selection is applied in one pass. Project destinations depend on the selected host (OpenCode `.opencode/`, Pi `.agents/skills/`, Cursor `.cursor/`, Claude skills/plugins, Codex project marketplace layout). User-only modules (`status-line`, `shared-config`, `treehouse`) are skipped for project scope. Status line targets Claude (bundled `scripts/statusline.sh`, copied to `~/.claude/statusline.sh` so it survives the installer's own temp-clone cleanup) and Codex (native `[tui] status_line` array in `~/.codex/config.toml`); OpenCode and Cursor Agent have no equivalent hook upstream. `--yes`/`-Yes` checks everything, `--no`/`-No` selects only `harness`, and both that fallback and a missing/unopenable `/dev/tty` skip the TUI (defaulting scope to `user`). `--dry-run`/`-DryRun` walks the checklist and prints what *would* be installed without changing anything (the local repro tool). `jq` is a hard requirement on `install.sh` (checked up front, not auto-installed).
- `agents/` exists (pipeline agents above); other `harness` plugin content (`commands/`, `hooks/`) would live in the conventional repo-root dirs - none exist yet.

## Adding a plugin (keep these in sync)

1. `config/installable-catalog.json` - add the module (`id`, `hosts`, `kind`, acquisition/source).
2. If the module belongs in a host marketplace, add its id to `MARKETPLACE_HOSTS` in `scripts/install-reconcile.mjs`, then run `node scripts/install-reconcile.mjs generate-marketplaces` (writes `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, `.cursor-plugin/marketplace.json`). Claude's marketplace intentionally excludes some optionals (enforced by tests).
3. `docs/plugins.md` - add a row to the Plugins table (host column must match the catalog).
4. Run `node scripts/install-reconcile.mjs validate` (and installer selftests) so fallbacks stay aligned.
5. If you edited `AGENTS.md`, run `node scripts/install-reconcile.mjs sync-agent-docs` so `CLAUDE.md` stays projected.

## Testing a marketplace change

```sh
node scripts/install-reconcile.mjs generate-marketplaces
node scripts/install-reconcile.mjs validate
claude plugin marketplace update harness-engineering   # refresh after editing marketplace.json
claude plugin install <name>@harness-engineering
```

The marketplace name is `harness-engineering` (from `marketplace.json`'s `name`), distinct from the repo slug `vinicius91carvalho/harness-engineering` used to *add* the marketplace.

OpenCode/Pi have no repo plugin manifest; the installer projects skills via `install-reconcile.mjs`.
Codex uses `.codex-plugin/plugin.json`.
