---
name: evaluator
description: Run the mandatory independent Goal Review against the plan integration branch without implementing product code; generator runs Goal Review automatically, so run /evaluator only to re-audit an already-integrated plan or after manual edits.
allowed-tools: Bash, AskUserQuestion, Read
---

# Evaluator

Thin pointer to the same host-neutral Goal Review command `/generator` uses.
This is not a sweep of unchecked queue flags: it independently evaluates the
Project Goal, every stable Acceptance Check, and cross-feature journeys on the
plan integration checkout (`.harness/integration-branch`), never on `main`/`master`
while a plan pin is in flight.

Let `EVAL` be this skill directory, `GEN` the sibling generator skill directory,
and `HOST` the current host.

```bash
node "$EVAL/goal-review.mjs" --host "$HOST"
```

That CLI resolves `PROJECT` the same way generator does (nearest
`project_specs.xml`, then `.harness/projects.json`), resolves the integration
checkout (`resolveIntegrationCheckout`), and runs:

```bash
node "$GEN/orchestrator.mjs" --host "$HOST" --repo "$PROJECT" \
  --workdir "$INTEGRATION_CHECKOUT" --mode goal-review --context goal-review \
  --port 5170 --claim-script "$GEN/claim.sh"
```

Pass an explicit project directory or `--workdir` only when resolution is ambiguous.
Goal Review never combines independent project queues.

Before running, require the plan integration branch's `feature_list.json` and
`node "$GEN/reconcile.mjs" "$PROJECT" --check`. Refuse Goal Review while the
Execution Ledger shows any Work Item not yet integrated.
The Execution Ledger is authoritative for jobs-done detection; do not fail or
reopen integrated Work Items solely because `feature_list.json` flags lag.

If this project's Goal Review Run State under `.git/harness-runs/` is already
`blocked` (nested projects use a path-prefixed filename), show it and require
user guidance before replacing its verdict.

The state machine holds and releases the merge lock for the full review. Report
the verdict and link `harness-progress/goal-review.md` plus its Evidence Artifacts.
Concrete in-scope defects reopen linked Work Items for `/generator`; ambiguity or
exhausted Attempts blocks for user guidance.

Never modify product code in evaluator mode. Only `goal:true` satisfies the
Completion Contract.

Before the Goal Review verdict (pass or fail), tear down every resource this
review session started (compose stacks, named containers, worktree servers,
PORT-scoped browsers) - same `RESOURCE_CLEANUP_RULE` as coding/QA.
Do not leave Docker leftovers for the next run.
