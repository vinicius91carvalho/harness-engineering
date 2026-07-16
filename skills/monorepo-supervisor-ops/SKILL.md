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
11. **Any fix must land in the workflow too — that is how the harness
    self-improves.** Session-only recoveries (kill a worker, free RAM, clear
    ghosts, seed guidance, sync a missing `~/.agents` module) are unfinished
    until the same lesson updates `skills/supervisor/` and/or this skill (and
    harness code when mechanical) the same turn, then syncs. Closing an
    incident with only a live command and no skill/code change is a workflow
    defect: the next run will pay the same cost again.
12. **Plan success requires evidence.** Never declare the Project Goal complete
    from status counters or pane chatter alone.
    Cite persisted `run_completed`, `fleetSnapshot.lastRunCompletedSummary`, and
    Goal Review evidence logs.
13. **Blocker project wins host RAM.** Root/blocker empty fleet +
    `memory.slots=0` while dependents hold `next-server` / compose / heavy
    worktree PIDs → `kill-worker --force true` (or pause) the lower-priority
    sibling **same turn**, re-check `capacity` until `available>=1`, admit the
    blocker, then resume dependents. CauseFlow order: **core before web**
    (dashboard E2E depends on core golden-path QA/INTEGRATION).

## Sync harness changes to live skills

After editing in the harness-engineering repo:

```bash
cp skills/generator/lib/{agent-spawn,agent-stream,supervisor-auto-respond,orphan-claims,fleet-snapshot,control-beacon,wake-triage,observation-method,repair-router,control-journal,resource-governor,worktree-teardown,worker-lifecycle,browser-cleanup,claim-lease,evidence-guidance}.mjs ~/.agents/skills/generator/lib/
cp skills/generator/prompts/feature.mjs ~/.agents/skills/generator/prompts/
cp skills/generator/orchestrator.mjs ~/.agents/skills/generator/
cp skills/supervisor/scripts/harness-control.mjs ~/.agents/skills/supervisor/scripts/
cp skills/supervisor/lib/{herdr-spawn,supervisor-preflight}.mjs ~/.agents/skills/supervisor/lib/
cp skills/supervisor/SKILL.md ~/.agents/skills/supervisor/SKILL.md
cp skills/monorepo-supervisor-ops/SKILL.md ~/.agents/skills/monorepo-supervisor-ops/SKILL.md
```

**First invocation:** `harness-control preflight --repo <subproject>` (also runs
inside `start` / supervisor `initialize`). Clears ghost runs/leases/governor
slots and gates on `reconcile --check` before admission.

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

Hybrid Empty-Fleet Recovery runs on every supervisor tick: Ghost Claims, dead
same-host merge/state locks, orphan PIDs, crash-bound reset, and re-admit when
capacity allows.
Prefer `harness-control status` → `fleetSnapshot` (`supervisorLive`,
`ghostClaims`, `emptyFleetActionable`, `needsGoalReviewRetry`,
`lastRunCompletedSummary`) and Control Events (`empty_fleet_actionable`,
`dead_runtime`, `stale_lock_cleared`) over per-sibling state scrapes.

For monorepo-wide bearings in one call:

```bash
node "$CONTROL" fleet-snapshot --repo /path/to/monorepo/<any-subproject-or-root>
# uses .harness/projects.json when present; or --projects core,web,relay
```

Manual recovery remains for remote locks, quota pauses, RAM pressure, and other
operator judgment cases the tick cannot resolve.

When `fleetSnapshot.emptyFleetActionable`, herdr has only the default tab, or
`capacity.limit=0` with no spawns:

1. **Dead merge/state lock (remote or tick missed)** — use CLI with `--force true`:
   ```bash
   node "$CONTROL" clear-dead-lock --repo "$REPO" --lock merge --force true
   node "$CONTROL" clear-dead-lock --repo "$REPO" --lock state --force true
   ```
2. **Quota pause** — rate-limit sets `quota.pauseUntil` → slots 0:
   ```bash
   node "$CONTROL" quota --repo "$REPO" --pause-until 0 --workers 3
   node "$CONTROL" resume --repo "$REPO"
   ```
3. **Capacity 0 from load/RAM** — Docker `--no-cache` builds spike load above
   `maxLoadRatio`; wait for build to finish. Free RAM: kill orphan `tsx`/`node`
   APIs left in finished worktrees (not the active AC worktree). Prefer
   `kill-worker --force true` / operator `stop` — both now run programmatic
   worktree teardown (`.harness/app.pid`, worktree-scoped `next`/`tsx`,
   `docker compose down --remove-orphans`) via `worktree-teardown.mjs`, not
   browser cleanup alone.
4. **Sibling holds host-wide Resource Governor slots** — `capacity.available=0`
   while this project's `workers={}` but `capacity.state.reservations` shows other
   subprojects (or a zombie idle-shell worker still reserved). Check
   `.git/harness-governor/reservations.json`. Pause or `kill-worker --force true`
   lower-priority / crash-looping siblings, then hard-restart or wait for this
   supervisor to admit. Do not declare "nothing left to claim" until reservations
   and `feature_list` remaining WIs are checked.
5. **RAM below reserve (`memory.slots=0`, `MemAvailable` < `reserveMb`)** — even
   with free governor reservation count, admission stays at 0. Treat as empty
   fleet for the blocked root project: pause sibling supervisors, `kill-worker
   --force true` on lower-priority contexts, free orphan docker/node leftovers,
   then re-check `capacity` until `available>=1` and admit the blocker. Do not
   leave the blocked project idle while siblings keep burning RAM.

   **Concrete CauseFlow pattern (2026-07-11):** core Run State `resuming` /
   `phase: qa` for WI-AC-060 with `workers={}` while web dashboard held two
   `next-server` processes (~GB each) → `capacity.memory.slots=0`. Fix: 
   `kill-worker --repo …/web --context dashboard --force true` (teardown kills
   `.harness/app.pid` / next), seed core `retryQueue` with evidence-backed QA
   guidance, confirm core admits, leave web OSS worker if capacity allows, let
   dashboard re-admit after core progresses. Narrating "web healthy, core idle"
   without this step is a supervisor defect.

   **Goal Review leftovers (2026-07-11 web):** after `goal:false` reopens WIs,
   website/dashboard `next-server` / `next dev` on the **integration checkout**
   (`…/causeflow-ai/web`, not `*-wt-*`) can keep ~3–4 GiB and leave
   `memory.slots=0` while `retryQueue` holds OSS. Kill those main-checkout next
   PIDs (cwd under `web/apps/{website,dashboard}`), keep core compose + active
   worktree, re-check `capacity.available>=1`, then let auto-retry admit. Do not
   wait on an empty fleet with free quota and a seeded retry.

   **Do not kill integration-checkout next during live INTEGRATION_QA:** web IV
   for OSS often runs Playwright against dashboard on `…/causeflow-ai/web` (not
   a `*-wt-*` worktree). If `ac-061-capstone` / `next-server` under that cwd is
   the active IV, leave it alone — freeing "orphans" mid-suite suicides the
   dashboard. Only reap main-checkout next when `workers={}` or no Playwright IV
   owns that port.
6. **"Preparing worktree … already exists"** — leftover checkout dirs that are
   not in `git worktree list` block `worktree add`. `prepareWorktree` now
   `rm -rf`s unregistered leftovers after `worktree remove`/`prune`. If a live
   supervisor still fails, manually:
   ```bash
   git -C /path/to/monorepo worktree list
   # only for paths with no live orchestrator:
   rm -rf <orphan-checkout-dir>
   git -C /path/to/monorepo worktree prune
   ```
7. **Paused supervisor** — `respond --action pause` flips status; `resume` and
   force `state.status=running` if needed.
8. Confirm panes return; rename tabs if labels are null:
   `herdr tab rename <tab_id> "{taskId} - {role} - {project} - r{retry}"`.

**Idle after finish is not done:** when `fleetSnapshot.emptyFleetActionable` or
every live context exits but the project is not `complete` (remaining ACs,
blocked WI, or unanswered `input_required`), treat that as empty fleet and apply
judgment cases above the same turn.
Narrating "foundation idle / one worker healthy" without admitting the next
context is a supervisor defect.

**Post-goal-complete with new ACs (2026-07-15 web):** after Goal Review
`goal:true`, a later `planner`/`reconcile` can append Work Items (e.g. AC-077+)
while Control state stays `status=complete` with stale progress (76/76) and
`supervisorLive=false`. `fleetSnapshot.wakeTriage.shouldWake` becomes true, but
`harness-control start` may refuse while `complete` + clean + matching
`reviewedHead`, or the operator may only see "complete" and leave the queue idle.
Same-turn fix:
1. `node "$CONTROL" resume --repo "$REPO"` (flips `complete` → `running`).
2. Start/run the supervisor (`--host agent`, CauseFlow ops) with Resource
   Governor env if swap/load still elevated (`HARNESS_MAX_SWAP_USED_RATIO`,
   `HARNESS_MAX_LOAD_RATIO`).
3. Confirm `progress.total` matches reconciled `feature_list` and workers admit
   Ready contexts (leave live Claim Leases / generator orchestrators alone).
Do not narrate "web complete" when `shouldWake` is true and ledger has
non-integrated WIs.

**Operator-approved governor overrides (swap/load):** when Resource Governor
returns `no-capacity` with `pressureReason` `load` or `swap` (or both) and the
operator explicitly approves raising limits for this host, export the same
env for **both** direct `/generator` orchestrators and `harness-control run` /
`start`:
`HARNESS_MAX_LOAD_RATIO` (e.g. `1.5`) and `HARNESS_MAX_SWAP_USED_RATIO`
(e.g. `0.6`). Defaults remain `0.85` / `0.2` — never raise silently.
Confirm `capacity.available>=1` after export before claiming or admitting.

**Idle after full integrate ≠ Goal Review:** when `fleetSnapshot.needsGoalReviewRetry`
or progress is N/N/N with claims empty, capacity `available>=1`, and the Goal
Review gate is admissible, but `workers={}` and no `goal_review_started` event
appears within ~1–2 minutes (heartbeat still advancing), treat that as empty
fleet.
Clear expired `quota.pauseUntil`, seed `retryQueue['goal-review']` if useful,
then `kill-supervisor --force true` + `release-supervisor-lock --force true` and
restart `run` (CauseFlow: `--host agent`).
A long-lived supervisor can keep heartbeats while never admitting Goal Review
after `context_completed` (observed 2026-07-11 on web after WI-AC-061; restart
admitted `goal-review` immediately).
Do not narrate "waiting for Goal Review" across ticks without this recovery.

**Goal Review `harness-progress` dirty ≠ product block:** if Input Request is
`Execution blocked` / `Goal Review must be read-only` solely for
`harness-progress/*.md` while evidence already names real ACs (e.g. AC-014),
do not only re-queue Goal Review. Ignore journal dirt in `checkout-dirt.mjs`,
reopen the named WIs (ledger flags false), seed that context's repair guidance,
and clear a stale `retryQueue['goal-review']` so repair admits before GR.

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

**Provider usage limit ≠ product failure (2026-07-11 web WI-AC-061):** when stuck
defects are only `ActionRequiredError` / "You're out of usage" (Cursor) after a
prior attempt already recorded CODING+QA green (and INTEGRATION_QA died mid-run
on the same quota error), respond `retry` with verify-first guidance: resume at
INTEGRATION_QA, re-run the Playwright capstone, emit `integration:true` — do
**not** treat it as a three-strike product rewrite. Prefer `--host agent` /
composer-2.5 and avoid burning the exhausted Cursor lane.

**Verify-first false green (2026-07-12 web WI-AC-014):** coding emitted
`implementation:true` with zero product diff while still observing
`Location: https://dashboard-staging…` on `/get-started`, and QA/IV rubber-stamped
it. Goal Review correctly failed again. Ops response: kill-worker, force ledger
`implementation/qa/integration=false`, seed guidance that forbids verify-first-pass,
requires Dockerfile `ARG`/`ENV NEXT_PUBLIC_DASHBOARD_URL` before `next build` plus
compose `build.args`, and gates on curl against the **compose image** (not
`next dev`). Do not leave a QA-phase worker running on a false coding green.

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
| `fleetSnapshot.emptyFleetActionable`, no panes, status running | Empty-fleet judgment above (quota / load / **sibling governor reservations** / Goal Review) |
| Goal review exits with code 1 | Often merge lock wait — not a product failure |
| Memory pressure / `Session terminated` | Lower `--max-workers` / `--memory-per-worker-mb`; kill heavy mint/docker leftovers |
| `capacity.limit=0` + high load | Docker build or CPU spike — wait; do not thrash recycles |
| Many `docker ps` leftovers after WIs finish | Workers must tear down what they started (generator RESOURCE_CLEANUP_RULE). Shared infra (postgres/redis/hindsight) is ref-counted via `compose-shared.mjs` — last holder may `compose down`; siblings only stop/rm app services. Supervisor `kill-worker` / `workerClosed` / operator `stop` run `cleanupWorktreeRuntime`. Stop orphans not owned by a live holder; keep stacks a running context still needs. Harden prompts/skills same turn. |
| RAM exhausted while many compose stacks up | Prefer reuse: one shared infra stack per project, rebuild only api/worker/dashboard under test. Do not admit more workers until `capacity.available>=1` and `docker stats` shows headroom. Pause lower-priority siblings (Hard rule 6). |
| Blocker idle, sibling `next-server` huge RSS | Hard rule 12: kill/pause lower-priority sibling (web dashboard before core QA), admit blocker, update workflow if the playbook was missing. |

## Herdr layout

One tab per worker. Label: `{taskId} - {role} - {project} - r{retry}`.
Agent sidebar name remains `worker-<project>-<context>`.
If `herdr tab list` shows null labels, rename immediately so the operator can see work.

### Finished-worker tab cleanup (automatic reaper)

Never leave finished work visible.
The supervisor runs `finished-tab-reaper.mjs` on each tick (rate-limited) and immediately after `workerClosed` / `workerHealth=done`, calling `closeStaleHarnessPanesForProject` with live-worker pane ids kept safe.

1. From `harness-control status` or `fleet-snapshot`, collect workers with `workerHealth=done` or terminal Run State (`completed` / `failed` / `cancelled`).
2. Close the **whole tab** (`herdr tab close <tab_id>`), not only the pane.
3. If status still lists a dead worker after close, clear that entry on the next supervisor tick / restart — do not leave orphan tabs for the operator.
4. If you find finished tabs open, treat it as a workflow defect: fix spawn/close paths in harness and update this skill the same turn (fail-closed).

**Cursor Task/subagent mirror tabs:** Cursor `Task` / `Subagent` hooks open
herdr tabs (`cursor-sub-*`, labels like `🧮 generalPurpose: …`) with
`herdr-subagent-logview.py`. They are **not** harness `worker-<project>-*`
panes; the finished-tab reaper ignores them.
Automatic cleanup (supervisor tick, rate-limited):
`cursor-subagent-tab-reaper.mjs` via `reapCursorSubagentTabs` in
`harness-control.mjs` (120s orphan grace, dead logview, stale cwd).
Logview self-closes on `turn_ended` or 45s idle after transcript growth; stop
hook uses the same 120s orphan grace for entries with no transcript.
Manual fallback when zombies remain:
`node harness-control.mjs reap-cursor-subagents --repo <path>` (force reap), or
`herdr tab close <tab_id>` per finished `cursor-sub-*` tab after confirming
the live main agent tab is not targeted.

**Fleet Snapshot** (`skills/generator/lib/fleet-snapshot.mjs`, schema `harness-fleet-snapshot.v1`):
cross-project bearings for monorepo recovery — journal tips, capacity/slots,
active workers, stuck, pending inputs, ops fields (`supervisorLive`,
`ghostClaims`, `emptyFleetActionable`, `needsGoalReviewRetry`,
`lastRunCompletedSummary`, `hostResources`, `governorReservations`,
`sharedRuntime`, `recoveryReasons`, `pressureAdvice`), optional
`wakeTriage.shouldWake`.
Active worker counts exclude rows with an explicit recorded PID that is no longer live.
Use `sharedRuntime` before stopping Docker infra: shared holders keep infra up,
while private app containers from owned runtime manifests are safe cleanup targets.
CLI: `harness-control fleet-snapshot --repo <path>`; `status` also embeds
`fleetSnapshot` for the current project.
Multi-project: pass a monorepo subproject path or root with `.harness/projects.json`
registered, or `--projects core,web,relay` — prefer one fleet-snapshot call over
per-sibling status scrape loops.

## Status poll (fleet snapshot + targeted pane checks)

**Every ~10 minutes — prefer fleet snapshot, then targeted pane reads:**

```bash
node "$CONTROL" fleet-snapshot --repo /path/to/monorepo/<subproject-or-root>
# scan projects[].emptyFleetActionable, ghostClaims, needsGoalReviewRetry,
# workerHealth, wakeTriage.shouldWake
```

Hybrid Empty-Fleet Recovery on each supervisor tick owns ghost claims, dead locks,
and re-admit.
Use herdr pane tails only for `workerHealth=stuck` judgment or stream smoke
checks — not as the primary empty-fleet detector.

When a pane needs inspection:

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

Per-project `harness-control status` → `workerHealth` / `mergeLock` when
fleet-snapshot is unavailable:

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
   `--guidance` / `retryQueue[context].guidance` (supervisor auto-retry and
   `input_required` events also attach `detail.guidanceExcerpt` when an evidence
   path is present).

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

**Every ~20 minutes — fleet status:** run `fleet-snapshot` (or per-subproject
`status` when needed), open goal-scoped inputs only, `herdr agent list`, free
memory.
Act on unrepaired `empty_fleet_actionable` / `dead_runtime`, dead supervisors,
`stuck` health, finished tabs still open, or goal-scoped `input_required` that
auto-retry cannot handle.
Never treat `status=working` alone as proof of progress.

When reporting plan or monorepo completion, cite persisted `run_completed` and
`lastRunCompletedSummary` plus Goal Review evidence — not progress counters alone.

**Stop narrating when idle (do not regress):** skip the fleet-status print for
a subproject when `status.wakeTriage.shouldWake === false` (or the events batch
is only fold/absorb) and progress counters / `workers` are unchanged since the
last report, or when `status` is already `complete`/`stopped` with a persisted
`run_completed` / `fleetSnapshot.lastRunCompletedSummary`.
Ack folded event IDs and move on instead of printing another "still idle" update.
When **every** subproject in the monorepo is complete,
stop the ops poll loop entirely - supervisors are already idle, so continue
straight to closeout rather than scheduling another 10/20-minute check.
A prior run kept firing idle 20-minute checks after all four subprojects reached
`run_completed`, until the operator manually stopped the loop; treat that as a
defect, not normal cadence.
