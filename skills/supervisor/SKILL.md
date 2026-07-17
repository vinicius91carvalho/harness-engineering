---
name: supervisor
description: Run a software Project Goal for long periods through the harness supervisor, bounded parallel workers, durable status, and user notifications.
allowed-tools: Bash, Read, Skill
---

# Harness Supervisor

Act as a Supervisor. You own goal intake and user communication; the harness
owns scheduling, worker admission, coding/QA retries, leases, integration, and
completion. Never create raw coding subagents beside the supervisor: all workers
must pass through its Resource Governor.

## Hard rules (always)

1. **Always check final verification logs.** After every coding / QA /
   INTEGRATION_QA / Goal Review completion or failure, open the matching
   Evidence Artifact under `.git/harness-evidence/<project>/<runId>/<context>/`
   (`WI-*-coding-*.log`, `WI-*-qa-*.log`, `WI-*-integration_qa-*.log`,
   `goal-*-goal_review-*.log`) and read the **bottom JSON verdict**
   (`implementation` / `qa` / `integration` / `goal` / `defects`).
   That log is the pass/fail source of truth.
2. **Do not rely only on status checks.** `harness-control status`, progress
   counters (`implemented/qa/integrated`), `workerHealth`, worker log tails, and
   bare process `exitCode` are liveness/scheduling signals only. They can show
   green while the evidence log records defects (or a false `qa: true` with
   empty defects that INTEGRATION_QA later contradicts).
3. When reporting progress or answering Input Requests, cite defects from the
   evidence log. Retry guidance must quote expected/observed pairs from that
   final log — never invent from status alone. `harness-control input` and
   auto-retry responses attach `detail.guidanceExcerpt` from create-only evidence
   artifacts (read-only; see `evidence-guidance.mjs`).
4. Never create raw coding subagents beside the supervisor: all workers must
   pass through its Resource Governor.
5. **Any fix must land in the workflow too — that is how the harness self-improves.**
   A live recovery (free RAM, kill a sibling worker, clear a ghost lease, sync a
   missing skill module, seed retry guidance, patch a one-off command) is not
   finished until the same lesson is written into `skills/supervisor/`,
   `skills/monorepo-supervisor-ops/`, and/or harness code under
   `skills/generator/` + `skills/supervisor/scripts/`, with a regression check
   when the defect is mechanical, then synced to `~/.agents` (and OpenCode
   copies). Session-only fixes that never update the workflow are a defect:
   the next run will re-derive the same recovery by hand.
6. **Blocker project wins host RAM.** When the root/blocker subproject
   (`workers={}`, remaining WIs, `memory.slots=0` / `capacity.available=0`) while
   a dependent sibling still holds large runtimes (`next-server`, `tsx`, compose),
   fail-closed the same turn: `kill-worker --force true` (or pause) the
   lower-priority sibling context, re-check capacity, admit the blocker, seed
   evidence-backed `retryQueue` guidance. Prefer root-before-dependent order
   (e.g. core QA/INTEGRATION before web dashboard E2E). See
   `monorepo-supervisor-ops` empty-fleet recovery (RAM / sibling cases).
7. **Supervise means keep work moving — never go silent.** The Control Host must
   not end a turn while the project is not `complete` / `run_completed` unless
   an armed durable heartbeat is running (`ops-remediate` systemd timer **with
   `--notify --invoke-agent`** **and** a live `harness-control run`). “Workers
   are healthy” is not done. The **process supervisor + ops-remediate timer**
   must auto-remediate (including Goal Review evidence reopen — see
   `goal-review-recovery.mjs`) and **escalate to the operator** (`input_required`
   + desktop notify) when playbooks fail — never wait for the operator to ask
   “is it working?”. Detecting issues only after the operator pings chat is a
   supervisor defect.
8. **Escalate, don’t stall.** After bounded auto-remediation misses
   (`remediationAttempts` / `REMEDIATION_ESCALATE_AFTER`), raise a goal-scoped
   Input Request with capacity/reservation evidence. Do not loop quietly.
   Count **live Claim Leases / external orchestrators** as workers — never raise
   empty-fleet escalation while a lease owner PID is alive.
9. **Event-driven durable Control Host — no chat token polling.** The X-minute
   project-state check is **`ops-remediate` + `wake-control-host`**, not a Cursor
   `/loop`. Process tick owns admission/recovery at **zero LLM tokens**; Wake
   Triage invokes the judgment agent (`--invoke-agent`) only when `shouldWake`.
   Never `/loop` `status` every N minutes in chat “just to check.” Cursor chat
   that ran `/harness-supervisor` is an **optional overlay** — after stand-down,
   the durable Control Host is the ops-cron `--invoke-agent` path (composer-2.5 /
   `HARNESS_WAKE_AGENT`). Anomaly spam is deduped (`dedupeJudgmentWakes`).
10. **You are the operator’s representative.** Keep them informed (progress
    briefs via `wake-control-host --brief` / desktop notify — never “nearly done”
    while `needsGoalReviewRetry` or `lastGoalReviewFailure`), resolve issues
    intelligently (retry with evidence, recycle silent agents, host remediation,
    GR evidence reopen), escalate only when playbooks fail, and **drive the run
    to `run_completed`**. Silent “workers look fine” while remaining WIs > 0 is
    a defect. Orchestrator heartbeats alone do not prove agent progress — empty
    logs / null `lastAgentOutputAt` past the stuck threshold must recycle.
10b. **Status questions that reveal a failure are a wake — remediate same turn.**
    If the operator asks whether work finished / is healthy / needs anything and
    you find Goal Review `goal:false` / `blocked`, `emptyFleetActionable`,
    `needsGoalReviewRetry`, open Input Requests, or evidence defects: **fix
    first** (evidence-backed reopen/retry, dirty-gate harness repair, capacity
    playbooks), then report what you did. Answering “it failed” / “defects are
    X” and waiting for “do you need to fix something?” is a supervisor defect
    (CauseFlow root 2026-07-17: GR blocked on `.harness/wi-ac-*` dirt while
    evidence already named AC-025/AC-026 — Control Host narrated until asked).
10c. **Goal Review evidence reopen is zero-token.** On GR close
    (`goal_review_failed`) or each remediate tick scanning
    `goal-review.result.json`: if evidence names ACs while those WIs are still
    integrated — reopen ledger flags, seed `retryQueue[context]`, clear
    `retryQueue['goal-review']`, emit `goal_review_failed` (wake). Do not only
    re-queue Goal Review into the same dirty/product wall.
11. **New `skills/supervisor/lib/*` modules must join `CONTROL_MODULES`.**
    `harness-control.mjs` `importLib` only loads allowlisted control modules from
    `supervisor/lib`; anything else is resolved as `generator/lib` and fails with
    `generator module missing`. Same change: add the filename to `CONTROL_MODULES`,
    document it in `lib/README.md`, and add a `lib_test` import/smoke when the
    planner is mechanical.

Let `REPO` be the selected harness project directory (which may be below the Git
top-level), `CONTROL` this skill directory, and
`WORKER_HOST` one authenticated CLI installed on the machine: `claude`, `codex`,
`opencode`, or `agent`. Role routing is selected by project-local `.harness/roles.json`.
Workers always run in the background. Monitor via `harness-control status`,
`fleet-snapshot`, and worker logs under `.git/harness-control/<project>/logs/`.

Control Plane libraries (journal, beacon, Fleet Snapshot, tick/admission
planners, Wake Triage, anomaly detectors, Supervisor Lease, Resource Governor,
host resources, orphan/runtime view) are owned solely by `skills/supervisor/lib/`
- see that directory's `README.md`.
`harness-control.mjs` is the I/O adapter; shared execution primitives remain in
`skills/generator/lib/`. Generator code imports control modules from
`skills/supervisor/lib/` directly (no re-export shims).
**Adding a file under `lib/` without updating `CONTROL_MODULES` is a defect**
(Hard rule 11).

At a monorepo root, resolve one project the same way generator does: `node
"$GENERATOR/reconcile.mjs" --print-root` (set below) walks up for the nearest
`project_specs.xml`, then falls back to `.harness/projects.json` when more than
one project is registered. Planner finalize registers each project there
automatically, so there is nothing to maintain by hand. Each project has its own
specification, Work Item catalog, Execution Ledger, supervisor Control Journal,
and Goal Review. Do not start one aggregate supervisor for multiple project
queues.

## Prepare the goal

Read `CONTEXT.md`, relevant `docs/adr/`, and existing durable harness state before
acting. If the user's `/goal` is not yet represented by `project_specs.xml`, use
the sibling `planner` skill to create it. Make reversible defaults autonomously;
ask only when a material product, safety, credential, or destructive choice has
no safe default.

## Mandatory preflight (first invocation / every start)

Before reporting a goal as started — and before `start`/`run` admit workers —
run harness-control preflight. This is fail-closed and automatic inside
`harness-control start` and supervisor `initialize()`; still invoke it explicitly
when driving by hand so you see the report:

```bash
GENERATOR="$CONTROL/../generator"
[ -d "$GENERATOR" ] || GENERATOR="$CONTROL/../harness-generator"
node "$CONTROL/scripts/harness-control.mjs" preflight --repo "$REPO"
# optional report-only: --repair false
```

Preflight always:

1. `reconcile.mjs --check` (blocks start on failure → `needs_input` / amend)
2. Prunes dead Resource Governor reservations and stale Resource Governor locks
3. Clears dead Claim Lease entries only when claim session **and** run-state
   owner/child PIDs are dead (never under a live orchestrator; does not
   `git branch -D` — orphan worktree dirs are removed separately)
4. Marks ghost Run States (`running` + dead PIDs) as `abandoned`
5. Clears stale `capacity` / dead `workerHealth` / dead `workers` snapshots,
   ghost `mergeLock` rows when the lock dir is absent or the owner PID is dead,
   and dead Control Journal locks (`journal.lock` whose writer PID is gone —
   otherwise `initialize()` dies with `control journal lock timeout`)
6. Seeds evidence-backed `retryQueue` guidance when the queue is empty or only
   generic `Auto-retry:` text (from latest QA / INTEGRATION_QA evidence log)
7. Removes unregistered leftover `*-wt-*` worktree dirs not held by a live run
8. Reports memory admission (warns if slots=0; does not block start)

Dead merge/state locks stay for the supervisor tick (empty-fleet recovery resets
crash-bound when it clears them). Use `clear-dead-lock` only for remote/force.

Do not call `start` until `preflight.ok` is true (or let `start` refuse with
`started:false` / `needs_input`). At a monorepo root, run preflight per
subproject path (`core`, `web`, …), not once at the monorepo root.

Also ensure `project_specs.xml` + `feature_list.json` exist on the integration
branch (see `.harness/integration-branch`):

```bash
node "$GENERATOR/reconcile.mjs" "$REPO" --check
```

## Start or recover

Always inspect first. The state is authoritative after chat compaction or a new
Supervisor session:

```bash
node "$CONTROL/scripts/harness-control.mjs" preflight --repo "$REPO"
node "$CONTROL/scripts/harness-control.mjs" status --repo "$REPO"
node "$CONTROL/scripts/harness-control.mjs" start --repo "$REPO" --host "$WORKER_HOST"
```

`start` runs preflight (repair) after proving no live supervisor lease, then
uses an atomic singleton lease and refuses a live local supervisor or a
fresh remote supervisor lease. If
the prior supervisor is gone, the replacement reads Run State, leaves live Claim
Leases alone, resumes abandoned local contexts, and asks before taking over a
stale lease from another machine. Atomic context claims prevent two workers from
owning the same task.

## Resource policy

The supervisor computes worker capacity without LLM judgment:

`min(configured maximum, CPU slots, memory slots, provider-quota slots)`

High load or a quota cooldown admits no new worker. Active workers are not killed
when capacity falls. Defaults are conservative; set explicit limits when the
machine or provider contract is known:

```bash
node "$CONTROL/scripts/harness-control.mjs" start --repo "$REPO" \
  --host "$WORKER_HOST" --max-workers 4 --quota-workers 2 \
  --cpu-per-worker 2 --memory-per-worker-mb 2048 --reserve-memory-mb 2048 \
  --summary-minutes 20
node "$CONTROL/scripts/harness-control.mjs" quota --repo "$REPO" --workers 1
node "$CONTROL/scripts/harness-control.mjs" capacity --repo "$REPO" --host "$WORKER_HOST"
```

Do not increase limits merely because the user requested speed. Increase them
only from observed available resources and a known concurrent provider quota.

## Relay notifications

Create one durable consumer name per delivery channel
(e.g. `herdr-notify` or `phone`; `herdr-notify` is an opaque journal consumer id, not a herdr UI dependency).
Poll at least once per minute through the Supervisor's native heartbeat/cron mechanism:

```bash
node "$CONTROL/scripts/harness-control.mjs" events --repo "$REPO" --consumer herdr-notify
```

For each returned event:

- **Wake Triage** (`skills/supervisor/lib/wake-triage.mjs`): each `events` row
  includes `wakeTriage: { action, reason }` (`absorb` | `fold` | `wake`).
  `input_required` and goal-scoped inputs always wake; healthy progress folds;
  unrepaired `empty_fleet_actionable` / `dead_runtime` wake; empty-fleet progress
  already repaired by Hybrid Empty-Fleet Recovery folds. Use `status.wakeTriage`
  and `status.fleetSnapshot` for batch hints without parsing the full journal.
- Deliver `immediate:true` events immediately. An `input_required` message must
  include its event ID, scope/context, reason, evidence, and permitted choices.
- Deliver `progress` as the `--summary-minutes` status update (default 20). It
  already contains queue, worker, blocked, and capacity counts.
  Skip this delivery when the run is idle or complete (see tick step 5 above) -
  an unchanged idle/complete `progress` event does not need forced narration.
- `run_completed` is the only completion notification.
- Other events may be folded into the next progress message.

After successful delivery or intentional folding, acknowledge the highest
processed ID. Never acknowledge before delivery:

```bash
node "$CONTROL/scripts/harness-control.mjs" ack --repo "$REPO" \
  --consumer herdr-notify --event "$EVENT_ID"
```

This provides at-least-once relay across agent and UI restarts. If delivery
delivery fails, leave the cursor unchanged and retry. Pending Input Requests also
remain visible in `status`, independent of notification delivery.

## Relay user decisions

Map the user's reply to the exact Input Request ID and one advertised action:

```bash
node "$CONTROL/scripts/harness-control.mjs" respond --repo "$REPO" \
  --event "$EVENT_ID" --action retry --guidance "$USER_GUIDANCE"
```

Responses are idempotent. A retry enters the same Resource Governor as new work;
it does not bypass CPU, memory, load, or quota limits. A retry that cannot
re-acquire its Claim Lease re-raises an Input Request after bounded attempts. A
context blocker does not stop unrelated Ready Work Items. Pause the whole goal only for invalid planning,
unsafe shared state, a required security approval, or unavailable shared
infrastructure.

After submitting a response, inspect `status`. If `supervisorPid` is null, call
`start` so the durable response is consumed. An `amend` response leaves the run
paused: update and reconcile the specification, call `resume`, then call `start`
again. A plain `start` preserves an intentional pause.

## Operational controls

```bash
node "$CONTROL/scripts/harness-control.mjs" pause  --repo "$REPO"
node "$CONTROL/scripts/harness-control.mjs" resume --repo "$REPO"
node "$CONTROL/scripts/harness-control.mjs" stop   --repo "$REPO"
```

**Control-host beacon (ADR-0019):** `harness-control stop` and in-process shutdown
consult `skills/supervisor/lib/control-beacon.mjs` before soft stop.
Soft stop is denied while workers are live (live pid and/or live Run State
owner/child; never default-live without evidence),
required journal consumers (default `herdr-notify`) are behind the journal tip,
or an `input_required` is unacked.
After a bounded wait (~60s) surface an Input Request instead of forcing exit.
`kill-supervisor` and `--force` fleet recovery remain authorized force paths
(ADR-0016). Turn-end shutdown always plans `{ waitForFinalizers: true }` before
lease release.

Never infer completion from an empty queue or agent prose.
Completion requires a persisted `run_completed` event produced by mandatory Goal Review on the integrated plan branch.
Cite `fleetSnapshot.lastRunCompletedSummary` and Goal Review evidence when reporting plan success.

## Worker health and fail-closed ops

`harness-control status` → `workerHealth` is the primary **stuck** signal
(`healthy` | `stuck`).
It is **not** the pass/fail signal for Work Items — see Hard rules above.

Prefer `status.fleetSnapshot` ops fields (`supervisorLive`, `ghostClaims`,
`emptyFleetActionable`, `needsGoalReviewRetry`, `lastRunCompletedSummary`,
`hostResources`, `governorReservations`, `sharedRuntime`, `recoveryReasons`,
`pressureAdvice`) and
recent Control Events over re-scraping raw state files.
`fleetSnapshot.workers` excludes worker rows with an explicit recorded PID that
is no longer live.
Resource Governor admission is swap-aware and reservation-weighted; zero capacity
defers retries without burning Attempts.
The supervisor tick owns Hybrid Empty-Fleet Recovery (ghost claims, dead locks,
orphan PIDs, re-admit when capacity allows) and zero-token anomaly detection
(`anomaly-detect.mjs`: never-started, crash-loop, spawn-failed).
The Control Host LLM acts only on Wake Triage judgment, quota pauses, cross-project
RAM contention, and operator playbooks in `monorepo-supervisor-ops`.

Run-state heartbeats alone are not proof of progress.
Only recycle `stuck`.
Inspect worker log tails under `.git/harness-control/<project>/logs/` when judging liveness.
When Run State is terminal, the next tick clears the worker row
(background workers leave no visible UI panes).

### Durable vs chat Control Host

| Role | Who | Cadence |
| --- | --- | --- |
| Process supervisor | `harness-control run` | Continuous, 0 LLM tokens |
| X-minute state check | `ops-remediate` + `wake-control-host` | Timer (default ~5m) |
| Judgment LLM | `--invoke-agent` (`HARNESS_WAKE_AGENT`) | Only when Wake Triage `shouldWake` |
| Cursor `/harness-supervisor` chat | Optional operator overlay | Manual / status questions |

Do **not** keep a chat `/loop` that polls `status`. Arm instead:

1. `harness-control run` (process tick — admission/recovery + GR evidence reopen)
2. `install-ops-cron.sh --repo "$REPO" --notify --invoke-agent` → `ops-remediate` +
   `wake-control-host.mjs` (acks fold/absorb; desktop-notifies; invokes judgment
   agent only when `shouldWake`; dedupes spam wake kinds)

**Before standing down from chat**, verify: supervisor live, ops timer has
`--invoke-agent`, latest `.git/harness-control/wake-control-host.jsonl` shows
recent brief/invoke, and briefs are not falsely “nearly done” while GR is owed.

Wake kinds include stuck workers, unrepaired empty-fleet / dead-runtime,
`input_required`, quota, `goal_defects`, **`goal_review_failed`**, and anomaly
events (`worker_never_started`, `worker_crash_loop`, `worker_spawn_failed`).

### Every supervisor Control Host turn (ordered)

1. `harness-control status` — read `fleetSnapshot`, `workerHealth`, `mergeLock`,
   capacity, pending inputs, and `wakeTriage`.
2. Scan recent Control Events for unrepaired `empty_fleet_actionable`,
   `dead_runtime`, anomaly wakes, and other wake kinds; fold/absorb progress the
   tick already repaired.
3. **Always** open the latest Evidence Artifact logs for any WI that finished or
   failed QA / INTEGRATION_QA / Goal Review since the last tick.
   Read the bottom JSON verdict + `defects`.
   Compare against status counters — if they disagree, the evidence log wins.
4. If INTEGRATION_QA defects contradict an earlier empty-defect `qa: true`
   (false green: SKIP_WEB_SERVER, host-only smoke, unrebuilt compose image),
   invalidate that QA mentally and `respond --action retry` with guidance that
   cites the evidence-log defects verbatim (see `monorepo-supervisor-ops`).
5. Every ~20 min print fleet progress to the user using evidence-backed facts,
   not status alone - **unless** there is no new activity:
   `status.wakeTriage.shouldWake === false` (or the events batch is only
   fold/absorb) **and** progress counters / `workers` are unchanged since the
   last fleet report, **or** `status` is already `complete`/`stopped` with a
   persisted `run_completed` / `fleetSnapshot.lastRunCompletedSummary`.
   In that idle/complete case: ack the folded/absorbed event IDs, skip user
   narration, **cancel** the 20-min `/loop` / `ScheduleWakeup`, and exit to
   closeout if complete. Do not keep waking just to say "still idle."
6. **RAM / sibling starvation check:** when `fleetSnapshot.emptyFleetActionable`
   and `capacity.memory.slots=0` while siblings hold heavy runtimes, free sibling
   capacity before the next progress narration (Hard rule 6).
   Re-admit the blocker, then let dependents resume.

If `fleetSnapshot.emptyFleetActionable` or health is `stuck`, act immediately on
judgment cases and harden this skill /
`monorepo-supervisor-ops` / harness code in the same turn — do not only narrate
(fail-closed). **Acting without updating the workflow is also incomplete**
(Hard rule 5: self-improvement).

Use manual `clear-dead-lock --force` only for remote locks or when the tick
cannot clear them. See `monorepo-supervisor-ops` for quota/RAM stalls and
multi-project `fleet-snapshot`.

Custom `retryQueue[context].guidance` wins over auto-retry generics.
Never auto-retry `coding agent failed three times` — needs operator or Repair Plan
guidance (verify-first when the AC is already satisfied).

When monorepo ACs share APIs/stubs (e.g. web depends on core), finish the root
project before dependents; pause/stop the dependent supervisor rather than thrashing.

When a dependent project's E2E fails on a **dependency API/contract** error
(not a UI-only bug), do not auto-retry coding on the dependent. Raise or keep
`input_required` with evidence, admit/repair work on the root project
(Orchestrator), then retry the dependent after the API is fixed.

**Orphan Docker / leftover resources:** finished Work Items must tear down what
they started (generator `RESOURCE_CLEANUP_RULE`).
Supervisor `kill-worker` / `workerClosed` / operator `stop` run
`cleanupWorktreeRuntime` → `stopWorktreeApp` (`./init.sh stop` when present,
else `.harness/app.pid`, plus worktree-scoped process and compose cleanup).
`kill-worker` targets the Run State owner process tree before falling back to the
nested agent child PID.
If `docker ps` still shows WI/AC leftovers while no live worker owns them, treat
that as a workflow defect: stop the orphans, then harden generator prompts/skills
the same turn (fail-closed) - do not only narrate.

For multi-supervisor monorepo ops (empty-fleet recovery, composer-2.5 ops host,
worker-log smoke checks), use the sibling `monorepo-supervisor-ops` skill.

## Worker monitoring

Workers always run in the background. Observe them through:

- `harness-control status` — `workerHealth`, `workers`, `fleetSnapshot`, capacity
- `harness-control fleet-snapshot` — monorepo-wide bearings in one call
- Worker logs under `.git/harness-control/<project>/logs/` and Evidence Artifacts
  under `.git/harness-evidence/`

**Unattended Input Requests:** each tick auto-writes `retry` for pending context-scoped
`input_required` events (worker exit, integration failure, claim-lease exhaustion,
**Observation Hard Gate** — no strong validation host for http/browser Work Items, etc.)
unless that context still has a live worker, is already in the retry queue, or hit the
crash bound (5). Goal-scoped inputs still need a human.

Workers close when Run State reaches a terminal status or when the orchestrator
heartbeat goes stale.
