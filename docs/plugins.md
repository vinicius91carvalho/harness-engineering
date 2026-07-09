# Plugins

> *"Some plugins that ship deserve deleting, and some that are deleted deserve shipping — these are the ones worth keeping."*

Everything below is a row in the installer's checklist. Toggle whatever you want and confirm once — only `harness` is pre-checked. The installer only shows plugins compatible with your detected CLI.

| Plugin | CLI Support | Namespace | Source | What it does |
| --- | --- | --- | --- | --- |
| `harness` | claude, opencode, codex, agent | `/harness:*` or `/harness-*` | this repo | My own skills, agents, and scripts — the [spec→build→QA pipeline](../README.md#framework) (`planner`/`generator`/`evaluator` + agents), the [learning loop](../README.md#maintenance), `/harness:update-project`, and the status line. |
| `ponytail` | claude, opencode, codex | `/ponytail:*` | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | Lazy senior-dev mode — forces the simplest solution that works (YAGNI, stdlib first, no unrequested abstractions). |
| `skill-creator` | claude, opencode, codex | agent-based | [anthropics/skills](https://github.com/anthropics/skills) | Multi-agent pipeline to create, evaluate, benchmark, and refine AI coding skills. |
| `codebase-memory-mcp` | claude, opencode, codex | MCP/tool integration | [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) | Signed local code-intelligence binary for 158 languages. Replaces the Claude-only TypeScript, Pyright, and Rust LSP plugins; auto-indexing is enabled during install. |
| `context7` | claude, opencode, codex | MCP server | [upstash/context7](https://github.com/upstash/context7) | Up-to-date, version-specific library docs through the host-neutral MCP endpoint. |
| `playwright` | claude, opencode, codex | MCP server | [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | Browser automation and E2E testing through Microsoft's MCP server. |

Optional role routing uses `config/roles.example.json` copied to `.harness/roles.json`.
Optional worker visibility uses [herdr](https://herdr.dev/) when the supervisor is started with `--display herdr`.
See the [routing and herdr guide](../README.md#optional-role-routing-and-herdr).
