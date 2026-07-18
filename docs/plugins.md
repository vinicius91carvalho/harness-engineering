# Plugins

> *"Some plugins that ship deserve deleting, and some that are deleted deserve shipping — these are the ones worth keeping."*

Everything below is a row in the installer's checklist.
Toggle whatever you want and confirm once - only `harness` is pre-checked.
The installer asks for install scope first (`user` / `project`, plus `local` when Claude is detected), then host, then shows only plugins compatible with that scope and host.
User-only modules (`status-line`, `shared-config`, `treehouse`) are hidden under project scope.

| Plugin | CLI Support | Namespace | Source | What it does |
| --- | --- | --- | --- | --- |
| `harness` | claude, codex, opencode, pi, agent | `/harness:*` or `/harness-*` | this repo | My own skills, agents, and scripts - the [spec→build→QA pipeline](../README.md#framework) (`planner`/`generator`/`evaluator` + agents), the [learning loop](../docs/backup-sync.md), `/harness:update-project`, and the status line. |
| `hallmark` | claude, codex, opencode, agent | `hallmark`, `hallmark audit`, `hallmark redesign`, `hallmark study` | `npx skills add nutlope/hallmark --skill hallmark -g --yes` (user); omit `-g` and run in `--project-dir` (project) | Anti-AI-slop design skill - builds, audits, redesigns, and studies UI with structural variety, twenty themes, and fifty-seven slop-test gates so outputs do not look AI-generated. |
| `no-mistakes` | claude, codex, opencode, pi, agent | `/no-mistakes`, `git push no-mistakes` | user: `curl -fsSL https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.sh \| sh` (Windows: `irm …/docs/install.ps1 \| iex`); project: `no-mistakes init` only (binary must already exist) | Git push gate that runs an AI validation pipeline in an isolated worktree and forwards clean branches only after every check passes, opening PRs automatically. Under user scope, run `no-mistakes init` in each repository you want to gate after install. |
| `treehouse` | claude, codex, opencode, agent | CLI `treehouse` | `curl -fsSL https://kunchenguid.github.io/treehouse/install.sh \| sh` (Windows: `irm https://kunchenguid.github.io/treehouse/install.ps1 \| iex`) | Manage a pool of reusable, isolated git worktrees so each agent gets its own environment instantly - no cloning, no conflicts, no coordination overhead. User-scope only (global CLI). |
| `playwright` | claude, codex, opencode, agent | MCP server | [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | Browser automation and E2E testing through Microsoft's MCP server. Under project scope, Claude/OpenCode/Cursor write project MCP config; Codex is skipped (Codex MCP is user-global only). |
| `crawl4ai` | claude, codex, opencode, pi, agent | skill | `packages/crawl4ai` in this repo | Web crawling and structured extraction. User scope installs the Python package (`pip install -U crawl4ai`, `crawl4ai-setup`, `crawl4ai-doctor`) plus the skill; project scope copies only the bundled skill into the project host paths. |

Host marketplace JSON files (`.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, `.cursor-plugin/marketplace.json`) are generated from `config/installable-catalog.json` and `MARKETPLACE_HOSTS` in `scripts/install-reconcile.mjs`.
Do not hand-edit them; run `node scripts/install-reconcile.mjs generate-marketplaces` after catalog or host-recipe changes, then `node scripts/install-reconcile.mjs validate`.

Optional role routing uses `config/roles.example.json` copied to `.harness/roles.json`.
Workers always run in the background.
See the [routing guide](../README.md#optional-role-routing).
