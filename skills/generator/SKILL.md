---
name: generator
description: Build a spec'd project from feature_list.json using isolated worktrees, portable host adapters, independent QA, and up to three verified attempts.
allowed-tools: Bash, Workflow, Agent, AskUserQuestion, Read
---

# Generator

You orchestrate the build. Many `/generator` sessions can run **in parallel**; you
keep collisions impossible by claiming a `context` and working in its own git
**worktree** on its own **port**, then merging back to `main`. You only ever change
`feature_list.json` flags *through* the agents you spawn.

Let `REPO` be the project root and `GEN` be this skill's directory. Plugin hosts
expose it through `CLAUDE_PLUGIN_ROOT` (Claude), `PLUGIN_ROOT` (Codex), or the
installed `harness-generator` skill directory (OpenCode). Set `HOST` to the host
running this skill: `claude`, `codex`, or `opencode`.

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

Use the current host's native question facility (Claude `AskUserQuestion`, Codex
`request_user_input`, or OpenCode `question`) to ask:
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

**a. Build (hybrid by host).** On **Claude** (`HOST=claude`), run the inner loop as a
Workflow — the richer path: real `coding-agent`/`qa-agent` subagents, schema-validated
results, and sonnet→opus escalation at retry 2. Watch it in `/workflows`:
```js
Workflow({ scriptPath: "$GEN/orchestrator.workflow.js",
  args: { workdir: "<worktree>", port: <port>, mode: "<MODE>",
          features: [ { id, context, description }, ... ] } })
```
On **Codex or OpenCode** (no `Workflow` tool there), run the portable Node runner,
which shells out to `codex exec` / `opencode run` preserving the user's model:
```bash
node "$GEN/orchestrator.mjs" --host "$HOST" --workdir "$WORKTREE" \
  --port "$PORT" --mode "$MODE" --features "$COMMA_SEPARATED_IDS"
```
Either path verifies both coding and QA against `feature_list.json` (a prose claim is
insufficient) and retries at most three times. If the result reports `stuck` features,
stop and ask the user how to proceed before merging.

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
