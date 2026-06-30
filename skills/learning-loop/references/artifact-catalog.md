# Artifact catalog — how to scaffold each finding

Read this in Step 4 of the learning loop, once the user has approved findings.
Each section says **when it's the right call** and **how to create it**.

## skill

**When:** a multi-step procedure was re-derived from scratch, especially more than
once (e.g. "build → run migrations → deploy to staging → smoke test → promote").

**How:** write a minimal `skills/<name>/SKILL.md` with `name`/`description`
frontmatter, explicit trigger phrases, and the procedure as imperative steps.

## instruction rule

**When:** the user corrected the same behavior repeatedly, or stated a rule
("always run tests before committing", "never edit generated files").

**How:** propose one focused imperative rule under the relevant section of the
project's `AGENTS.md`. This is advisory rather than deterministic, but it is portable
across all three supported hosts. Use CI when deterministic enforcement is required.

## subagent (agent)

**When:** a delegatable, context-heavy, specialized task you'd rather hand to a
focused worker than do inline (e.g. "investigate every flaky test and report",
"review this diff for security issues"). Good agent tasks are self-contained and
return a digest rather than dumping everything into the main context.

**How:** write a markdown file with frontmatter:

```markdown
---
name: <kebab-name>
description: <when to use this agent — be specific about triggers>
tools: Read, Grep, Glob, Bash   # optional; omit to inherit all
---

<system prompt: the agent's role, method, and what it should return>
```

- **Project scope:** `agents/<name>.md` in the repo (auto-discovered when it's a
  plugin, like this repo's `agents/`).
- **User scope:** `~/.claude/agents/<name>.md`.

## slash command

**When:** the user keeps asking for the same workflow by name and it's lighter than
a full skill — a parameterized prompt more than a procedure with branching.

**How:** write `commands/<name>.md` (project) or `~/.claude/commands/<name>.md`
(user). The body is the prompt; `$ARGUMENTS` interpolates what the user typed. Add
`description:` frontmatter so it shows in the menu.

## MCP server

**When:** you reached for the same external service or data source repeatedly
(a database, an API, a SaaS tool) and there's an MCP server for it.

**How:** do **not** register it yourself with secrets inline. Print the command for
the user to run, with placeholders:

```bash
claude mcp add-json <name> '{"command":"npx","args":["-y","<package>"],"env":{"API_KEY":"${API_KEY}"}}'
```

Explain which env vars they'll need. Registration at user scope persists across
projects.

## memory entry

**When:** a durable fact surfaced about the user, the project, or their preferences
that you'd want known in *future* sessions — not just this one.

**How:** write a single-fact markdown file into the project memory directory
(referenced in your session, typically `~/.claude/projects/<slug>/memory/`):

```markdown
---
name: <short-kebab-slug>
description: <one-line summary — used to decide relevance during recall>
metadata:
  type: user | feedback | project | reference
---

<the fact. For feedback/project, follow with **Why:** and **How to apply:** lines.
Link related memories with [[their-name]].>
```

Then add a one-line pointer to `MEMORY.md` in the same directory:
`- [Title](slug.md) — hook`.

**Type guide:** `user` = who they are/preferences; `feedback` = how you should work
(corrections, confirmed approaches — include the why); `project` = ongoing
work/goals/constraints (convert relative dates to absolute); `reference` = pointers
to external resources.

**Curate:** if a file already covers this fact, update it instead of creating a
duplicate. Don't store what the repo already records (code structure, git history,
CLAUDE.md) — if asked to, capture what was *non-obvious* about it instead.

## CLAUDE.md addition

**When:** you got a project convention wrong and were corrected, and the rule belongs
in version-controlled project guidance (vs. user-specific memory).

**How:** propose a focused `Edit` to the project's `CLAUDE.md` adding the rule under
the most relevant existing heading. Keep it short and imperative; CLAUDE.md that
drifts long stops being read.
