# Plugins

> *"Some plugins that ship deserve deleting, and some that are deleted deserve shipping — these are the ones worth keeping."*

Everything below is a row in the installer's checklist. Toggle whatever you want and confirm once — only `harness` is pre-checked. The installer only shows plugins compatible with your detected CLI.

| Plugin | CLI Support | Namespace | Source | What it does |
| --- | --- | --- | --- | --- |
| `harness` | claude, opencode, codex | `/harness:*` | this repo | My own skills, agents, and scripts — the [spec→build→QA pipeline](../README.md#framework) (`planner`/`generator`/`evaluator` + agents), the [learning loop](../README.md#learning-loop), `/harness:update-project`, and the status line. |
| `ponytail` | claude, opencode, codex | `/ponytail:*` | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | Lazy senior-dev mode — forces the simplest solution that works (YAGNI, stdlib first, no unrequested abstractions). |
| `context7` | claude | MCP server | [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Up-to-date, version-specific library docs pulled into context (Upstash Context7). |
| `remember` | claude | `/remember:*` | [Digital-Process-Tools/claude-remember](https://github.com/Digital-Process-Tools/claude-remember) | Saves session state to `.remember/` for clean continuation across sessions. |
| `codebase-memory-mcp` | claude, opencode, codex | MCP/tool integration | [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) | Optional signed local binary installed with `--skip-config`, then configured only for selected hosts. It is not a marketplace plugin. |
| `skill-creator` | claude | `/skill-creator:*` | [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Create, improve, and benchmark skills. |
| `claude-md-management` | claude | `/claude-md-management:*` | [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Audit and maintain CLAUDE.md files and project memory. |
| `claude-code-setup` | claude | `/claude-code-setup:*` | [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Recommends tailored Claude Code automations for a codebase. |
| `hookify` | claude | `/hookify:*` | [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Create custom hooks to prevent unwanted behaviors. |
| `playwright` | claude | MCP server | [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Browser automation / E2E testing via Microsoft Playwright. |
| `typescript-lsp` | claude | LSP | [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | TypeScript/JavaScript language server for code intelligence. |
| `ralph-loop` | claude | `/ralph-loop:*` | [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Self-referential iterative loops (the Ralph Wiggum technique). |
| `pyright-lsp` | claude | LSP | [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Python (Pyright) language server for type checking. |
| `rust-analyzer-lsp` | claude | LSP | [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Rust language server for code intelligence. |
| `codex` | claude | `/codex:*` | [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) | Delegate tasks and code review to OpenAI Codex from Claude Code — used for adversarial reviews (a second model challenging the diff). Configure with `/codex:setup`; requires an OpenAI account (`codex login`). |
