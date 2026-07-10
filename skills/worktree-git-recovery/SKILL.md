---
name: worktree-git-recovery
description: Dispatch a narrow, git-only recovery command (merge --abort, catch-up merge with main) into one generator/orchestrator worktree via a sandboxed host CLI, without editing the target repo directly.
allowed-tools: Bash, AskUserQuestion
---

# Worktree git recovery

Use this when a generator context's own worktree is stuck on a git-level
problem — an uncommitted conflict left over from a crashed process, or a
worktree branched before a `main`-branch recovery that's now missing files
`main` has — and the fix is a small, deterministic sequence of git commands
(`git merge --abort`, `git merge --no-edit main`), not a product decision.

You may never run these commands directly against a target repo you don't
own (see the operator brief's hard boundary). Dispatch them through a host
CLI instead, exactly as if a human asked that CLI to run one bounded task.

## The gotcha this skill exists for

A worktree's own git metadata (`index.lock`, `MERGE_HEAD`, `ORIG_HEAD`)
physically lives under the **main repo's** `.git/worktrees/<id>/`, not
inside the worktree's own directory. A sandboxed host CLI whose write
access is scoped to the worktree path alone can run `git status` there
fine, but `git merge --abort`/`git commit` will fail trying to write that
metadata file — even though you `cd`ed into the correct worktree first.

## Two distinct root causes produce the same crash signature

A worker crash-looping on a reconcile failure (ENOENT on `project_specs.xml`,
a JSON parse error, or a stuck `MERGE_HEAD`) can come from two different
places, and they need different fixes:

- **Behind a pre-recovery base**: the branch is a normal ancestor of an
  earlier `main`, just not yet caught up. A plain `git merge --no-edit main`
  is the right fix.
- **Orphaned by a rewritten main**: `main`'s history was reset/rewritten
  (not fast-forwarded) while this context was mid-flight, so its branch now
  descends from a commit that is not an ancestor of current main at all.
  Confirm with `git merge-base --is-ancestor <branch-commit> main` (exits
  non-zero when truly orphaned, not just behind). A plain merge attempt
  here produces real add/add conflicts on files main re-created
  independently — that's the signal you're in this case, not the first one.

## Deciding reset vs. abort-only for an orphaned branch

Once a branch is confirmed orphaned, check whether it's actually safe to discard:

1. Diff the branch's own commits against main: `git log --oneline
   main..<branch>`. If they're few and clearly superseded (e.g. an
   `integrate <Work Item>` commit whose target Work Item already shows
   `integration: true` in the Execution Ledger for that Work Item), the branch has
   no unique value.
2. Cross-check every Work Item ID the claim was assigned
   (`generator-claims.json`'s `featureIds`) against the catalog on the integration
   branch and its Execution Ledger under `.git/harness-ledger/`. If every one of them is missing entirely, already
   integrated per the ledger, or the branch never wrote a single commit
   toward them, it's safe to reset (`git merge --abort` first if a merge is
   stuck, then `git reset --hard main`) — the orchestrator will redo the
   Work Item cleanly from current main.
3. If even one assigned Work Item shows real progress in the ledger
   (`implementation`/`qa` true but `integration` still false) or isn't integrated at all, do not reset — abort the stuck merge only (`git merge
   --abort`) and leave the branch's own commits intact so the orchestrator's
   normal integration flow can pick them up later. A reset here would
   silently discard real, unintegrated work.
4. `git reset --hard` is a materially more destructive action than a merge
   or an abort in the eyes of an auto-mode classifier (or equivalent
   guard) — it needs its own fresh authorization even when a merge/abort
   was already approved for the same worktree.

## What does and doesn't work (learned the hard way)

1. **Bare `codex exec -C <worktree> "<prompt>"`** — fails. The sandbox's
   writable root is the worktree only; it can't create `index.lock` in the
   main repo's `.git/worktrees/<id>/`.
2. **`codex exec -C <worktree> --add-dir <main-repo-root>`** — often still
   fails. Some sandbox configurations hard-deny writes to any path matching
   `.git/`, regardless of `--add-dir` scope. Try this first anyway — it's
   the most surgical option and sometimes succeeds.
3. **`codex exec -s danger-full-access`** — a full sandbox bypass. Works,
   but is a materially bigger ask than option 2 — get explicit sign-off for
   this specific flag, not just for "fixing the worktree" in the abstract.
4. **A different host CLI** (`claude -p --permission-mode acceptEdits`,
   `opencode run`) — may have a different sandbox model entirely. Worth
   trying if 1–2 fail, but treat it as its own distinct action needing its
   own authorization (see below).

**Important:** an auto-mode classifier (or equivalent guard) treats each of
these as a *different* action, even when they're aimed at the identical
git-level goal. Approval for "try `codex exec` on this worktree" does not
carry over to "now try it with `--add-dir`" or "now try `claude -p`
instead" — expect to ask again for each new mechanism, not just once for
the goal.

## Procedure

1. Confirm no active orchestrator worker currently owns this exact context
   (check its claim's `session`/owner PID) — you don't want to race a live
   worker in the same worktree.
2. If the target repo is a monorepo shared by other subprojects' live
   orchestrators, `$HC pause` all of them first per the standing shared-root
   rule, even though you're touching an isolated worktree, not the shared
   root itself — a sandboxed CLI attempt against monorepo state is still a
   shared-resource action and will very likely need the same authorization
   gate.
3. Write a narrow, deterministic prompt: name the exact git commands to run
   in order, say explicitly "run only these, do not modify any file
   yourself, do not attempt to resolve a conflict if one appears — abort and
   report the conflicting files instead." Never give the dispatched agent
   open-ended discretion for this kind of fix.
4. Try mechanism 1 above. If it fails on a sandbox/permission error (not a
   real git conflict), present the user the exact failure and the next
   mechanism to try, and ask before proceeding — do not silently escalate
   scope yourself.
5. Verify afterward by reading the worktree's own state directly (`git
   status --short`, `git log --oneline -3`, grep for literal `<<<<<<<`
   markers) — do not just trust the dispatched job's own summary.
6. Resume any subprojects you paused in step 2.
