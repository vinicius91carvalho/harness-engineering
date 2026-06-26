---
name: generator
description: Autonomously build a spec'd project from feature_list.json — claim a feature context, build it in an isolated git worktree (coding→QA loop with retries and model escalation), then merge back to main. Safe to run in several sessions at once; each claims a different context. Use when the user wants to implement/build features for a project that has a project_specs.xml (or already a feature_list.json).
allowed-tools: Bash, Workflow, Agent, AskUserQuestion, Read
---

# Generator

You orchestrate the build. Many `/generator` sessions can run **in parallel**; you
keep collisions impossible by claiming a `context` and working in its own git
**worktree** on its own **port**, then merging back to `main`. You only ever change
`feature_list.json` flags *through* the agents you spawn.

Let `REPO` = the project root (the dir containing `project_specs.xml` /
`feature_list.json`). Let `GEN=${CLAUDE_PLUGIN_ROOT}/skills/generator`.

## Step 1 — Ensure the project is scaffolded (once)

```bash
git -C "$REPO" show main:feature_list.json >/dev/null 2>&1 && echo SCAFFOLDED || echo NEEDS_INIT
```

If `NEEDS_INIT`, scaffold before building:
- If `$REPO/.git` does **not** exist (brand-new project): spawn the **`initializer`**
  agent (Agent tool, `subagent_type: "initializer"`) with the prompt to scaffold in
  `$REPO`. It reads `project_specs.xml`, writes `feature_list.json` + `init.sh` +
  structure and makes the first commit on `main`.
  <!-- ponytail: first-ever init is unguarded; the realistic flow is one generator
       starting first. If you must, `mkdir "$REPO/.gen-init.lock"` before and
       `rmdir` after to block a concurrent first-init. -->
- If `.git` exists but `main:feature_list.json` is missing, acquire the merge-lock,
  run the initializer on the `main` checkout it returns, then release:
  ```bash
  INTEG=$(bash "$GEN/claim.sh" merge-acquire "$REPO" $$)   # prints main checkout dir (or BUSY)
  ```
  Spawn `initializer` to scaffold in `$INTEG`, then `bash "$GEN/claim.sh" merge-release "$REPO"`.

## Step 2 — Choose the mode

Ask the user with `AskUserQuestion`:
- **1 task** — one feature `id` → `mode=task selector=<id>`.
- **A set** — one `context` group → `mode=feature selector=<context>`.
- **All** — every remaining context → `mode=all`. This session keeps claiming
  contexts until none are left.

## Step 3 — Claim → build → merge → release (loop)

```bash
bash "$GEN/claim.sh" select-claim "$REPO" "$MODE" "$SELECTOR" $$
```
- **Empty output** → nothing left to claim. Report done and stop.
- Otherwise it prints `{context, worktree, port, featureIds}` and has already
  created the worktree + `gen/<context>` branch. Read the `description` for each id
  from `feature_list.json` to build the `features` array.

**a. Build (Workflow).** Launch the inner loop:
```
Workflow({
  scriptPath: "$GEN/orchestrator.workflow.js",
  args: { workdir: <worktree>, port: <port>, mode: <MODE>,
          features: [ {id, context, description}, ... ] }
})
```
Watch it in `/workflows`. It implements each feature with `coding-agent`, QA's with
`qa-agent`, retries on failure, escalates sonnet→opus at retry 2, and reports any
`stuck` features (hit retry 3). If it returns `stuck` features, **stop and ask the
user** how to proceed for those before merging.

**b. Merge (serialized).** Once the context's features pass:
```bash
INTEG=$(bash "$GEN/claim.sh" merge-acquire "$REPO" $$)        # waits its turn; BUSY -> retry shortly
bash "$GEN/claim.sh" merge-do "$REPO" "<context>" "$INTEG"    # exit 0 clean, exit 2 conflict
```
On **conflict** (exit 2): spawn a `coding-agent` in merge-conflict mode pointed at
`$INTEG` to resolve the listed files (honoring the append-only rule: a flag `true`
on either side stays `true`) and re-verify the affected features, then commit. If it
cannot resolve, **stop and ask the user**. Always release the lock when done:
```bash
bash "$GEN/claim.sh" merge-release "$REPO"
```

**c. Release the claim** (removes the worktree + merged branch):
```bash
bash "$GEN/claim.sh" release "$REPO" "<context>"
```

**d.** If `mode=all`, go back to Step 3 for the next context. Otherwise finish.

## Step 4 — Report

Summarize: contexts built, features implemented/QA'd, anything stuck. Show live
state any time with `bash "$GEN/claim.sh" list "$REPO"`. Suggest `/evaluator` for an
independent QA sweep across everything.
