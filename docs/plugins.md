# Plugins

> *"Some plugins that ship deserve deleting, and some that are deleted deserve shipping — these are the ones worth keeping."*

Everything below is a row in the installer's checklist. Toggle whatever you want and confirm once — only `harness` is pre-checked. The installer only shows plugins compatible with your detected CLI.

| Plugin | CLI Support | Namespace | Source | What it does |
| --- | --- | --- | --- | --- |
| `harness` | claude, opencode, codex, agent | `/harness:*` or `/harness-*` | this repo | My own skills, agents, and scripts — the [spec→build→QA pipeline](../README.md#framework) (`planner`/`generator`/`evaluator` + agents), the [learning loop](../README.md#maintenance), `/harness:update-project`, and the status line. |
| `ponytail` | claude, opencode, codex | `/ponytail:*` | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | Lazy senior-dev mode — forces the simplest solution that works (YAGNI, stdlib first, no unrequested abstractions). |
| `lavish-axi` | claude, opencode, codex, agent | `/lavish`, AXI CLI | `npx skills add kunchenguid/lavish-axi --skill lavish -g` | Lavish Editor for agent HTML artifacts — open, annotate, and send pinpoint feedback on rich HTML in a local browser without screenshots. |
| `no-mistakes` | claude, opencode, codex, pi, agent | `/no-mistakes`, `git push no-mistakes` | `curl -fsSL https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.sh \| sh` (Windows: `irm …/docs/install.ps1 \| iex`) | Git push gate that runs an AI validation pipeline in an isolated worktree and forwards clean branches only after every check passes, opening PRs automatically. Run `no-mistakes init` in each repository you want to gate after install. |
| `treehouse` | claude, opencode, codex, agent | CLI `treehouse` | `curl -fsSL https://kunchenguid.github.io/treehouse/install.sh \| sh` (Windows: `irm https://kunchenguid.github.io/treehouse/install.ps1 \| iex`) | Manage a pool of reusable, isolated git worktrees so each agent gets its own environment instantly — no cloning, no conflicts, no coordination overhead. |
| `firstmate` | claude, opencode, codex, pi, agent | `/afk`, `/bearings`, `/updatefirstmate`, `/stow` | `git clone https://github.com/kunchenguid/firstmate ~/.local/share/firstmate` | Talk to one orchestrator agent that spawns, supervises, and reports on a visible crew of autonomous agents in disposable worktrees. Clone to `~/.local/share/firstmate` (override with `FIRSTMATE_HOME`), then `cd` there and launch your harness. |
| `skill-creator` | claude, opencode, codex | agent-based | `packages/skill-creator` in this repo | Multi-agent pipeline to create, evaluate, benchmark, and refine AI coding skills. |
| `codebase-memory-mcp` | claude, opencode, codex | MCP/tool integration | [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) | Signed local code-intelligence binary for 158 languages. Replaces the Claude-only TypeScript, Pyright, and Rust LSP plugins; auto-indexing is enabled during install. |
| `context7` | claude, opencode, codex | MCP server | [upstash/context7](https://github.com/upstash/context7) | Up-to-date, version-specific library docs through the host-neutral MCP endpoint. |
| `playwright` | claude, opencode, codex | MCP server | [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | Browser automation and E2E testing through Microsoft's MCP server. |
| `crawl4ai` | claude, opencode, codex, pi, agent | skill | `packages/crawl4ai` in this repo | Web crawling and structured extraction: installs the Python package (`pip install -U crawl4ai`, `crawl4ai-setup`, `crawl4ai-doctor`) and copies the bundled crawl4ai skill into each selected host. |

Optional role routing uses `config/roles.example.json` copied to `.harness/roles.json`.
Optional worker visibility uses [herdr](https://herdr.dev/), auto-selected when the supervisor starts inside a herdr workspace with `herdr` installed, or forced with `--display herdr`/`--display background`.
Optional mobile access over Tailscale uses the [Collie](https://github.com/AltanS/collie) herdr plugin.
See the [routing and herdr guide](../README.md#optional-role-routing-and-herdr).
