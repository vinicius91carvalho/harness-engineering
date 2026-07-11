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
   counters (`implemented/qa/integrated`), `workerHealth`, herdr `working`,
   pane chatter, and bare process `exitCode` are liveness/scheduling signals
   only. They can show green while the evidence log records defects (or a
   false `qa: true` with empty defects that INTEGRATION_QA later contradicts).
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
   `monorepo-supervisor-ops` empty-fleet §6.

Let `REPO` be the selected harness project directory (which may be below the Git
top-level), `CONTROL` this skill directory, and
`WORKER_HOST` one authenticated CLI installed on the machine: `claude`, `codex`,
`opencode`, or `agent`. Role routing is selected by project-local `.harness/roles.json`.
Herdr visibility is automatic when running inside a herdr workspace
(`HERDR_ENV=1`) and the `herdr` CLI is installed; pass `--display background` to
force background workers, or `--display herdr` to force herdr when available.
Each admitted worker gets its own dedicated herdr **tab** (one pane per tab),
named `{taskId} - {role} - {project} - r{retry}` (e.g. `WI-AC-025 - qa -
public-docs - r1`). The tab renames when the orchestrator phase changes and
closes when the worker finishes, so it appears clearly in the herdr sidebar.

At a monorepo root, resolve one project through `.harness/projects.json` before
starting. Each project has its own specification, Work Item catalog, Execution Ledger,
supervisor Control Journal, and Goal Review. Do not start one aggregate supervisor
for multiple project queues.

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
2. Prunes dead Resource Governor reservations
3. Clears dead Claim Lease entries only when claim session **and** run-state
   owner/child PIDs are dead (never under a live herdr orchestrator; does not
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

Create one durable consumer name per delivery channel, such as
`herdr-notify` or `phone`. Poll at least once per minute through the Supervisor's native
heartbeat/cron mechanism:

```bash
node "$CONTROL/scripts/harness-control.mjs" events --repo "$REPO" --consumer herdr-notify
```

For each returned event:

- **Wake Triage** (`skills/generator/lib/wake-triage.mjs`): each `events` row
  includes `wakeTriage: { action, reason }` (`absorb` | `fold` | `wake`).
  `input_required` and goal-scoped inputs always wake; healthy progress folds;
  empty-fleet progress with remaining work stays actionable. Use `status.wakeTriage`
  for a batch hint without parsing the full journal.
- Deliver `immediate:true` events immediately. An `input_required` message must
  include its event ID, scope/context, reason, evidence, and permitted choices.
- Deliver `progress` as the `--summary-minutes` status update (default 20). It
  already contains queue, worker, blocked, and capacity counts.
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
consult `skills/generator/lib/control-beacon.mjs` before soft stop.
Soft stop is denied while workers are live, required journal consumers (default
`herdr-notify`) are behind the journal tip, or an `input_required` is unacked.
After a bounded wait (~60s) surface an Input Request instead of forcing exit.
`kill-supervisor` and `--force` fleet recovery remain authorized force paths
(ADR-0016). Turn-end shutdown always plans `{ waitForFinalizers: true }` before
lease release.

Never infer completion from an empty queue or agent prose. Completion requires a
persisted `run_completed` event produced by mandatory Goal Review on the integrated plan branch.

## Worker health and fail-closed ops

`harness-control status` → `workerHealth` is the primary **stuck** signal
(`healthy` | `waiting_expected` | `stuck` | `done`).
It is **not** the pass/fail signal for Work Items — see Hard rules above.

Herdr `working` / run-state heartbeats alone are not proof of progress.
Never recycle `waiting_expected` merge_lock when the holder is alive, or MCP warmup
still under budget — only recycle `stuck`.
Close the whole herdr tab when `workerHealth=done` / Run State is terminal.

### Every supervisor tick / 10-min check (ordered)

1. `harness-control status` for liveness, capacity, pending inputs, `workerHealth`,
   `mergeLock`.
2. Read herdr pane tails (`visible` when scroll=0) for stuck vs healthy activity.
3. **Always** open the latest Evidence Artifact logs for any WI that finished or
   failed QA / INTEGRATION_QA / Goal Review since the last tick. Read the bottom
   JSON verdict + `defects`. Compare against status counters — if they disagree,
   the evidence log wins.
4. If INTEGRATION_QA defects contradict an earlier empty-defect `qa: true`
   (false green: SKIP_WEB_SERVER, host-only smoke, unrebuilt compose image),
   invalidate that QA mentally and `respond --action retry` with guidance that
   cites the evidence-log defects verbatim (see `monorepo-supervisor-ops`).
5. Every ~20 min print fleet progress to the user using evidence-backed facts,
   not status alone.
6. **RAM / sibling starvation check:** if this project has remaining work,
   `workers={}` (or a resumable Run State with dead PIDs), and
   `capacity.memory.slots=0` while `ps` shows sibling `next-server` / heavy
   worktree runtimes, free sibling capacity before the next progress narration
   (Hard rule 6). Re-admit the blocker, then let dependents resume.

If the fleet is empty, finished tabs are still open, or health is `stuck`, act
immediately and harden this skill / `monorepo-supervisor-ops` / harness code in the
same turn — do not only narrate (fail-closed). **Acting without updating the
workflow is also incomplete** (Hard rule 5: self-improvement).

**Empty-fleet auto-recovery (tick-owned):** each supervisor tick clears dead
same-host merge/state locks (`stale_lock_cleared`). When the fleet is empty after
a clear, it resets crash-bound counts so auto-retry can run again. Ghost run-state
PIDs outside `workers` are not treated as a successful retry (orphan SIGTERM +
defer) - that used to drop `retryQueue` and leave free capacity unused. Use
manual `clear-dead-lock --force` only for remote locks or when the tick cannot
clear them. See `monorepo-supervisor-ops` for quota/RAM stalls.

**Never treat "contexts finished / foundation idle" as healthy** when
`workers={}`, remaining Work Items (or pending `input_required`) remain, and the
run is not `complete`/`stopped`. That is empty-fleet failure: respond pending
inputs, clear orphan worktree dirs / locks, free sibling governor/RAM capacity,
and admit the next context the same turn. Do not only narrate idle.

Custom `retryQueue[context].guidance` wins over auto-retry generics.
Never auto-retry `coding agent failed three times` — needs operator or Repair Plan
guidance (verify-first when the AC is already satisfied).

When monorepo ACs share APIs/stubs (e.g. web depends on core), finish the root
project before dependents; pause/stop the dependent supervisor rather than thrashing.

When a dependent project's E2E fails on a **dependency API/contract** error
(not a UI-only bug), do not auto-retry coding on the dependent. Raise or keep
`input_required` with evidence, admit/repair work on the root project
(Orchestrator), then retry the dependent after the API is fixed.

**Orphan Docker / leftover resources:** finished Work Items must tear down the
compose stacks, named containers, and worktree servers they started (see
generator `RESOURCE_CLEANUP_RULE`).
Supervisor teardown is no longer browser-only: `kill-worker`, `workerClosed`,
and operator `harness-control stop` also run `cleanupWorktreeRuntime`
(`.harness/app.pid` tree, worktree-scoped `next`/`tsx`/`esbuild`, and
`docker compose down --remove-orphans`).
If `docker ps` still shows WI/AC leftovers (`wi-ac-*`, `ac0*`, completed
subproject stacks) while no live worker owns them, treat that as a workflow
defect: stop the orphans, then harden generator prompts/skills the same turn
(fail-closed) — do not only narrate.

For multi-supervisor monorepo ops (empty-fleet recovery, composer-2.5 ops host,
stream smoke checks), use the sibling `monorepo-supervisor-ops` skill.

## Herdr workflow (optional)

Herdr is not required. When you run inside a herdr workspace (`HERDR_ENV=1`) and
the `herdr` CLI is installed, workers automatically get visible panes; otherwise
they run in the background. Force one mode explicitly with `--display herdr` or
`--display background`. Each admitted worker gets its own dedicated tab, labeled
`{taskId} - {role} - {project} - r{retry}`, with agent name
`worker-<project>-<context>`.

```bash
node "$CONTROL/scripts/harness-control.mjs" start --repo "$REPO" --host "$WORKER_HOST" --display herdr
```

Use `herdr agent list`, `herdr pane read`, and `herdr wait agent-status` from the
supervisor pane to observe workers. Each pane streams the live agent session
(thinking, tool calls, verdicts) via a flushed PTY — not only orchestrator phase
lines. Harness reports `working` while the orchestrator runs; herdr `blocked` or
an interactive prompt raises `input_required`. Herdr `idle` and merge-lock waits
are normal between turns and do not stop workers. Herdr panes no longer flood with
`BUSY` lines — the orchestrator prints a short status line at most every 10s while
waiting.

**Monorepo (multiple supervisors):** every subproject runs its own supervisor with
one named tab per worker. Tab/pane cleanup is scoped to `worker-<project>-*`
agents only — a core supervisor must never close `worker-web-*` / `worker-relay-*`
tabs (doing so leaves zombie workers: state lists pane IDs herdr no longer has).
Finished workers close their **tab** immediately when Run State is terminal
(`complete` / `blocked` / `failed`), the orchestrator/child exits, or the shell
is idle after the job — finished agents must not linger.
Each supervisor tick also runs the rate-limited finished-tab reaper (`finished-tab-reaper.mjs`), and `workerClosed` / `workerHealth=done` force an immediate reap via `closeStaleHarnessPanesForProject` (live worker pane ids are always kept).

**Unattended Input Requests:** each tick auto-writes `retry` for pending context-scoped
`input_required` events (worker exit, integration failure, claim-lease exhaustion,
**Observation Hard Gate** — no strong validation host for http/browser Work Items, etc.)
unless that context still has a live worker, is already in the retry queue, or hit the
crash bound (5). Goal-scoped inputs still need a human.

Workers close when Run State reaches a terminal status, when the pane exits, or when
the orchestrator heartbeat goes stale. Pass `--display background` to force background
workers even inside a herdr workspace.
Remote access uses herdr's SSH and plugin transports.
