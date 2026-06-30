---
name: evaluator
description: Run the mandatory independent Goal Review against integrated main without implementing product code.
allowed-tools: Bash, AskUserQuestion, Read
---

# Evaluator

Run the same host-neutral orchestrator as `/generator` in `goal-review` mode. This
is not a sweep of unchecked queue flags: it independently evaluates the Project
Goal, every stable Acceptance Check, and cross-feature journeys on integrated
`main`.

Let `REPO` be the project root, `GEN` the generator skill directory, and `HOST` the
current host.

1. Require `main:feature_list.json` and run
   `node "$GEN/reconcile.mjs" "$REPO" --check`. Refuse Goal Review while any Work
   Item lacks `integration:true`.
2. If `.git/harness-runs/goal-review.json` is already `blocked`, show it and require
   user guidance before replacing its verdict.
3. Run:
   ```bash
   node "$GEN/orchestrator.mjs" --host "$HOST" --repo "$REPO" \
     --workdir "$MAIN_CHECKOUT" --mode goal-review --context goal-review \
     --port 5170 --claim-script "$GEN/claim.sh"
   ```
4. The state machine holds and releases the merge lock for the full review. Report
   the verdict and link `harness-progress/goal-review.md` plus
   its Evidence Artifacts. Concrete in-scope defects reopen linked Work Items for
   `/generator`; ambiguity or exhausted Attempts blocks for user guidance.

Never modify product code in evaluator mode. Only `goal:true` satisfies the
Completion Contract.
