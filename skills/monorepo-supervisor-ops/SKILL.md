---
name: monorepo-supervisor-ops
description: Operate multiple harness supervisors in one monorepo (background workers, log tail, harness-control status, fleet-snapshot, leases, merge lock, empty-fleet recovery, composer-2.5 ops). Use when restarting supervisors, diagnosing empty/stuck workers, clearing dead locks/quota pauses, or syncing harness skills to ~/.agents.
---

# Monorepo supervisor ops

Use this when several subprojects share one Git top-level (e.g. `core`, `web`,
`relay`, `public-docs`) and each runs its own `harness-control.mjs` supervisor.

## Hard rules

1. Edit harness code / installed skills only unless the operator says otherwise.
2. Do not commit unless asked. While a plan is in flight, land harness commits on
   the plan branch (side jobs branch from it) — never directly onto `main`/`master`.
3. Each subproject has its own supervisor state and worker logs — never confuse
   sibling contexts when reading `status` or tailing logs.
4. Workers always run in the background. Monitor with `status`, logs, and `fleet-snapshot`.
5. Shared merge lock (`.git/harness-locks/generator-merge`) is normal — one integrator at a time.
6. **CauseFlow 10-min ops model:** always recycle/retry with `--host agent` and **composer-2.5** (never `composer-2.5-fast`, never `pi`/deepseek for this monitoring loop).
7. **Coding route ≠ ops host:** Work Item coding stays OSS-first via `.harness/roles.json`. Do not reorder coding to put Claude/Codex/Composer first. Ops recycles use composer-2.5; that is not the coding ladder.
8. **Fail-closed:** empty fleet or `workerHealth=stuck` → fix now and update this skill / harness code in the same turn. Do not only report.
9. **Always check final verification logs** (supervisor Hard rules): evidence
   artifacts under `.git/harness-evidence/` are pass/fail truth. Do not rely only
   on `status` / progress counters / log tails.
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
    from status counters or log chatter alone.
    Cite persisted `run_completed`, `fleetSnapshot.lastRunCompletedSummary`, and
    Goal Review evidence logs.
13. **Blocker project wins host RAM.** Root/blocker empty fleet +
    `memory.slots=0` while dependents hold `next-server` / compose / heavy
    worktree PIDs → `kill-worker --force true` (or pause) the lower-priority
    sibling **same turn**, re-check `capacity` until `available>=1`, admit the
    blocker, then resume dependents. CauseFlow order: **core before web**
    (dashboard E2E depends on core golden-path QA/INTEGRATION).
14. **systemd Control Host must pin `agent`.** `install-ops-cron.sh` always sets
    absolute `Environment=HARNESS_WAKE_AGENT=…` and a `PATH` that includes
    `$HOME/.local/bin`. Never rely on an interactive shell PATH — user units
    otherwise hit `spawnSync agent ENOENT` on `--invoke-agent`.
15. **After harness-engineering skill/script edits that affect a live fleet,
    finish the sync checklist** (below) the same turn — missing sync is how
    false empty-fleet escalations and cron ENOENT recur.

## Sync harness changes to live skills

After editing in the harness-engineering repo:

```bash
# Copy the whole lib tree so importLib deps stay complete (cherry-picking drifts).
# Discoverable Cursor/Agent skills must be harness-* only. Keep unprefixed
# supervisor/generator trees as runtime aliases (scripts+lib, NO SKILL.md) so
# relative imports and older CONTROL=…/supervisor/… paths keep working without
# registering /supervisor beside /harness-supervisor.
mkdir -p ~/.agents/skills/generator/lib ~/.agents/skills/generator/prompts \
  ~/.agents/skills/harness-generator/lib ~/.agents/skills/harness-generator/prompts \
  ~/.agents/skills/supervisor/scripts ~/.agents/skills/supervisor/lib \
  ~/.agents/skills/harness-supervisor/scripts ~/.agents/skills/harness-supervisor/lib \
  ~/.agents/skills/harness-monorepo-supervisor-ops/scripts
# Full generator tree (lib + adapters + prompts + templates + workflow +
# orchestrator/reconcile). Cherry-picking only lib/ leaves
# adapters/hosts.mjs missing → orchestrator exits on spawn →
# supervisor_tick_failed / worker_crash_loop spam every ~250ms.
# Runtime alias `generator/` (no SKILL.md) must stay complete for
# harness-supervisor/lib static imports (`../../generator/lib/...`) and
# harness-control importLib default path.
rsync -a --delete --exclude SKILL.md --exclude node_modules \
  skills/generator/ ~/.agents/skills/generator/
rsync -a --delete --exclude node_modules \
  skills/generator/ ~/.agents/skills/harness-generator/
sed -i 's/^name: generator$/name: harness-generator/' \
  ~/.agents/skills/harness-generator/SKILL.md
# Same full sync for any in-repo Cursor skill mirrors (causeflow example):
#   rsync -a --delete --exclude SKILL.md skills/generator/ \
#     <repo>/.cursor/skills/generator/
#   rsync -a --delete skills/generator/ \
#     <repo>/.cursor/skills/harness-generator/
cp skills/supervisor/scripts/harness-control.mjs ~/.agents/skills/supervisor/scripts/
cp skills/supervisor/scripts/harness-control.mjs ~/.agents/skills/harness-supervisor/scripts/
cp -R skills/supervisor/lib/. ~/.agents/skills/supervisor/lib/
cp -R skills/supervisor/lib/. ~/.agents/skills/harness-supervisor/lib/
cp skills/supervisor/SKILL.md ~/.agents/skills/harness-supervisor/SKILL.md
# Rewrite frontmatter so the slash command is /harness-supervisor (not /supervisor).
sed -i 's/^name: supervisor$/name: harness-supervisor/' ~/.agents/skills/harness-supervisor/SKILL.md
rm -f ~/.agents/skills/supervisor/SKILL.md ~/.agents/skills/generator/SKILL.md \
  ~/.agents/skills/monorepo-supervisor-ops/SKILL.md
cp skills/monorepo-supervisor-ops/SKILL.md ~/.agents/skills/harness-monorepo-supervisor-ops/SKILL.md
sed -i 's/^name: monorepo-supervisor-ops$/name: harness-monorepo-supervisor-ops/' \
  ~/.agents/skills/harness-monorepo-supervisor-ops/SKILL.md
cp -R skills/monorepo-supervisor-ops/scripts/. ~/.agents/skills/harness-monorepo-supervisor-ops/scripts/
# Optional runtime alias for older script relative paths:
mkdir -p ~/.agents/skills/monorepo-supervisor-ops/scripts
cp -R skills/monorepo-supervisor-ops/scripts/. ~/.agents/skills/monorepo-supervisor-ops/scripts/
```

Ops cron (`install-ops-cron.sh`) resolves `HARNESS_CONTROL` from
`~/.agents/skills/harness-supervisor/scripts/harness-control.mjs` (with a
`supervisor/` runtime fallback) — keep **generator lib** synced too or
`fleet-snapshot` fails with `ERR_MODULE_NOT_FOUND`.

**First invocation:** `harness-control preflight --repo <subproject>` (also runs
inside `start` / supervisor `initialize`). Clears ghost runs/leases/governor
slots and gates on `reconcile --check` before admission.

Also document: Control Journal must keep monotonic ids (`journal-meta.json`); Resource Governor must prune dead-pid reservations and reuse same-context admissions so orchestrators do not double-book slots.

Recycle orchestrators (`SIGTERM`) so new spawn/prompt code loads.
kill -9 on old supervisors so their `stop()` path does not interrupt live workers.
Use guarded harness-control fleet commands instead of raw `kill`/`rm`:

```bash
# Default SIGKILL = recycle supervisor only (preserves live workers / GR).
node "$CONTROL" kill-supervisor --repo "$REPO" --force true
# Explicit reclaim (tears down workers): --signal SIGTERM or --teardown-workers true
node "$CONTROL" release-supervisor-lock --repo "$REPO" --force true
node "$CONTROL" clear-dead-lock --repo "$REPO" --lock merge --force true
node "$CONTROL" kill-worker --repo "$REPO" --context <context> --force true
node "$CONTROL" release-lease --repo "$REPO" --context <context> --force true
```

`--force true` is required when a local supervisor PID is still recorded as live
(harness-control parses `--key value` pairs; bare `--force` is invalid).
Pass `HARNESS_SUPERVISOR_TOKEN` instead when you hold the active lease.
**Do not** use `kill-supervisor` when you only need to attach new `--guidance` —
seed `retryQueue` with non-generic text (triggers `retry_guidance_recycle`) or
`kill-worker` for that context. Pre-2026-07-17 `kill-supervisor --force` always
tore workers down before SIGKILL (Control Host AC-025 false-stuck wake).

## Restart one subproject supervisor (keep workers)

**Prefer `harness-control start` (detached + unref / transient systemd unit).**
Do **not** rely on Cursor/`agent` shell `setsid -f … run` — session teardown
often SIGTERMs that tree and re-fires `supervisor_stopped` while Claim Leases
stay healthy (CauseFlow root 2026-07-17: QA/IV kept running; ops only saw
`supervisor_dead_with_work`).

`ops-remediate` → `harness-control remediate` now plans
`ensure_supervisor_running` when `supervisorLive=false` and remaining WIs > 0
(status not paused/stopped/complete), then calls detached `start`. Control Host
judgment wakes for `supervisor_stopped` should **resume + start** only when
still dead — never `kill-supervisor` first if `supervisorPid` is already null
or the PID is dead. If `status` shows a live supervisor + healthy external
claim, ack and exit.

**ops-cron oneshot KillMode (CauseFlow root 2026-07-17):**
`harness-ops-cron.service` is `Type=oneshot`. Default `KillMode=control-group`
SIGTERMs every process still in that cgroup when the oneshot exits — including
a supervisor that `start` detached+unref'd from `ops-remediate` / Control Host
`--invoke-agent`. Symptom: `goal_review_started` → `worker_health` →
`supervisor_stopped` SIGTERM within ~1s, repeating every timer tick; GR Run
State `interrupted` / `orchestrator received SIGTERM`; false
`empty_fleet_actionable` + memory `input_required` while ledger is N/N.
Same-turn: set `KillMode=process` on the unit (`install-ops-cron.sh` does),
`daemon-reload`, `respond --action retry` for the escalation, recycle
supervisor via `kill-supervisor --force true` + `start` (under systemd,
`start` also uses a transient `harness-supervisor-<project>.service` with
`KillMode=process` and passes `HARNESS_*` / `PATH` via `--setenv` — without
that, approved `HARNESS_MAX_SWAP_USED_RATIO` is lost and GR spuriously
escalates on swap). Do not escalate host RAM while the real bug is cgroup
kill-on-exit.

**False wake after remediate already restarted (CauseFlow root 2026-07-17):**
Cursor session SIGTERM → `supervisor_stopped` + transient `empty_fleet_actionable`
(workers=0 between preflight and `goal_review_started`) while ops-remediate has
already detached-started the supervisor and admitted claim-less Goal Review.
Wake triage must **absorb** when the current fleet snapshot shows
`supervisorLive=true` and/or `liveClaimWorkers>=1` — do not let stale
`event.workers=0` clobber live claims in `isEmptyFleetRepaired`. Control Host
still acks and exits when GR is healthy; the absorb path avoids burning another
LLM turn next time.

```bash
CONTROL=~/.agents/skills/harness-supervisor/scripts/harness-control.mjs
REPO=/path/to/monorepo/<subproject>

# Only when supervisor is actually dead / wedged:
# node "$CONTROL" kill-supervisor --repo "$REPO" --force true
node "$CONTROL" release-supervisor-lock --repo "$REPO" --force true
node "$CONTROL" resume --repo "$REPO" 2>/dev/null || true
# CauseFlow ops: --host agent. Pass HARNESS_MAX_SWAP_USED_RATIO when approved.
# harness-control parses argv as `--key value` pairs — use `--force true`, not bare `--force`.
node "$CONTROL" start --repo "$REPO" --host agent \
  --max-workers 3 --quota-workers 3 --cpu-per-worker 1 \
  --memory-per-worker-mb 640 --reserve-memory-mb 1024 --max-load-ratio 0.9 \
  --summary-minutes 20
```

Background orchestrators survive supervisor restart; `status` and worker logs
reattach on the next tick.

## Empty fleet recovery (workers={}, no live progress)

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

When `fleetSnapshot.emptyFleetActionable` or `capacity.limit=0` with no spawns:

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
   `maxLoadRatio`; wait for build to finish.
   Free RAM: kill orphan `tsx`/`node` APIs left in finished worktrees (not the active AC worktree).
   Prefer `kill-worker --force true` / operator `stop` — both run
   `cleanupWorktreeRuntime` → `stopWorktreeApp` (see generator `RESOURCE_CLEANUP_RULE`),
   not browser cleanup alone.
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
   `next-server` processes (~GB each) → `capacity.memory.slots=0`.
   Fix: `kill-worker --repo …/web --context dashboard --force true`
   (teardown via `stopWorktreeApp` / `RESOURCE_CLEANUP_RULE`),
   seed core `retryQueue` with evidence-backed QA guidance, confirm core admits,
   leave web OSS worker if capacity allows, let dashboard re-admit after core progresses.
   Narrating "web healthy, core idle" without this step is a supervisor defect.

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

**Idle after finish is not done:** when `fleetSnapshot.emptyFleetActionable` or
every live context exits but the project is not `complete` (remaining ACs,
blocked WI, or unanswered `input_required`), treat that as empty fleet and apply
judgment cases above the same turn.
Narrating "foundation idle / one worker healthy" without admitting the next
context is a supervisor defect.

**Live Claim Lease ≠ empty fleet:** `state.workers={}` after a supervisor recycle
does **not** mean idle when `generator-claims.json` + Run State show a live
orchestrator (`ownerPid`/`childPid` alive). `fleet-snapshot` / `ops-remediate`
must count `liveClaimWorkers` before alerting `empty_fleet_actionable` or
escalating. False empty-fleet escalations while work is running are defects.

**Incomplete `skills/generator` alias after harness-* rename (2026-07-17):**
partial sync (lib-only / missing `adapters/`) makes every supervisor tick throw
`generator module missing: …/observation-method.mjs` or every worker spawn
`ERR_MODULE_NOT_FOUND: …/adapters/hosts.mjs`. Journal floods with
`supervisor_tick_failed` / `worker_crash_loop` / `input_required` at ~4 Hz.
Same-turn fix: stop supervisor (`kill-supervisor --force true`), rsync the
**full** `skills/generator/` tree into both `harness-generator/` and the
unprefixed `generator/` runtime alias (no SKILL.md on the alias), smoke
`import adapters/hosts.mjs`, then `start`/`run` again. Update the sync
checklist above — never cherry-pick only `lib/`.
Hardening (same incident): `install-reconcile` `syncCursorSkillLinks` materializes
full `generator`/`supervisor` aliases (strips SKILL.md);
`resolveGeneratorDir` prefers a complete tree over an incomplete alias;
tick failures back off and stop flooding `immediate` events on repeats.

**Ornith died under live golden-path QA (root WI-AC-025, 2026-07-17):** coding
VERIFY-FIRST can pass and then tear down Ornith; the QA agent may sit in a
shell loop waiting on `:8081` while `workerHealth` stays `healthy` (external
live claim) and `lastAgentOutputAt` goes stale. Probe evidence shows
`Ornith unreachable` / Core `/health` `llm=degraded`. Same-turn host remediation
(do not recycle while swap already blocks re-admit):
1. Start Ornith with `~/tools/llama-session.sh 8081` (binds `0.0.0.0`).
2. Wait until `curl http://127.0.0.1:8081/v1/models` → 200 and Core health
   `llm=ok` (reload Core if needed).
3. Write the live `llama-server` PID into the worktree
   `.harness/ornith.pid` so the waiting QA shell's `kill -0` check passes.
4. Keep Ornith up through INTEGRATION_QA — do not stop it between QA phases.
Recycle with evidence-backed guidance only if Ornith cannot stay up or the
agent is past the stuck threshold with no shell child making progress.

**Empty harness-control worker log ≠ stuck (root WI-AC-026, 2026-07-17):**
Cursor `agent` sessions often leave `.git/harness-control/**/logs/<ctx>-*.log`
at 0 bytes because agent stdout is captured inside `runHostAgentSession` and
never reaches the orchestrator pipe, while VERIFY-FIRST still advances
`.harness/wi-ac-*-verify-first.json` (and evidence artifacts) via shell/browser
tools without `onAgentOutput`. Observed false wakes: `worker_stuck` /
`empty_worker_log` / `silent_agent` while Chrome + `ac-025-browser-probe.mjs`
were live and `pass:true` was written. Same-turn judgment: read Run State
(`harness-runs/<ctx>.json` → `phase` / `childPid` / `lastAgentOutputAt` /
`evidence`) and worktree probe mtimes — do **not** recycle when those move.
Durable fix: `workerActivityAgeMs` + ops-cron-check treat evidence /
`.harness/wi-*` side channels as activity; empty log alone is only a warn when
those are also stale. Free swap (stale Playwright MCP / completed-sibling
`next-server`) so re-admit stays possible after a real recycle.

**Goal Review false stuck on empty log (root, 2026-07-17):** claim-less Goal
Review Run State often omits `worktree` / `startedAt` while
`state.workers['goal-review'].worktree` is the integration checkout. Side-channel
detection that only reads `runState.worktree` + `wi-ac-*` then ignores live
`.harness/runtime-owned.jsonl`, `goal-review-probes.json`, and `gr-*` compose/
Ornith probes — supervisor marks `log/heartbeat stale` at 10m and SIGTERMs a
busy GR agent (exit 130). Same-turn: leave a live GR alone when those files
move; durable: merge `worker.worktree`/`startedAt` into stuck inspection,
count GR harness artifacts via `isWorkerSideChannelArtifact`, persist
`worktree`+`startedAt` from orchestrator on GR start, sync generator +
supervisor, SIGKILL-recycle supervisor only (not the GR worker).

**`supervisor_failed` "object is not iterable" on SIGTERM (root Goal Review,
2026-07-17):** after N/N integrate, Goal Review on the integration checkout
appended `.harness/runtime-owned.jsonl` with
`kind: goal-review-runtime` and `pids: { core, worker }` (object map) plus
`shared_reused` / `preexisting`. Cursor session teardown SIGTERMs the
supervisor → `workerClosed` → `cleanupWorktreeRuntime` →
`for (const pid of row.pids)` throws → `supervisor_failed` and a dead
supervisor until `ops-remediate` `ensure_supervisor_running`. Same-turn fix:
1. Harden `worktree-teardown.mjs` (`normalizeRuntimeIdList`, skip inventory
   / shared-checkout teardown); wrap `cleanupWorkerResources` so teardown
   never reaches `this.crash()`.
2. Sync generator + supervisor scripts; **SIGKILL** recycle the supervisor
   (`kill-supervisor --force true` default signal) so `stop()` does not
   interrupt the live Goal Review orchestrator, then `start` with CauseFlow
   ops (`--host agent`, approved swap override).
3. Goal Review is **claim-less** (no `generator-claims.json` row). After
   supervisor recycle, `liveClaimWorkers` must still count
   `harness-runs/goal-review.json` live PIDs — otherwise false
   `empty_fleet_actionable` + swap `input_required` while GR is running.
   Fixed in `countLiveClaims` + `loadLiveCountRunStates` /
   `hasGoalReviewWorker` live-run checks. Do **not** escalate while those
   PIDs are alive (empty worker log is normal for Cursor `agent`).

**Durable heartbeat (required for unattended runs):** install
`skills/monorepo-supervisor-ops/scripts/install-ops-cron.sh --repo "$REPO"
--notify` so `ops-remediate.mjs` runs every N minutes without Cursor chat.
That path remediates host contention, re-checks the fleet, and desktop-notifies /
writes `ops-escalate.json` when playbooks fail. Chat `/loop` alone is not enough.

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

**Stale root `needs_input` + orphan amend response (2026-07-16):** monorepo-root
supervisor state under `.git/harness-control/state.json` can sit in
`needs_input` for months with a goal-scoped Input Request still `pending` while
`.git/harness-control/responses/<id>.json` already holds `action: amend`.
`respond` then fails with `already has a different response` unless the new
call matches that file exactly. Same-turn recovery when specs now exist:
1. `respond --event <id> --action amend --guidance ""` (or match the file).
2. `resume` then `start` with CauseFlow ops (`--host agent`) and any approved
   governor env (`HARNESS_MAX_SWAP_USED_RATIO=0.6` when swap pressure was the
   prior deny).
3. First start **consumes amend → status=paused** (by design). Immediately
   `resume` + `start` again so workers admit — do not narrate "paused" as a
   product block.
Preflight after a failed direct orchestrator may clear that Claim Lease as
abandoned; leave it — the restarted supervisor re-claims Ready contexts.

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

**N/N + `needsGoalReviewRetry` + dead supervisor (CauseFlow root 2026-07-17):**
after the last WI integrates, `remaining` WI count is 0 while
`needsGoalReviewRetry=true`. If the supervisor is SIGTERM'd mid Goal Review
(session teardown / `setsid` tree), `ops-remediate` used to skip
`ensure_supervisor_running` because `remainingOf<=0`, leaving
`status=interrupted`, empty fleet wakes, and a dead merge-lock holder.
Same-turn: `clear-dead-lock --lock merge`, `resume` + detached `start`
(CauseFlow ops), seed `retryQueue['goal-review']` if the prior GR run was
interrupted. Durable: `host-remediation.mjs` treats `needsGoalReviewRetry` as
supervisor work (same as remaining WIs) and does not classify N/N+GR-owed as
complete for reservation/stop logic.

**Ledger N/N + empty fleet + dirty-checkout from `.cursor/` (2026-07-17 root):**
Execution Ledger can be fully integrated (`harness-ledger/<project>.json`) with
evidence INTEGRATION_QA green while `feature_list.json` flags still show all
`false` (flag drift — ignore for GR). If `needsGoalReviewRetry=true` but no
`goal_review_started`, probe `goalReviewAdmissible` / porcelain: tracked M/D
under `.cursor/plugins/local/harness/` or `.cursor/skills/` from harness-*
rename/sync is **not** product dirt. `checkout-dirt.mjs` must ignore those
mirrors (same class as `harness-progress/`). Same-turn: sync the fixed
`checkout-dirt.mjs`, seed `retryQueue['goal-review']` with
flag-drift-ignore guidance, recycle the supervisor (`kill-supervisor` +
`start` with CauseFlow ops). Do not escalate "dirty checkout" for skill-mirror
churn alone, and do not reopen WIs from `feature_list` when the ledger is green.

**Ledger N/N + empty fleet + dirty `feature_list.json` (2026-07-17 root):**
after GR reopen repair re-integrates (e.g. WI-AC-026 IV `integration:true`)
the ledger is N/N and `needsGoalReviewRetry=true`, but workers leave
`M feature_list.json` (flag flips + unicode escapes) uncommitted. That alone
keeps `goalReviewAdmissible` at `dirty-checkout` → repeating
`empty_fleet_actionable` with capacity free and `workers={}`. Same-turn:
confirm latest IV evidence is green and ledger N/N; ignore `feature_list.json`
in `checkout-dirt.mjs` (ledger is truth); optionally
`git checkout -- feature_list.json` to clear porcelain noise; seed
`retryQueue['goal-review']` (ignore flag drift; do not reopen from
feature_list); recycle supervisor (`kill-supervisor` + CauseFlow `start`).
Do not reopen repair WIs or escalate host RAM for catalog-flag dirt.

**Goal Review `harness-progress` dirty ≠ product block:** if Input Request is
`Execution blocked` / `Goal Review must be read-only` solely for
`harness-progress/*.md` while evidence already names real ACs (e.g. AC-014),
do not only re-queue Goal Review. Ignore journal dirt in `checkout-dirt.mjs`,
reopen the named WIs (ledger flags false), seed that context's repair guidance,
and clear a stale `retryQueue['goal-review']` so repair admits before GR.

**Goal Review `.harness/wi-ac-*` / `goal-review*` dirty ≠ product block
(2026-07-17 root):** GR black-box probes rewrite tracked verify-first /
compose probe JSON under `.harness/`. If `goal-review.result.json` is
`blocked:true` solely for `Goal Review must be read-only; checkout changed:
M .harness/wi-ac-*-verify-first.json` (etc.) while the Evidence Artifact
already names real ACs (e.g. AC-025/AC-026 Ornith `127.0.0.1:8081` vs
`host.docker.internal`), treat that as harness dirty-gate defect — not a clean
GR pass. Same-turn: extend `checkout-dirt.mjs` side-channel ignore (aligned with
`isWorkerSideChannelArtifact`), sync to `~/.agents`, restore or leave the
probe files (they no longer block), reopen the named WIs from the evidence
verdict, seed `retryQueue[<context>]` with expected/observed pairs, and clear
`retryQueue['goal-review']` so repair admits before another GR.
**Do not stop at narrating the failure to the operator** — discovering this on
a “has it finished?” status check is already a Control Host wake; remediate
before/with the answer (supervisor hard rule 10b).

**Unmapped escalate when evidence already names AC-NNN (CauseFlow root AC-018, 2026-07-17):**
`goal-review.result.json` can omit `acceptanceCheckIds` while the Evidence Artifact
has `acceptanceCheckIds:["AC-018"]` and the summary mentions AC-018. Old
`enrichResultFromEvidence` early-returned because mined `baseIds` looked complete,
leaving no explicit array — `planGoalReviewCloseRecovery` (includeSummary:false)
then escalated `unmapped_defects` / `input_required` even though WI-AC-018 was
already in `reopened`. Same-turn Control Host: patch result ACs from the evidence
log, force ledger WI flags false (coding must run — do not resume at QA on a
stale `implementation:true`), seed `retryQueue[<context>]` with expected/observed
(shared circuit breaker blocking fallbackProfileId hops), clear
`retryQueue['goal-review']`, admit repair. Durable: (1) enrich materializes evidence
`acceptanceCheckIds` onto result before close recovery; (2) `attempt-machine`
clears implementation/qa/integration when `--guidance` / guided Repair Plan is
present so CODING cannot be skipped. Regression in `lib_test.mjs`. Do not re-poll
chat `/loop`.

**Wrong agent `reopened` beats evidence ACs (CauseFlow root AC-018→WI-AC-025, 2026-07-17):**
GR evidence `acceptanceCheckIds:["AC-018"]` (circuit breaker blocks fallback hops)
while the agent result set `reopened:["WI-AC-025"]` because defect prose said
"AC-025 completes". Old `planWorkerClosedActions` short-circuited on
`result.reopened` → `goal_defects` (emit only; no `applyGoalReviewFailedRecovery`)
and admitted oss-golden-path VERIFY-FIRST with empty guidance. Same-turn Control
Host: `kill-worker` the false repair; `kill-supervisor`; restore ledger WI-AC-025
green; reopen WI-AC-018 (all flags false); patch result `acceptanceCheckIds` +
`reopened` to AC-018/WI-AC-018; seed `retryQueue[core-oss-runtime]` with
expected/observed (forbid verify-first / MERGE-grep-only); clear
`retryQueue[goal-review]`; `start`. Durable: evidence `goal_review_failed` path
runs **before** trusting agent `reopened` (`failure-policy.mjs`). Regression in
`lib_test.mjs`. Do not re-poll chat `/loop`.

**Evidence log `route={…}` preamble must parse (2026-07-17 root):** harness
evidence headers include `route={"adapter":…}` before the verdict JSON.
`parseVerdict` must prefer the **last** parseable `{…}` object — first-brace
slices fail JSON.parse and leave `enrichResultFromEvidence` blind, so
`recoverStaleGoalReviewFailure` spams `goal_review_retry` on dirt while the
evidence artifact already names AC-025/AC-026. Fix lives in
`worker-outcome.mjs`; dirt_retry must also no-op while any ledger WI remains
unintegrated; briefs must not title dirt-only `dirtRetry` as “Goal Review
failed”.

**Home-project AC ownership beats sibling WI id collisions (2026-07-17 root):**
when root catalog maps AC-025/AC-026, do **not** reopen completed `core`/`web`
ledgers that reuse the same `WI-AC-025` ids from older plans. Restore sibling
ledgers + clear falsely seeded sibling `retryQueue` if a bad reopen already
landed; `planEvidenceReopen` skips foreign rows whose ACs are already covered
by the home catalog.

**Durable X-minute path owns the run (2026-07-17):** Cursor chat is optional.
`ops-remediate --notify --invoke-agent` is the automatic project-state check.
Mechanical path: `goal-review-recovery.mjs` + `workerClosed` action
`goal_review_failed` + tick `recoverStaleGoalReviewFailure` reopen integrated
WIs from evidence without waiting for chat. Briefs must say “Goal Review
failed/owed” (never “nearly done”) when `needsGoalReviewRetry` /
`lastGoalReviewFailure`. Wake spam (`supervisor_tick_failed`, crash-loop,
empty_fleet) is deduped via `dedupeJudgmentWakes` so judgment agent sees
`goal_review_failed` / `input_required`.

## Temporary capacity boost (more parallel contexts)

Only when the operator asks and host memory allows. Cap by free RAM:

`slots ≈ floor((MemAvailableMB - reserve) / memory-per-worker-mb)`.

```bash
node "$CONTROL" kill-supervisor --repo "$REPO" --force true
node "$CONTROL" release-supervisor-lock --repo "$REPO" --force true
setsid -f node "$CONTROL" run --repo "$REPO" --host agent \
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

`coding agent failed three times` is **not** auto-retried (failure-policy).
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

**Stuck recycle must not drop GR repair guidance (CauseFlow root oss-golden-path,
2026-07-17):** `worker_stuck` / exit-130 auto-retry raced a `repairInFlight`
Goal Review reopen and rewrote `retryQueue` / coding `repairPlan` to generic
`Auto-retry: worker process exited…` while AC-025 defects still named Ornith
`127.0.0.1:8081` vs `host.docker.internal`. Same-turn Control Host: do **not**
second-recycle when the new worker is healthy with advancing
`.harness/wi-ac-*` / live `ac-025-browser-probe` / Cursor session log under
`/tmp/cursor-agent-logs-*` (empty harness-control log alone is still a false
stuck signal). Durable: `failure-policy` `repairGuidanceFromGoalReviewFailure` +
`stuckWorkerRetryGuidance` prefer `lastGoalReviewFailure` defects over generic
Auto-retry on stuck enqueue and `planAutoRetryResponses`. Sync generator lib +
recycle supervisor only when loading that path mid-fleet.

**Live `childPid` + defer guidance recycle (CauseFlow root oss-golden-path,
2026-07-17 #4504–#4512):** long AC-025 browser investigation polls freeze
`.harness/wi-ac-*` mtimes past the stuck threshold while `agent` +
`ac-025-browser-probe` stay alive → false `log/heartbeat stale` → SIGTERM
(exit 130). Then `input_required` auto-retry + `retry_guidance_recycle`
SIGTERM'd a healthy worker that already had `pass:true` / `remCount=1` before
the harness verdict could emit. Durable: `workerActivityAgeMs` treats a live
Run State `childPid` as progress (fresh side-channel if <1× threshold; else
grace 0-age until 3× stuck threshold, ignoring stale leftover `wi-ac-*`);
`retry_guidance_recycle` emits `retry_guidance_deferred` and keeps the worker
when `childPid` is live and not stuck. Sync generator lib + supervisor script;
SIGKILL-recycle supervisor only (preserve workers). Control Host: never
second-recycle while live QA probe/`childPid` progresses; ack wakes only.

**Orphaned coding commit after Goal Review reopen (CauseFlow root AC-025/AC-026,
2026-07-17):** coding notes claimed `ORNITH_LOCAL_PRESET.baseUrl` →
`host.docker.internal:8081` (commit `53b09cad`) and QA/IV went green, but the
commit was **not an ancestor of** `plan/opensource-docker` — plan HEAD still
shipped `127.0.0.1:8081`, so Goal Review failed again. Same-turn Control Host:
1. Open `goal-review.result.json` (product defects, not dirty-gate).
2. Confirm `git merge-base --is-ancestor <claimed-sha> HEAD` fails while
   `git cat-file -t <sha>` still has the object.
3. Kill any IV/coding worker on the unrepaired plan HEAD; reset ledger flags
   false; seed `retryQueue[oss-golden-path]` with cherry-pick/re-apply guidance
   (forbid verify-first / manual baseUrl override); clear `retryQueue[goal-review]`.
4. Live supervisor overwrites raw `state.json` edits — **kill-supervisor first**,
   seed on disk, then `start`. If auto-retry races with generic
   `Auto-retry: worker process exited…`, non-generic guidance must still reach
   `--guidance` (harness-control: `claim_new` attaches queued guidance;
   `workers.has` recycles when non-generic retry guidance was about to be
   dropped). Confirm orchestrator argv has `--guidance` **and** the coding
   prompt includes the Repair Plan (attempt-machine maps `--guidance` →
   `repairPlan` even when status≠blocked; older generators only did this for
   blocked Resume — argv alone is not enough).
5. Gate: compose probe with **shipped** Ornith (local) preset
   (`activeProfile.baseUrl` must be `host.docker.internal:8081`).

**Stale GR reopen after IV green (CauseFlow root AC-025/AC-026, 2026-07-17):**
`recoverStaleGoalReviewFailure` used `goal-review.result.json` mtime / rewritten
`at` as the IV cutoff. Control Host enrich/notes bump those after INTEGRATION_QA
green → `hasNewerGreenIntegrationQa` returns false → false-reopens WI-AC-025 and
admits coding against a plan HEAD that already ships
`ORNITH_LOCAL_PRESET=host.docker.internal` (IV `pass:true`). Same-turn:
1. Confirm latest `WI-AC-025-*-integration_qa-*.log` has `integration:true` and
   `.harness/wi-ac-025-iv-browser.json` activate step uses host.docker.internal.
2. `kill-worker --force true` the false repair; restore ledger WI-AC-025
   implementation/qa/integration=true; keep WI-AC-026 false if the docs gate
   is still owed; seed `retryQueue[oss-golden-path]` for AC-026 only; clear
   `retryQueue[goal-review]`.
3. Sync HE `goal-review-recovery.mjs` + `harness-control.mjs` (pass
   `evidenceMtimeMs` from the GR evidence log; prefer it over result mtime/`at`)
   into `~/.agents` + monorepo mirrors, then SIGKILL-recycle the supervisor.
4. Do not re-poll chat `/loop` — ops-remediate owns the next tick.

## Inject guidance without losing it

1. Write `state.retryQueue[context] = { guidance, attempts: 0 }` **before** the worker exits, or
2. `harness-control.mjs respond --repo … --event <id> --action retry --guidance "…"`, or
3. Rely on the rule: existing `retryQueue` guidance is preserved when `response.auto` is true.

## Diagnose stuck / empty workers

| Symptom | Check |
|---|---|
| Progress near done, one WI looping | Run state `phase` / `currentFeatureId`; tail worker log for endless `thinking:` |
| WI "never finishes" on integrate/resume / `Checkpoint was not integrated…` with no product change | **Flag drift:** compare plan-branch `feature_list` / ledger `integration=true` vs worktree flags. If plan already integrated, sync worktree flags / skip re-integrate — do **not** recycle coding. Fixed path: `integrate-checkpoint.mjs` skips when plan already has `integration=true`. |
| Dependent E2E fails on Core/API 5xx or contract break | Escalate to root project repair (Supervisor → Core Orchestrator); pause dependent coding retries until API is fixed |
| Static AC but Mintlify/browser up | QA prompt must follow AC observation method — kill mint, restart with audit guidance |
| `status` lists workers but PIDs are dead | Ghost worker row — restart supervisor; check `fleetSnapshot` and `workerHealth` |
| `fleetSnapshot.emptyFleetActionable`, status running | Empty-fleet judgment above (quota / load / **sibling governor reservations** / Goal Review) |
| Goal review exits with code 1 | Often merge lock wait — not a product failure |
| Memory pressure / `Session terminated` | Lower `--max-workers` / `--memory-per-worker-mb`; kill heavy mint/docker leftovers |
| `capacity.limit=0` + high load | Docker build or CPU spike — wait; do not thrash recycles |
| Many `docker ps` leftovers after WIs finish | Workers must tear down what they started (generator `RESOURCE_CLEANUP_RULE` / `stopWorktreeApp`). Shared infra is ref-counted via `compose-shared.mjs`. Supervisor `kill-worker` / `workerClosed` / operator `stop` run `cleanupWorktreeRuntime`. Stop orphans not owned by a live holder; harden prompts/skills same turn. |
| RAM exhausted while many compose stacks up | Prefer reuse: one shared infra stack per project, rebuild only api/worker/dashboard under test. Do not admit more workers until `capacity.available>=1` and `docker stats` shows headroom. Pause lower-priority siblings (Hard rule 13). |
| Blocker idle, sibling `next-server` huge RSS | Hard rule 13: kill/pause lower-priority sibling (web dashboard before core QA), admit blocker, update workflow if the playbook was missing. |

## Worker monitoring (background-only)

Workers always run in the background. Monitor through:

- `harness-control fleet-snapshot` — cross-project bearings (preferred)
- `harness-control status` — `workerHealth`, `workers`, `mergeLock`, capacity
- Worker logs under `.git/harness-control/<project>/logs/`
- Evidence Artifacts under `.git/harness-evidence/` (pass/fail truth)

**Fleet Snapshot** (`skills/supervisor/lib/fleet-snapshot.mjs`, schema `harness-fleet-snapshot.v1`):
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

## Status poll (fleet snapshot + log tail)

**Every ~10 minutes — prefer fleet snapshot, then targeted log tails:**

```bash
node "$CONTROL" fleet-snapshot --repo /path/to/monorepo/<subproject-or-root>
# scan projects[].emptyFleetActionable, ghostClaims, needsGoalReviewRetry,
# workerHealth, wakeTriage.shouldWake
```

Hybrid Empty-Fleet Recovery on each supervisor tick owns ghost claims, dead locks,
and re-admit.
Tail worker logs only for `workerHealth=stuck` judgment or log smoke checks —
not as the primary empty-fleet detector.

When a worker needs inspection, tail its log:

```bash
LOG_DIR=/path/to/monorepo/.git/harness-control/<subproject>/logs
ls -lt "$LOG_DIR" | head
tail -n 40 "$LOG_DIR/<context>-<pid>.log"
# sample twice ~12s apart; if unchanged + tail is only heartbeats → stuck
```

Per-project `harness-control status` → `workerHealth` / `mergeLock` when
fleet-snapshot is unavailable:

| `workerHealth[].verdict` | Meaning |
|---|---|
| `healthy` | log/heartbeat fresh |
| `stuck` | recycle candidate - stale log/heartbeat |

Act on `stuck` only.
Judge liveness from worker logs under `.git/harness-control/<project>/logs/`,
not from visible panes.

### Check final verification evidence logs (mandatory)

Do **not** trust log chatter, `exitCode: 0` on the Input Request alone, or a
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

Worker log tails are for liveness; evidence logs are for pass/fail truth.

### Known false orphan: verdict early-exit (owner still applying ledger)

After `agent: harness verdict received`, hosts SIGTERM the nested agent.
`childPid` dies while `ownerPid` (orchestrator) is still writing the ledger.
Do **not** treat that as an orphan shell or recycle the worker.
Code: `orphanShell` requires `!ownerAlive`.
If the recent worker log tail contains `harness verdict received`, leave the owner alone.
If you recycle mid-apply, INTEGRATION_QA / Goal Review flags never stick.

### Known false stuck: stale `lastAgentOutputAt`

After a resume, Run State may still carry `lastAgentOutputAt` from a prior
invocation (hours old), which can make a fresh worker look stuck.

Mitigations (must stay in code):
- Supervisor ignores `lastAgentOutputAt` older than the current worker `startedAt`.
- Orchestrator clears `lastAgentOutputAt` on each new invocation.
- Prefer the worker log under `.git/harness-control/<project>/logs/` over a single stale timestamp.

### Control Journal / respond / governor (2026-07-10)

- Journal ids must be monotonic via `journal-meta.json`. Caller-supplied `id`
  fields must not overwrite the allocated id. `respond` falls back to
  `state.pendingInputs` when the journal has recycled ids.
- Resource Governor prunes dead-pid reservations and reuses same
  project/context admissions so orchestrators do not double-book slots.
- Supervisor passes `HARNESS_*` capacity env + `HARNESS_GOVERNOR_RESERVATION`
  into background workers. Fleet recovery flags are `--force true` (key/value).

### Worker log smoke check (after spawn / on 10-min pass)

Within ~60s of `CODING → …` / `agent: started`, the worker log under
`.git/harness-control/<project>/logs/` must show agent activity
(`thinking:` / `tool →` / host output), not only orchestrator banners.

| Log tail | Action |
|---|---|
| `thinking:` / `tool →` advancing | Healthy - leave alone |
| Only `orchestrator: …` / `CODING → …` for >60s, no agent output | Spawn/host broken - check roles + worker log; recycle with `--host agent` + composer-2.5 |
| `HARNESS-VERDICT` then only `agent: still working` | Hung after verdict - SIGTERM agent/orchestrator; recycle with host agent + composer-2.5 |
| Empty after `CODING → agent` (no `agent: started`) | Spawn/host broken - check roles + worker log; recycle |
| `waiting for merge lock (holder pid=…)` | Expected idle - watch holder log |
| Rate/usage limit spam | Clear quota pause after cooldown; keep host agent + composer-2.5 |

**Every ~20 minutes — fleet status:** run `fleet-snapshot` (or per-subproject
`status` when needed), open goal-scoped inputs only, free memory.
Act on unrepaired `empty_fleet_actionable` / `dead_runtime`, dead supervisors,
`stuck` health, or goal-scoped `input_required` that auto-retry cannot handle.
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

**Root starved by completed sibling goal-review reservation (2026-07-16):** host-wide
Resource Governor shared `reservations.json`. A long-lived **web** supervisor
(91/91 integrated, `workers={}`) kept renewing a `goal-review` reservation
`cost=2` under its own PID, driving root `capacity.available=0` /
`activeCost=2` while root had blocked WIs + `empty_fleet_actionable`. Cron
correctly reported empty fleet; nothing admitted. Same-turn fix (blocker wins):
1. `kill-supervisor --repo <web> --force true` + `release-supervisor-lock --force true`
2. `preflight --repo <root>` (prunes dead/ghost governor rows)
3. Confirm `capacity.available>=1`, then force-resume blocked root contexts /
   let `retryQueue` admit.
Do not leave a complete sibling supervisor running if it holds goal-review cost
that zeros the blocker project's slots. Prefer pause/stop completed dependents
while the root OSS plan is in flight.

**Cursor Agent `/loop` ≠ unattended Control Host (2026-07-16):** a background
`while sleep; echo AGENT_LOOP_TICK_*` with `notify_on_output` can emit ticks into
the terminal file while the chat session stays idle — the Control Host LLM does
**not** reliably get a new turn. Observed: root supervisor kept admitting/
integrating WIs; two 5m ticks accumulated unread until the operator asked.
Do **not** tell the operator the fleet is "babysat" solely because that shell
loop is armed. Truth model:
1. **`harness-control` supervisor tick** owns admission, auto-retry, stuck
   recycle, empty-fleet recovery, and anomaly emits — **zero LLM tokens**.
2. Control Host is the **operator’s representative**: progress briefs (desktop
   notify on counter/claim changes), judgment wakes via
   `wake-control-host.mjs` (consumer `control-host-wake`), intelligent fix or
   escalate — not `/loop` polling.
3. Prefer: durable supervisor + ops cron with `--notify --invoke-agent`; never
   `/loop status` every N minutes. Briefs keep the operator informed; judgment
   invokes the agent only on real wakes (stuck, crash-loop, inputs, empty fleet).

## Host ops cron (systemd) — remediate + event-driven wake

For unattended runs, the **process supervisor** arms/disarms the systemd user
timer (not a Cursor `/loop`, not a manual forever-on cron):

- `harness-control start` / `run` → `ensureOpsCron` → `install-ops-cron.sh`
  (`--notify --invoke-agent` against the Git top-level)
- `run_completed` / `stop` / abort → `maybeDisableOpsCron` →
  `disable-ops-cron.sh` only when **every** fleet project is idle/complete

It must **auto-fix** host stalls, run the Control Host wake bridge, and
escalate when it cannot — never wait for the operator to ping chat. Opt out
with `HARNESS_OPS_CRON=0`. Manual scripts remain for recovery only:

```bash
# Recovery / one-off (prefer supervisor lifecycle above).
bash skills/monorepo-supervisor-ops/scripts/install-ops-cron.sh \
  --repo /path/to/monorepo \
  --minutes 5 \
  --notify \
  --invoke-agent
bash skills/monorepo-supervisor-ops/scripts/disable-ops-cron.sh

# Confirm unit pins agent (Hard rule 14):
#   systemctl --user cat harness-ops-cron.service | rg 'HARNESS_WAKE_AGENT|Environment=PATH'

# Manual one-shot (remediate + check + wake bridge):
node skills/monorepo-supervisor-ops/scripts/ops-remediate.mjs \
  --repo /path/to/monorepo --notify --wake-host

# Wake bridge only (progress brief + judgment notify):
node skills/monorepo-supervisor-ops/scripts/wake-control-host.mjs \
  --repo /path/to/monorepo --notify --brief

# Mechanical remediation only:
node ~/.agents/skills/harness-supervisor/scripts/harness-control.mjs \
  remediate --repo /path/to/monorepo
```

**Idle fleets stay quiet (2026-07-22):** supervisor lifecycle disarms the timer
when the fleet is complete; additionally `ops-remediate` takes a cheap
`fleet-snapshot` first and exits 0 when idle (no remediate/notify/wake).
`ops-cron-check --notify` also skips "Harness Ok … w=0" heartbeats. Leaving a
`--notify` timer armed after `run_completed` used to spam desktop every 5
minutes — treat that as a defect (supervisor must disarm; ops tick must no-op).

Every active-workflow tick:
1. `harness-control remediate` — clear stale `index.lock`, release sibling
   complete/idle `goal-review` (and other unbacked) governor reservations that
   starve the blocker project, write `ops-escalate.json` after repeated misses.
2. `ops-cron-check` — durable verdict + desktop notify when workflow/attention
   is active (not idle heartbeats).
3. `wake-control-host.mjs` — journal consumer `control-host-wake`; ack
   fold/absorb with zero LLM tokens; desktop-notify / optional `--invoke-agent`
   only when Wake Triage `shouldWake`. After `--invoke-agent`, ack only when
   `wake-ack.mjs` sees a post-condition (reopen / retryQueue / workers / remaining);
   `invoke-noop` defers ack and re-notifies. Cursor chat ≠ wake target — notify
   copy says durable Control Host is remediating.
4. Live supervisor tick promotes `ops-escalate.json` → goal `input_required`
   and also runs the same remediation planner each loop.

Artifacts (under the shared Git dir):
- `.git/harness-control/ops-cron-last.json` / `ops-cron-status.txt`
- `.git/harness-control/ops-cron.jsonl`
- `.git/harness-control/ops-escalate.json` (transient escalation marker)
- `.git/harness-control/wake-control-host.jsonl`

Exit codes: `0` = healthy enough (also idle skip), `1` = attention/escalation,
`2` = tool failure. Unit uses `SuccessExitStatus=1`. With `--notify`, desktop
notify fires only on active-workflow or attention ticks. Integration auto-retry
guidance is **MERGE/IV ONLY** (no re-coding).

### CauseFlow unattended ops profile (durable)

For `/home/vinicius/projects/causeflow-ai` root OSS plan:

| Knob | Value |
|---|---|
| Integration branch | `plan/opensource-docker` |
| Ops / coding host | `--host agent` |
| Approved swap override | `HARNESS_MAX_SWAP_USED_RATIO=0.6` (operator-approved; default 0.2) |
| systemd timer | `harness-ops-cron.timer` (armed by `harness-control start`/`run`) |
| Cron flags | `--wake-host --notify --invoke-agent` (supervisor lifecycle default) |
| Control | `~/.agents/skills/harness-supervisor/scripts/harness-control.mjs` (after sync) |

Export the swap override for **both** `harness-control run` and the systemd
unit `Environment=` so snapshot capacity matches live admission.

### Sync checklist after harness-engineering edits (live fleet)

When you change `skills/supervisor`, `skills/generator`, or
`skills/monorepo-supervisor-ops` (or their scripts/lib) while a fleet is running:

1. Sync HE → `~/.agents/skills/{harness-supervisor,harness-generator,harness-monorepo-supervisor-ops}/` (scripts + lib + SKILL.md with `name: harness-*`). Also sync unprefixed `supervisor`/`generator` **runtime** trees (scripts/lib only — never SKILL.md) when relative imports need them.
2. Sync the same hosted trees into the monorepo mirrors: `$REPO/.cursor/skills/harness-*` and plugin copies under `.cursor/plugins/local/harness/skills/` when present.
3. If `install-ops-cron.sh` or unit env changed: re-run install (`--notify --invoke-agent`) so systemd picks up `HARNESS_WAKE_AGENT` / `PATH`.
4. Recycle live `harness-control run` for affected projects (kill-supervisor + release lock + start/run with the same governor env).
5. Smoke: `node …/ops-remediate.mjs --repo "$REPO" --notify --wake-host` exits 0/1 (not 2) and wake bridge does not report `agent ENOENT`.

Skipping this checklist leaves the process supervisor on old code while cron
reads a mix of HE and `~/.agents` — false escalations and missing modules follow.

Inspect with:

```bash
systemctl --user status harness-ops-cron.timer
journalctl --user -u harness-ops-cron.service -n 50 --no-pager
cat "$(git -C /path/to/monorepo rev-parse --git-common-dir)/harness-control/ops-cron-last.json"
```

Stop when the plan is done (supervisor should already disarm; manual fallback):

```bash
bash skills/monorepo-supervisor-ops/scripts/disable-ops-cron.sh
# or: systemctl --user disable --now harness-ops-cron.timer
```
