---
name: evaluator
description: Run the mandatory independent Goal Review against integrated main without implementing product code; generator runs Goal Review automatically, so run /evaluator only to re-audit an already-integrated main or after manual edits.
allowed-tools: Bash, AskUserQuestion, Read
---

# Evaluator

Run the same host-neutral orchestrator as `/generator` in `goal-review` mode. This
is not a sweep of unchecked queue flags: it independently evaluates the Project
Goal, every stable Acceptance Check, and cross-feature journeys on integrated
`main`.

Let `GEN` be the generator skill directory and `HOST` the current host. Resolve
`PROJECT` the same way generator does:

```bash
PROJECT=$(node "$GEN/reconcile.mjs" --print-root)
```

This walks up from the working directory for the nearest `project_specs.xml`, then
falls back to `.harness/projects.json` at a monorepo root when more than one
project is registered. Goal Review never combines independent project queues; if
the goal names a different project than what resolved, pass its directory
explicitly.

1. Require the plan integration branch's `feature_list.json` and run
   `node "$GEN/reconcile.mjs" "$PROJECT" --check`. Refuse Goal Review while the
   Execution Ledger shows any Work Item not yet integrated.
   The Execution Ledger is authoritative for jobs-done detection; do not fail or
   reopen integrated Work Items solely because `feature_list.json` flags lag.
2. If this project's Goal Review Run State under `.git/harness-runs/` is already
   `blocked` (nested projects use a path-prefixed filename), show it and require
   user guidance before replacing its verdict.
3. Run:
   ```bash
   node "$GEN/orchestrator.mjs" --host "$HOST" --repo "$PROJECT" \
     --workdir "$MAIN_CHECKOUT" --mode goal-review --context goal-review \
     --port 5170 --claim-script "$GEN/claim.sh"
   ```
4. The state machine holds and releases the merge lock for the full review. Report
   the verdict and link `harness-progress/goal-review.md` plus
   its Evidence Artifacts. Concrete in-scope defects reopen linked Work Items for
   `/generator`; ambiguity or exhausted Attempts blocks for user guidance.

Never modify product code in evaluator mode. Only `goal:true` satisfies the
Completion Contract.

Before the Goal Review verdict (pass or fail), tear down every resource this
review session started (compose stacks, named containers, worktree servers,
PORT-scoped browsers) — same `RESOURCE_CLEANUP_RULE` as coding/QA.
Do not leave Docker leftovers for the next run.
