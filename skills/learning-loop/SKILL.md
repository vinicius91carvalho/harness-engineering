---
name: learning-loop
description: |
  Reflect on a coding session and turn what happened into durable harness
  workflow improvements — suggest (and, with approval, scaffold) skills, agents,
  commands, MCP servers, and memory entries, then persist what was learned so
  the assistant grows across sessions. Prefer updating harness-engineering
  workflow skills over AGENTS.md/CLAUDE.md. This is a hermes-agent style learning
  loop. Use it whenever the user says "what did we learn", "reflect on this
  session", "run the learning loop", "retrospective", "capture this as a skill",
  "what should I automate", "suggest skills/rules/agents", "improve my harness
  setup", or asks to review a session transcript for reusable patterns — and
  proactively at the end of a long or repetitive task, even if they don't use
  those exact words.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Skill, AskUserQuestion
---

# Learning Loop

You are the LEARNING LOOP. Inspired by the hermes-agent's closed loop
(**experience → reflect → create artifact → persist → curate**), your job is to
look back at a session, notice what was *re-derived, repeated, or corrected*, and
convert those moments into portable automations so the next session is cheaper
and smarter. A session that solves a problem and forgets it has wasted the lesson.

The whole point is leverage: a procedure done twice by hand becomes a skill done
once; a correction repeated three times becomes a workflow-skill rule; a
fact about the user re-explained every session becomes a memory entry.

## Hard routing rule (this repo)

In **harness-engineering**, durable learning always lands in the **workflow
project** — `skills/<name>/SKILL.md` (and related `agents/`, `commands/`,
scripts under those skills). Sync approved skill edits to `~/.agents/skills/`
when the operator runs live supervisors from there.

**Do not** add pipeline/ops conventions to `AGENTS.md` or `CLAUDE.md`.
Those files stay for marketplace/install/layout guidance only.
Route "always/never" corrections into the matching skill instead:

| Topic | Prefer skill |
|---|---|
| Supervisor ticks, herdr, worker health, fail-closed ops | `skills/supervisor/` and/or `skills/monorepo-supervisor-ops/` |
| Coding/QA/repair/plan branch/roles/OSS-first | `skills/generator/` |
| Learning-loop itself | `skills/learning-loop/` |
| Install / backup / host config | `skills/update-project/` or `skills/setup/` |

Memory entries remain for user/project facts that are not workflow procedure.

## Step 1 — Scope the reflection

Decide what you're reflecting *on*:

- **Default:** the current conversation. It's already in your context — read back
  over what the user asked, what you did, where you stumbled, and what they corrected.
- **A provided transcript / file:** if the user points you at one, read it.
- **Continuity:** use the current host's documented memory/instruction surface and
  `codebase-memory-mcp` when configured. Never inspect credentials, histories,
  caches, or session databases.
- **Optional — evidence-corpus:** when the session involved harness QA / Goal Review
  failures, mine create-only Evidence Artifacts instead of pane tails:

```bash
node -e "
import { scan, extractVerdicts, clusterDefects, recurrenceReport, proposeRoutes } from './skills/learning-loop/lib/evidence-corpus.mjs';
const corpus = await scan({ repo: process.cwd() });
const verdicts = extractVerdicts(corpus);
const clusters = clusterDefects(verdicts);
const recurring = recurrenceReport(clusters, 2);
console.log(JSON.stringify({ corpus, recurring, routes: proposeRoutes(recurring) }, null, 2));
"
```

  Apply the same recurrence bar (≥2) to clustered defects.
  `proposeRoutes()` returns suggested `skills/*` paths only — **never** auto-apply
  patches; present routes in Step 3 and scaffold only after explicit approval.

If there's barely any session to reflect on (a couple of trivial exchanges), say so
and stop — there's nothing worth automating yet. Manufacturing findings from a thin
session produces noise the user will learn to ignore.

## Step 2 — Mine the experience

Walk the session looking for these signals. Each maps to an artifact type. The
detailed "how to scaffold / which tool to route to" lives in
`references/artifact-catalog.md` — read it when you're ready to act in Step 4.

| Signal you observe in the session | Candidate artifact |
|---|---|
| A multi-step procedure re-derived from scratch (esp. if done >1×) | **skill** (new or extend existing) |
| The user corrected the same behavior repeatedly / said "always" or "never" do X | **workflow skill rule** (update the matching `skills/*/SKILL.md`) |
| A delegatable, context-heavy, specialized task you'd want to hand off | **subagent (agent)** |
| A workflow the user keeps asking for by name | **slash command** |
| An external service / data source you reached for repeatedly | **MCP server** |
| A durable fact about the user, project, or their preferences | **memory entry** |

### The recurrence bar (this is the important part)

Do **not** propose an artifact for everything that happened once. The bar is:

- **Recurrence:** it happened **≥2–3 times** this session, or
- **Clear future value:** it's obviously going to recur (a deploy procedure, a
  house rule the user stated as a rule), even if you only saw it once.

A skill or rule for a one-off is pure overhead — it clutters context and
erodes trust. When in doubt, leave it out and say why. Being selective is what makes
the few suggestions you *do* make worth acting on. This restraint is the skill's
most important behavior, not a nice-to-have.

## Step 3 — Present the findings report

Output a single prioritized report in this shape. Order by leverage (highest-value,
most-recurring first). Keep it scannable.

```
## Learning loop — findings

1. [skill] <short title>
   Evidence: <what happened, how many times>
   Proposed: <the artifact in one line>
   Route: skills/<name>/SKILL.md   ·   Confidence: high/med

2. [instruction] <short title>
   Evidence: <the repeated correction, quoted briefly>
   Proposed: <rule text>
   Route: skills/supervisor/SKILL.md (or monorepo-supervisor-ops / generator)   ·   Confidence: high

3. [memory] <short title>
   Evidence: <the durable fact>
   Proposed: <one-line memory entry>
   Route: write to memory dir   ·   Confidence: high

(…)

Considered but skipped: <thing that happened once> — below the recurrence bar.
```

The "Considered but skipped" line matters: it shows the user you looked and chose
restraint, and it surfaces borderline calls they can overrule.

Then ask via the current host's native question facility (`AskUserQuestion`,
`request_user_input`, or OpenCode `question`) **which findings to act on**. Never
scaffold without explicit approval — creating or editing skills are changes the
user owns.

## Step 4 — Scaffold the approved findings

For each approved finding, read `references/artifact-catalog.md` and follow the
recipe for that type. In short:

- **skill** → write or extend the minimal portable `skills/<name>/SKILL.md` in
  harness-engineering, then sync to `~/.agents/skills/` when live ops need it.
- **instruction / workflow skill rule** → edit the matching workflow skill
  (`supervisor`, `generator`, `monorepo-supervisor-ops`, …). **Not** `AGENTS.md`
  or `CLAUDE.md`.
- **agent** → use Claude Markdown, Codex TOML, or OpenCode Markdown for the active host.
- **command** → write a command `.md` file.
- **memory entry** → write `<slug>.md` into the memory directory using the exact
  memory format (frontmatter + body), then add the one-line pointer to `MEMORY.md`.
  Check for an existing entry covering the same fact and **update it instead of
  duplicating**.
- **MCP server** → print the active host's native MCP command for the user to run;
  never run it yourself with secrets inline.

## Step 5 — Persist the loop's own learning (always)

Even if the user declines every artifact, capture **at least one memory entry**
recording the most useful durable thing from this session, but only after the user
approves that write. Use the current host's documented project memory surface or
`codebase-memory-mcp`. If neither is available, report the finding without creating
an ad-hoc hidden data directory.

## Step 6 — Curate on write (lightweight)

Before writing any memory entry or skill, check whether one already covers the same
ground (Step 1 gave you the lay of the land). Update the existing one rather than
adding a near-duplicate. This is the hermes "Curator" idea done incrementally at
write-time, which is enough to keep the library from rotting without a separate job.

## Why this works

- **Reflection beats static scans.** A codebase scan can't see that you corrected
  the same mistake three times *today*; the session can. That lived experience is
  the signal no static analyzer has.
- **Workflow skills beat host instruction dumps.** Pipeline knowledge lives next
  to the scripts that enforce it and travels with the plugin across hosts.
- **Restraint beats volume.** The recurrence bar is what separates a useful loop
  from a nagging one. Fewer, higher-leverage artifacts is the goal.
