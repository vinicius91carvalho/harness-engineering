---
name: monorepo-supervisor-ops
description: Operate multiple harness supervisors in one monorepo (herdr tabs, finished-tab cleanup, stream smoke checks, leases, merge lock, empty-fleet recovery, composer-2.5 ops). Use when restarting supervisors, diagnosing empty/zombie panes, clearing dead locks/quota pauses, or syncing harness skills to ~/.agents.
---

# Monorepo supervisor ops

Use this when several subprojects share one Git top-level (e.g. `core`, `web`,
`relay`, `public-docs`) and each runs its own `harness-control.mjs` supervisor.

## Hard rules

1. Edit harness code / installed skills only unless the operator says otherwise.
2. Do not commit unless asked. While a plan is in flight, land harness commits on
   the plan branch (side jobs branch from it) — never directly onto `main`/`master`.
3. Pane/tab cleanup is **per project** (`worker-<project>-*`). Never close sibling supervisors' workers.
4. Supervisor exit must **not** close live herdr tabs — orchestrators outlive the supervisor; `rehydrateHerdrWorkers` reattaches them.
5. Shared merge lock (`.git/harness-locks/generator-merge`) is normal — one integrator at a time.
6. **CauseFlow 10-min ops model:** always recycle/retry with `--host agent` and **composer-2.5** (never `composer-2.5-fast`, never `pi`/deepseek for this monitoring loop).
7. **Coding route ≠ ops host:** Work Item coding stays OSS-first via `.harness/roles.json`. Do not reorder coding to put Claude/Codex/Composer first. Ops recycles use composer-2.5; that is not the coding ladder.
8. **Fail-closed:** empty fleet, finished tabs still open, or `workerHealth=stuck` → fix now and update this skill / harness code in the same turn. Do not only report.
9. **Always check final verification logs** (supervisor Hard rules): evidence
   artifacts under `.git/harness-evidence/` are pass/fail truth. Do not rely only
   on `status` / progress counters / pane tails.
10. **Learning stays in workflow skills:** durable ops lessons update `skills/*` in
   harness-engineering (and sync to `~/.agents`), not `AGENTS.md` / `CLAUDE.md`.

## Sync harness changes to live skills

After editing in the harness-engineering repo:

```bash
cp skills/generator/lib/{agent-spawn,agent-stream,supervisor-auto-respond,worker-health,repair-router,observation-method,control-journal,resource-governor,worktree-teardown,worker-lifecycle,browser-cleanup,claim-lease}.mjs ~/.agents/skills/generator/lib/
cp skills/generator/prompts/feature.mjs ~/.agents/skills/generator/prompts/
cp skills/generator/orchestrator.mjs ~/.agents/skills/generator/
cp skills/supervisor/scripts/harness-control.mjs ~/.agents/skills/supervisor/scripts/
cp skills/supervisor/lib/herdr-spawn.mjs ~/.agents/skills/supervisor/lib/
cp skills/monorepo-supervisor-ops/SKILL.md ~/.agents/skills/monorepo-supervisor-ops/SKILL.md
```

Also document: Control Journal must keep monotonic ids (`journal-meta.json`); Resource Governor must prune dead-pid reservations and reuse same-context admissions so orchestrators do not double-book slots.

Recycle orchestrators (`SIGTERM`) so new spawn/stream/prompt code loads.
kill -9 on old supervisors so their `stop()` path does not close tabs.
Use guarded harness-control fleet commands instead of raw `kill`/`rm`:

```bash
node "$CONTROL" kill-supervisor --repo "$REPO" --force true
node "$CONTROL" release-supervisor-lock --repo "$REPO" --force true
node "$CONTROL" clear-dead-lock --repo "$REPO" --lock merge --force true
node "$CONTROL" kill-worker --repo "$REPO" --context <context> --force true
node "$CONTROL" release-lease --repo "$REPO" --context <context> --force true
```

`--force true` is required when a local supervisor PID is still recorded as live
(harness-control parses `--key value` pairs; bare `--force` is invalid).
Pass `HARNESS_SUPERVISOR_TOKEN` instead when you hold the active lease.

## Restart one subproject supervisor (keep workers)

```bash
CONTROL=~/.agents/skills/supervisor/scripts/harness-control.mjs
REPO=/path/to/monorepo/<subproject>
STATE=/path/to/monorepo/.git/harness-control/<subproject>/state.json
TOP=$(git -C "$REPO" rev-parse --show-toplevel)

# Optional: seed custom guidance before start (wins over auto-retry generics)
# Set retryQueue[context].guidance in state.json, clear workers={}, supervisorPid=null
# Neutralize pending inputs for that context so auto-respond cannot race.

node "$CONTROL" kill-supervisor --repo "$REPO" --force true
node "$CONTROL" release-supervisor-lock --repo "$REPO" --force true
# Prefer `run` + setsid/nohup for long-lived supervisors; `start` may exit after spawn.
# CauseFlow ops: --host agent (composer-2.5). Use pi only when the operator asks.
# harness-control parses argv as `--key value` pairs — use `--force true`, not bare `--force`.
setsid -f env HERDR_ENV=1 node "$CONTROL" run --repo "$REPO" --host agent --display herdr \
  --max-workers 3 --quota-workers 3 --cpu-per-worker 1 \
  --memory-per-worker-mb 640 --reserve-memory-mb 1024 --max-load-ratio 0.9 \
  --summary-minutes 20 \
  >>/tmp/<subproject>-supervisor.log 2>&1
```

## Empty fleet recovery (workers={}, no herdr panes)

Supervisor ticks now auto-clear dead same-host merge/state locks
(`stale_lock_cleared` events) and, when the fleet is empty after a clear, reset
crash-bound counts so auto-retry can resume. Ghost run-state PIDs outside
`workers` no longer count as a successful retry (that used to drop `retryQueue`
and leave capacity unused).

Manual recovery remains for remote locks, quota pauses, and RAM pressure:

When `status=running` but `workers={}`, herdr has only the default tab, or
`capacity.limit=0` with no spawns:

1. **Dead merge lock** — `mergeLock.holderAlive=false` or owner PID gone
   (usually auto-cleared; use CLI for remote/force):
   ```bash
   node "$CONTROL" clear-dead-lock --repo "$REPO" --lock merge --force true
```
2. **Dead state lock** — same for `generator-state` if owner PID is dead.
3. **Quota pause** — rate-limit sets `quota.pauseUntil` → slots 0:
   ```bash
   node "$CONTROL" quota --repo "$REPO" --pause-until 0 --workers 3
   node "$CONTROL" resume --repo "$REPO"
   ```
4. **Capacity 0 from load/RAM** — Docker `--no-cache` builds spike load above
   `maxLoadRatio`; wait for build to finish. Free RAM: kill orphan `tsx`/`node`
   APIs left in finished worktrees (not the active AC worktree). Prefer
   `kill-worker --force true` / operator `stop` — both now run programmatic
   worktree teardown (`.harness/app.pid`, worktree-scoped `next`/`tsx`,
   `docker compose down --remove-orphans`) via `worktree-teardown.mjs`, not
   browser cleanup alone.
5. **Sibling holds host-wide Resource Governor slots** — `capacity.available=0`
   while this project's `workers={}` but `capacity.state.reservations` shows other
   subprojects (or a zombie idle-shell worker still reserved). Check
   `.git/harness-governor/reservations.json`. Pause or `kill-worker --force true`
   lower-priority / crash-looping siblings, then hard-restart or wait for this
   supervisor to admit. Do not declare "nothing left to claim" until reservations
   and `feature_list` remaining WIs are checked.
6. **RAM below reserve (`memory.slots=0`, `MemAvailable` < `reserveMb`)** — even
   with free governor reservation count, admission stays at 0. Treat as empty
   fleet for the blocked root project: pause sibling supervisors, `kill-worker
   --force true` on lower-priority contexts, free orphan docker/node leftovers,
   then re-check `capacity` until `available>=1` and admit the blocker. Do not
   leave the blocked project idle while siblings keep burning RAM.
7. **"Preparing worktree … already exists"** — leftover checkout dirs that are
   not in `git worktree list` block `worktree add`. `prepareWorktree` now
   `rm -rf`s unregistered leftovers after `worktree remove`/`prune`. If a live
   supervisor still fails, manually:
   ```bash
   git -C /path/to/monorepo worktree list
   # only for paths with no live orchestrator:
   rm -rf <orphan-checkout-dir>
   git -C /path/to/monorepo worktree prune
   ```
8. **Paused supervisor** — `respond --action pause` flips status; `resume` and
   force `state.status=running` if needed.
9. Confirm panes return; rename tabs if labels are null:
   `herdr tab rename <tab_id> "{taskId} - {role} - {project} - r{retry}"`.

**Idle after finish is not done:** when every live context exits but the project
is not `complete` (remaining ACs, blocked WI, or unanswered `input_required`),
treat that as empty fleet and recover above the same turn. Narrating
"foundation idle / one worker healthy" without admitting the next context is a
supervisor defect.

## Temporary capacity boost (more parallel contexts)

Only when the operator asks and host memory allows. Cap by free RAM:

`slots ≈ floor((MemAvailableMB - reserve) / memory-per-worker-mb)`.

```bash
node "$CONTROL" kill-supervisor --repo "$REPO" --force true   # preserve herdr tabs
node "$CONTROL" release-supervisor-lock --repo "$REPO" --force true
setsid -f env HERDR_ENV=1 node "$CONTROL" run --repo "$REPO" --host agent --display herdr \
  --max-workers 4 --quota-workers 4 --cpu-per-worker 1 \
  --memory-per-worker-mb 768 --reserve-memory-mb 1024 --max-load-ratio 0.9 \
  --summary-minutes 20 >>/tmp/<subproject>-supervisor.log 2>&1
```

If capacity shows free slots but no new workers appear, `selectClaim` may be
failing on a **locked/stale worktree** left from a prior crash:

```bash
git -C /path/to/monorepo worktree list
# Unlock + remove only worktrees with no live orchestrator PID
git -C /path/to/monorepo worktree unlock <path>
git -C /path/to/monorepo worktree remove --force <path>
git -C /path/to/monorepo worktree prune
```

Never remove worktrees that still have a live `orchestrator.mjs` for that context.

## Coding exhaustion — do not auto-burn

`coding agent failed three times` is **not** auto-retried (supervisor-auto-respond).
Respond with verify-first guidance when the AC is already satisfied on main, or
stop/pause the dependent project until a dependency-root finishes.

## Inject guidance without losing it

1. Write `state.retryQueue[context] = { guidance, attempts: 0 }` **before** the worker exits, or
2. `harness-control.mjs respond --repo … --event <id> --action retry --guidance "…"`, or
3. Rely on the rule: existing `retryQueue` guidance is preserved when `response.auto` is true.

## Diagnose stuck / empty workers

| Symptom | Check |
|---|---|
| Progress near done, one WI looping | Run state `phase` / `currentFeatureId`; pane shows endless `thinking:` |
| WI "never finishes" on integrate/resume / `Checkpoint was not integrated…` with no product change | **Flag drift:** compare plan-branch `feature_list` / ledger `integration=true` vs worktree flags. If plan already integrated, sync worktree flags / skip re-integrate — do **not** recycle coding. Fixed path: `integrate-checkpoint.mjs` skips when plan already has `integration=true`. |
| Dependent E2E fails on Core/API 5xx or contract break | Escalate to root project repair (Supervisor → Core Orchestrator); pause dependent coding retries until API is fixed |
| Static AC but Mintlify/browser up | QA prompt must follow AC observation method — kill mint, restart with audit guidance |
| `status` has workers, herdr empty | Zombie pane IDs — restart supervisors; confirm project-scoped cleanup |
| `workers={}`, no panes, status running | Empty-fleet recovery above (locks / quota / load / **sibling governor reservations**) |
| Goal review exits with code 1 | Often merge lock wait — not a product failure |
| Memory pressure / `Session terminated` | Lower `--max-workers` / `--memory-per-worker-mb`; kill heavy mint/docker leftovers |
| `capacity.limit=0` + high load | Docker build or CPU spike — wait; do not thrash recycles |
| Many `docker ps` leftovers after WIs finish | Workers must `compose down` / `docker rm` what they started (generator RESOURCE_CLEANUP_RULE). Supervisor `kill-worker` / `workerClosed` / operator `stop` also run `cleanupWorktreeRuntime`. Stop orphans not owned by a live worker; keep only stacks a running context still needs. Harden prompts/skills same turn. |
| RAM exhausted while `workers={}` | Leftover `next`/`tsx`/compose from prior contexts — run `kill-worker`/`stop` (teardown) or manual compose down; do not admit more workers until `capacity.available>=1`. |

## Herdr layout

One tab per worker. Label: `{taskId} - {role} - {project} - r{retry}`.
Agent sidebar name remains `worker-<project>-<context>`.
If `herdr tab list` shows null labels, rename immediately so the operator can see work.

### Finished-worker tab cleanup (every 10-min check)

Never leave finished work visible:

1. From `harness-control status`, collect workers with `workerHealth=done` or
   terminal Run State (`completed` / `failed` / `cancelled`).
2. Close the **whole tab** (`herdr tab close <tab_id>`), not only the pane.
3. If status still lists a dead worker after close, clear that entry on the next
   supervisor tick / restart — do not leave orphan tabs for the operator.
4. If you find finished tabs open, treat it as a workflow defect: fix spawn/close
   paths in harness and update this skill the same turn (fail-closed).

## Status poll (10-min pane logs + 20-min fleet)

**Every ~10 minutes — read herdr pane logs** (mandatory; status alone lies):

```bash
export HERDR_ENV=1
herdr pane list | jq -r '.result.panes[] | select(.pane_id != "w1:p1") |
  "\(.pane_id) \(.agent) scroll=\(.scroll.max_offset_from_bottom) status=\(.agent_status)"'
# sample scroll twice ~12s apart; if unchanged + tail is only heartbeats → stuck
# If scroll=0, use --source visible (recent scrollback is empty on wait-only panes)
SCROLL=$(herdr pane list | jq -r --arg p "$PANE" '.result.panes[]|select(.pane_id==$p)|.scroll.max_offset_from_bottom')
SRC=recent; [ "${SCROLL:-0}" = "0" ] && SRC=visible
herdr pane read "$PANE" --source "$SRC" --lines 40 --format text
```

Also check `harness-control status` → `workerHealth` / `mergeLock` (written each supervisor tick):

| `workerHealth[].verdict` | Meaning |
|---|---|
| `healthy` | thinking/tools or scroll advancing |
| `waiting_expected` | merge lock (holder alive) or MCP warmup under budget |
| `stuck` | recycle candidate — no agent output / verdict hang / dead lock holder |
| `done` | terminal run state — **close the tab now** |

**Never recycle** `waiting_expected` merge_lock when `mergeLock.holderAlive=true`,
or MCP warmup still under budget. Act on `stuck` only. Close tabs for `done`.

### Check final verification evidence logs (mandatory)

Do **not** trust pane chatter, `exitCode: 0` on the Input Request alone, or a
QA verdict with empty `defects` when INTEGRATION_QA later disagrees.

On every QA / INTEGRATION_QA / Goal Review completion or failure:

1. Open the matching create-only Evidence Artifact under
   `.git/harness-evidence/<project>/<runId>/<context>/WI-*-<kind>-*.log`
   (latest attempt for that WI).
2. Read the **final JSON verdict** at the bottom (`qa` / `integration` /
   `implementation` / `defects`). That is authoritative.
3. If INTEGRATION_QA reports defects that contradict an earlier `qa: true`
   (classic false green: SKIP_WEB_SERVER workaround, host-only smoke, compose
   not rebuilt), treat the QA pass as invalid — retry with guidance that cites
   the evidence-log defects verbatim and forbids the workaround pass path.
4. When responding to `Integrated Verification failed after Attempt N`, paste
   the concrete expected/observed pairs from that evidence log into
   `--guidance` / `retryQueue[context].guidance`.

Pane tails are for liveness; evidence logs are for pass/fail truth.

### Known false orphan: verdict early-exit (owner still applying ledger)

After `agent: harness verdict received`, hosts SIGTERM the nested agent.
`childPid` dies while `ownerPid` (orchestrator) is still writing the ledger.
Do **not** treat that as an orphan shell or recycle the worker.
Code: `orphanShell` requires `!ownerAlive`; `detectPaneOrchestratorExited` returns
false when the recent tail contains `harness verdict received`.
If you recycle mid-apply, INTEGRATION_QA / Goal Review flags never stick.

### Known false stuck: stale `lastAgentOutputAt`

After a resume, Run State may still carry `lastAgentOutputAt` from a prior
invocation (hours old). That makes `mcp_warmup` look instantly overdue and
recycles healthy workers into the crash bound.

Mitigations (must stay in code):
- Supervisor ignores `lastAgentOutputAt` older than the current worker `startedAt`.
- Orchestrator clears `lastAgentOutputAt` on each new invocation.
- Treat `waiting_expected` + `MCP/plugin warmup before first token` as healthy
  for up to the warmup budget (~90s).

### Control Journal / respond / governor (2026-07-10)

- Journal ids must be monotonic via `journal-meta.json`. Caller-supplied `id`
  fields must not overwrite the allocated id. `respond` falls back to
  `state.pendingInputs` when the journal has recycled ids.
- Resource Governor prunes dead-pid reservations and reuses same
  project/context admissions so orchestrators do not double-book slots.
- Supervisor passes `HARNESS_*` capacity env + `HARNESS_GOVERNOR_RESERVATION`
  into herdr worker panes. Fleet recovery flags are `--force true` (key/value).

### Pane stream smoke check (after spawn / on 10-min pass)

Within ~60s of `CODING → …` / `agent: started`, the pane must show agent activity
(`thinking:` / `tool →` / host stream), not only orchestrator banners.

| Pane tail | Action |
|---|---|
| `thinking:` / `tool →` advancing | Healthy — leave alone |
| Only `orchestrator: …` / `CODING → …` for >60s, no agent stream | Stream/spawn broken — check `agent-stream` + roles; recycle with `--host agent` + composer-2.5 |
| `HARNESS-VERDICT` then only `agent: still working` | Hung after verdict — SIGTERM agent/orchestrator; recycle with host agent + composer-2.5 |
| Empty after `CODING → agent` (no `agent: started`) | Stream/spawn broken — check roles + stream-json; recycle |
| `waiting for merge lock (holder pid=…)` | Expected idle — watch holder pane |
| Rate/usage limit spam | Clear quota pause after cooldown; keep host agent + composer-2.5 |

**Every ~20 minutes — fleet status:** for each subproject `harness-control
status` (include `workerHealth` + `mergeLock`), open goal-scoped inputs only,
`herdr agent list`, free memory. Act on dead supervisors, `stuck` health,
finished tabs still open, or goal-scoped `input_required` that auto-retry cannot
handle. Never treat `status=working` alone as proof of progress.
