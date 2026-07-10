---
name: generator
description: Build, resume, independently QA, integrate, and Goal Review a project from stable Acceptance Checks.
allowed-tools: Bash, Agent, AskUserQuestion, Read
---

# Generator

You orchestrate the Project Goal through one host-neutral state machine. Parallel
sessions claim different contexts; each Work Item follows:

`coding → isolated QA → Checkpoint → merge latest integration branch → Integrated Verification`

Each Project Goal uses one **plan integration branch** (for example `plan/my-feature`).
Isolated Work Items use `gen/<project>-<context>` branches that merge only into that
plan branch — never into `main`/`master` while the plan is in flight. Pin the branch
in `.harness/integration-branch` at the Git root (one line) or set
`HARNESS_INTEGRATION_BRANCH` for a single run.
Harness repo edits during an in-flight plan also land on that plan branch (side jobs
branch from it and merge back) — never directly onto `main`/`master`.

A QA defect follows:

`Defect Report → orchestrator Repair Plan → next coding Attempt`

Three failed Attempts block with user-visible evidence. Never delete a blocked
branch or worktree. Direct execution uses the host's configured model. Only an
optional project-local `.harness/roles.json` selects or orders model IDs.

**Coding route is open-source-first:** when using `config/roles.example.json` /
`.harness/roles.json`, keep coding candidates on free/OSS hosts first
(OpenCode Go / NIM / free tiers), then Composer, then Claude/Codex as rescue.
Do not reorder coding to put expensive models first. Ops monitoring hosts
(supervisor recycles) are separate — see `monorepo-supervisor-ops`.

**QA observation method:** exercise each Acceptance Check with the method it
specifies (grep/file audit, CLI exit code, real HTTP, or real browser).
Do not start a server or browser for a static audit.
Emit the harness verdict as soon as the check passes or fails.
Reconcile stores `observation_method` on Work Items; http/browser validation
prefers agent/Codex/Claude over pi as first pick.

**Defect class routing:** optional verdict `defectClass`
(`product` | `observation_mismatch` | `infra` | `quota` | `merge_conflict`)
drives repair (switch host / block / repair-plan). Infra and coding exhaustion
are not auto-retried.

**Lean Cursor agent MCP:** generator `agent` spawns without `--approve-mcps` so
disabled Playwright/Crawl4AI do not delay first tokens on herdr panes.

Let `PROJECT` be the directory containing `project_specs.xml`, `GIT_ROOT` be its
Git top-level, `GEN` this skill directory, and `HOST` the current host (`claude`,
`codex`, `opencode`, or `agent`). If invoked at a monorepo root, resolve a project through
`.harness/projects.json`; list the choices when more than one is registered. Never
combine project queues.

## 1. Scaffold and reconcile the completion contract

If the integration branch has no `feature_list.json` yet, first acquire
`mkdir "${PROJECT%/}.harness-init.lock"` and run the initializer exactly once in the
integration-branch checkout (see `.harness/integration-branch`, default `main`).
Reference `project_specs.xml` explicitly in the initializer task
so it can create and verify every spec-required file and directory without relying
on inherited chat context. In a non-empty codebase, it must derive harness setup
from existing files and preserve application code, configuration, documentation,
tests, and Git history. Another session that cannot acquire it waits and rechecks instead
of starting a second initializer. Remove the directory only after initialization
completes; a lock left by a crashed initializer requires explicit user-confirmed
takeover. Then, in the checkout of the integration branch:

```bash
node "$GEN/reconcile.mjs" "$PROJECT"
```

Run reconciliation and its commit while holding the merge lock. The reconciler validates stable Acceptance Check IDs and their acyclic dependency
graph, appends a deterministic Work Item for every unmapped check, and fills
omitted transitive `depends_on` entries on existing Work Items. Commit
`project_specs.xml` and `feature_list.json` if reconciliation changed them. Never
start work when validation fails.

## 2. Resume before claiming new work

Always inspect durable state first:

```bash
bash "$GEN/claim.sh" list "$PROJECT"
bash "$GEN/claim.sh" resume "$PROJECT" "$CONTEXT" $$ auto
```

Inspect every listed context's Run State and try each abandoned candidate; do not
stop scanning merely because another context is live.

- JSON output means local owner and child processes are dead: Resume that exact
  worktree, port, context, feature IDs, Run State, and next action.
- `LIVE` means report what is running and do not steal it.
- `STALE` from another host requires explicit user confirmation, then rerun with
  `force`.
- `BLOCKED` is never automatic. After user guidance, explicitly Resume that
  context with `force`, then pass a concise `--guidance "..."` summary to the
  orchestrator. This starts a new three-Attempt cycle and records the intervention
  in the Workflow Journal.

Run State lives under the shared Git directory in `harness-runs/<context>.json`.
The human-readable Workflow Journal is `harness-progress/<context>.md`. Read both;
never reconstruct state from chat history.

## 3. Choose and claim

If nothing resumes, ask for **1 task**, **A set**, or **All**, then claim:

```bash
bash "$GEN/claim.sh" select-claim "$PROJECT" "$MODE" "$SELECTOR" $$
```

The scheduler returns only Ready Work Items: every ID in `depends_on` has passed
Integrated Verification. Context Claim Leases prevent two sessions from working
the same collision domain.

## 4. Run the single state machine

For every new or resumed claim, run the same engine on every host:

```bash
node "$GEN/orchestrator.mjs" --host "$HOST" --repo "$PROJECT" \
  --workdir "$WORKTREE" --context "$CONTEXT" --port "$PORT" \
  --features "$COMMA_SEPARATED_IDS" --claim-script "$GEN/claim.sh"
```

The engine references `project_specs.xml` in every coding, QA, repair, merge,
integration, and Goal Review agent prompt. Each agent reads it and verifies the
spec-required project structure before acting. The engine also owns agent communication, heartbeats, Defect Reports, Repair Plans,
Attempts, concise Journal entries, per-Work-Item merge checkpoints, and Integrated
Verification. It verifies ledger-merged queue state rather than trusting prose. Diagnostic output
is stored as create-only Evidence Artifacts under `.git/harness-evidence/` in the shared Git directory.

### Optional role routing

When `.harness/roles.json` exists, the same engine runs each role through direct
host CLI adapters with ordered candidates. `coding`, `validation`, `repairPlanning`, and
`goalReview` are non-empty ordered candidate arrays; each entry is a harness name
or `{ "harness": "opencode", "model": "provider/model" }`. Harnesses are
`claude`, `codex`, `opencode`, `pi`, or `agent`; model is optional (Pi accepts
`provider/id:thinking`, Cursor Agent accepts its `--model` ids such as
`grok-4.5-xhigh`). Without this file, `--host` keeps the existing direct CLI
behavior. Copy [`config/roles.example.json`](../../config/roles.example.json) as a starting point.

Validation candidates using a harness different from the actual coding harness
run first. A 429, unavailable model, authentication error, or launch failure tries
the next candidate, and so does a coding candidate that returns
`implementation:false` without a defect cycle (for example, scope exceeds its
context budget) — neither consumes an Attempt. In direct `--host` mode a decline
blocks immediately with the agent's notes. A successful QA response describing a
product defect does not fall through: it enters the existing Defect Report and
Repair Plan loop. Run State and Evidence record the chosen harness/model,
fallbacks, and independence level.

### Verify-first mode

Verify-first is decided **per Work Item** by its `verify_first` flag. The
initializer sets `verify_first:true` on the baseline items it maps during Existing
Codebase setup (spec `<mode>existing-codebase</mode>`); `reconcile.mjs` sets
`verify_first:false` on items it appends afterward — the new features or refactor a
later `planner` run adds. Legacy queues that predate the field fall back to the
spec's `<mode>`, preserving the old whole-project behavior.

For a `verify_first` item the CODING prompt switches from "implement this Work
Item" to "first verify the mapped Acceptance Checks against the existing code at a
real external boundary; if all pass, set `implementation=true` with no code
changes; only if a check fails, fix the root cause with the smallest possible
diff." Items without the flag build normally. QA and Integrated Verification still
independently re-run the checks, so a false pass is caught downstream. This makes
`/generator` a safe audit/regression pass over the mapped baseline **while still
building new work in full** — a big refactor added after setup is implemented, not
just audited.

- `stuck`/`blocked` result: show the user the Run State, three Attempt summaries,
  defects, plans, evidence paths, and next action. Do not merge, release, or clean.
- All selected Work Items passed: release the completed context:
  `bash "$GEN/claim.sh" release "$PROJECT" "$CONTEXT"`.
- In `all` mode, claim again until no Ready Work Item remains.

## 5. Mandatory Goal Review

When no Work Items remain and the Execution Ledger shows every catalog entry
integrated, run Goal Review on the integrated plan branch (`.harness/integration-branch`);
the state machine holds the merge lock throughout:

```bash
node "$GEN/orchestrator.mjs" --host "$HOST" --repo "$PROJECT" \
  --workdir "$INTEGRATION_CHECKOUT" --mode goal-review --context goal-review \
  --port 5170 --claim-script "$GEN/claim.sh"
```

First inspect this project's Goal Review Run State under `.git/harness-runs/`
(nested projects use a path-prefixed filename). If it is `blocked`, show its result
and require user guidance before running Goal Review again.

Goal Review reads the Project Goal and every Acceptance Check, reruns them at real
external boundaries, and tests cross-feature journeys without trusting flags. An
in-scope defect reopens linked Work Items; ambiguity or exhausted Attempts blocks
for the user. Only `goal:true` means the Project Goal is complete.

## 6. Report

Report integrated Acceptance Checks, blocked Work Items, Goal Review verdict, and
paths to Run State and Workflow Journals. `claim.sh list` is the live status view.
