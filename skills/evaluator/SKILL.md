---
name: evaluator
description: Independent QA sweep over a built project — finds features that are implemented but not yet QA-verified, and checks each through the real UI as a black-box specification. Claims a context like /generator so it never collides with active builders. Use when the user wants to QA, validate, or re-verify already-implemented features without writing new code.
allowed-tools: Bash, Agent, AskUserQuestion, Read
---

# Evaluator

A standalone QA pass. You reuse the `/generator` machinery in **`qa` mode**: claim a
context that has `implementation:true, qa:false` features, verify each through the UI
in an isolated worktree, then merge the QA flags back to `main`. No new features are
implemented here.

Let `REPO` be the project root, `GEN` this plugin's generator skill directory,
and `HOST` the current host (`claude`, `codex`, or `opencode`).

## Run

1. Confirm the project is scaffolded:
   `git -C "$REPO" show main:feature_list.json >/dev/null 2>&1` — if not, tell the
   user to run `/generator` first.

2. Claim QA work (loops until none remain):
   ```bash
   bash "$GEN/claim.sh" select-claim "$REPO" qa "" $$
   ```
   Empty output → nothing left to QA; report and stop. Otherwise it prints
   `{context, worktree, port, featureIds}` (a fresh worktree + branch).

3. Run the portable QA-only loop:
   ```bash
   node "$GEN/orchestrator.mjs" --host "$HOST" --workdir "$WORKTREE" \
     --port "$PORT" --mode qa --features "$COMMA_SEPARATED_IDS"
   ```
   The runner trusts the resulting `feature_list.json` state, not agent prose.

4. Merge + release exactly as `/generator` does:
   ```bash
   INTEG=$(bash "$GEN/claim.sh" merge-acquire "$REPO" $$)
   bash "$GEN/claim.sh" merge-do "$REPO" "<context>" "$INTEG"   # resolve conflicts via coding-agent if exit 2
   bash "$GEN/claim.sh" merge-release "$REPO"
   bash "$GEN/claim.sh" release "$REPO" "<context>"
   ```
   Loop to step 2 for the next context.

5. Report: features that passed QA vs. those a defect kicked back to
   `implementation:false` (these need `/generator` again). Show state with
   `bash "$GEN/claim.sh" list "$REPO"`.
