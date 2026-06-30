---
name: generator
description: Build, resume, independently QA, integrate, and Goal Review a project from stable Acceptance Checks.
allowed-tools: Bash, Agent, AskUserQuestion, Read
---

# Generator

You orchestrate the Project Goal through one host-neutral state machine. Parallel
sessions claim different contexts; each Work Item follows:

`coding → isolated QA → Checkpoint → merge latest main → Integrated Verification`

A QA defect follows:

`Defect Report → orchestrator Repair Plan → next coding Attempt`

Three failed Attempts block with user-visible evidence. Never delete a blocked
branch or worktree. The host's configured model is always used; do not select or
escalate vendor model IDs.

Let `REPO` be the project root, `GEN` this skill directory, and `HOST` the current
host (`claude`, `codex`, or `opencode`).

## 1. Scaffold and reconcile the completion contract

If `main:feature_list.json` is absent, first acquire
`mkdir "${REPO%/}.harness-init.lock"` and run the initializer exactly once in the
`main` checkout. Reference `project_specs.xml` explicitly in the initializer task
so it can create and verify every spec-required file and directory without relying
on inherited chat context. Another session that cannot acquire it waits and rechecks instead
of starting a second initializer. Remove the directory only after initialization
completes; a lock left by a crashed initializer requires explicit user-confirmed
takeover. Then, in the checkout of `main`:

```bash
node "$GEN/reconcile.mjs" "$REPO"
```

Run reconciliation and its commit while holding the merge lock. The reconciler validates stable Acceptance Check IDs and their acyclic dependency
graph, then appends a deterministic Work Item for every unmapped check. Commit
`project_specs.xml` and `feature_list.json` if reconciliation changed them. Never
start work when validation fails.

## 2. Resume before claiming new work

Always inspect durable state first:

```bash
bash "$GEN/claim.sh" list "$REPO"
bash "$GEN/claim.sh" resume "$REPO" "$CONTEXT" $$ auto
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
bash "$GEN/claim.sh" select-claim "$REPO" "$MODE" "$SELECTOR" $$
```

The scheduler returns only Ready Work Items: every ID in `depends_on` has passed
Integrated Verification. Context Claim Leases prevent two sessions from working
the same collision domain.

## 4. Run the single state machine

For every new or resumed claim, run the same engine on every host:

```bash
node "$GEN/orchestrator.mjs" --host "$HOST" --repo "$REPO" \
  --workdir "$WORKTREE" --context "$CONTEXT" --port "$PORT" \
  --features "$COMMA_SEPARATED_IDS" --claim-script "$GEN/claim.sh"
```

The engine references `project_specs.xml` in every coding, QA, repair, merge,
integration, and Goal Review agent prompt. Each agent reads it and verifies the
spec-required project structure before acting. The engine also owns agent communication, heartbeats, Defect Reports, Repair Plans,
Attempts, concise Journal entries, per-Work-Item merge checkpoints, and Integrated
Verification. It verifies queue state rather than trusting prose. Diagnostic output
is stored as separate Evidence Artifacts under the shared Git directory.

- `stuck`/`blocked` result: show the user the Run State, three Attempt summaries,
  defects, plans, evidence paths, and next action. Do not merge, release, or clean.
- All selected Work Items passed: release the completed context:
  `bash "$GEN/claim.sh" release "$REPO" "$CONTEXT"`.
- In `all` mode, claim again until no Ready Work Item remains.

## 5. Mandatory Goal Review

When no Work Items remain and every queue entry has `integration:true`, run Goal
Review on integrated `main`; the state machine holds the merge lock throughout:

```bash
node "$GEN/orchestrator.mjs" --host "$HOST" --repo "$REPO" \
  --workdir "$MAIN_CHECKOUT" --mode goal-review --context goal-review \
  --port 5170 --claim-script "$GEN/claim.sh"
```

First inspect `.git/harness-runs/goal-review.json`. If it is `blocked`, show its
result and require user guidance before running Goal Review again.

Goal Review reads the Project Goal and every Acceptance Check, reruns them at real
external boundaries, and tests cross-feature journeys without trusting flags. An
in-scope defect reopens linked Work Items; ambiguity or exhausted Attempts blocks
for the user. Only `goal:true` means the Project Goal is complete.

## 6. Report

Report integrated Acceptance Checks, blocked Work Items, Goal Review verdict, and
paths to Run State and Workflow Journals. `claim.sh list` is the live status view.
