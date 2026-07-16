# Plugins

> *"Some plugins that ship deserve deleting, and some that are deleted deserve shipping — these are the ones worth keeping."*

Everything below is a row in the installer's checklist. Toggle whatever you want and confirm once — only `harness` is pre-checked. The installer only shows plugins compatible with your detected CLI.

| Plugin | CLI Support | Namespace | Source | What it does |
| --- | --- | --- | --- | --- |
| `harness` | claude, codex, opencode, pi, agent | `/harness:*` or `/harness-*` | this repo | My own skills, agents, and scripts - the [spec→build→QA pipeline](../README.md#framework) (`planner`/`generator`/`evaluator` + agents), the [learning loop](../docs/backup-sync.md), `/harness:update-project`, and the status line. |
| `hallmark` | claude, codex, opencode, agent | `hallmark`, `hallmark audit`, `hallmark redesign`, `hallmark study` | `npx skills add nutlope/hallmark --skill hallmark -g` | Anti-AI-slop design skill - builds, audits, redesigns, and studies UI with structural variety, twenty themes, and fifty-seven slop-test gates so outputs do not look AI-generated. |
| `no-mistakes` | claude, codex, opencode, pi, agent | `/no-mistakes`, `git push no-mistakes` | `curl -fsSL https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.sh \| sh` (Windows: `irm …/docs/install.ps1 \| iex`) | Git push gate that runs an AI validation pipeline in an isolated worktree and forwards clean branches only after every check passes, opening PRs automatically. Run `no-mistakes init` in each repository you want to gate after install. |
| `treehouse` | claude, codex, opencode, agent | CLI `treehouse` | `curl -fsSL https://kunchenguid.github.io/treehouse/install.sh \| sh` (Windows: `irm https://kunchenguid.github.io/treehouse/install.ps1 \| iex`) | Manage a pool of reusable, isolated git worktrees so each agent gets its own environment instantly - no cloning, no conflicts, no coordination overhead. |
| `skill-creator` | claude, codex, opencode, pi, agent | agent-based | `packages/skill-creator` in this repo | Multi-agent pipeline to create, evaluate, benchmark, and refine AI coding skills. |
| `playwright` | claude, codex, opencode, agent | MCP server | [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | Browser automation and E2E testing through Microsoft's MCP server. |
| `crawl4ai` | claude, codex, opencode, pi, agent | skill | `packages/crawl4ai` in this repo | Web crawling and structured extraction: installs the Python package (`pip install -U crawl4ai`, `crawl4ai-setup`, `crawl4ai-doctor`) and copies the bundled crawl4ai skill into each selected host. |

Optional role routing uses `config/roles.example.json` copied to `.harness/roles.json`.
Workers always run in the background.
See the [routing guide](../README.md#optional-role-routing).
