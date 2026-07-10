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

Before starting the supervisor, use the sibling `generator` skill's scaffold and
reconciliation procedure so both `project_specs.xml` and a valid
`project_specs.xml` and `feature_list.json` exist on the integration branch (see `.harness/integration-branch`). Do not report a long-running goal as started
until this validation succeeds:

```bash
GENERATOR="$CONTROL/../generator"
[ -d "$GENERATOR" ] || GENERATOR="$CONTROL/../harness-generator"
node "$GENERATOR/reconcile.mjs" "$REPO" --check
```

## Start or recover

Always inspect first. The state is authoritative after chat compaction or a new
Supervisor session:

```bash
node "$CONTROL/scripts/harness-control.mjs" status --repo "$REPO"
node "$CONTROL/scripts/harness-control.mjs" start --repo "$REPO" --host "$WORKER_HOST"
```

`start` uses an atomic singleton lease and refuses a live local supervisor or a
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

Never infer completion from an empty queue or agent prose. Completion requires a
persisted `run_completed` event produced by mandatory Goal Review on the integrated plan branch.

## Worker health and fail-closed ops

`harness-control status` → `workerHealth` is the primary stuck signal
(`healthy` | `waiting_expected` | `stuck` | `done`).
Herdr `working` / run-state heartbeats alone are not proof of progress.
Never recycle `waiting_expected` merge_lock when the holder is alive, or MCP warmup
still under budget — only recycle `stuck`.
Close the whole herdr tab when `workerHealth=done` / Run State is terminal.

Every ~10 min read pane tails (`visible` when scroll=0); every ~20 min print fleet
status including `workerHealth` and `mergeLock`.
If the fleet is empty, finished tabs are still open, or health is `stuck`, act
immediately and harden this skill / `monorepo-supervisor-ops` / harness code in the
same turn — do not only narrate (fail-closed).

Custom `retryQueue[context].guidance` wins over auto-retry generics.
Never auto-retry `coding agent failed three times` — needs operator or Repair Plan
guidance (verify-first when the AC is already satisfied).

When monorepo ACs share APIs/stubs (e.g. web depends on core), finish the root
project before dependents; pause/stop the dependent supervisor rather than thrashing.

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

**Unattended Input Requests:** each tick auto-writes `retry` for pending context-scoped
`input_required` events (worker exit, integration failure, claim-lease exhaustion, etc.)
unless that context still has a live worker, is already in the retry queue, or hit the
crash bound (5). Goal-scoped inputs still need a human.

Workers close when Run State reaches a terminal status, when the pane exits, or when
the orchestrator heartbeat goes stale. Pass `--display background` to force background
workers even inside a herdr workspace.
Remote access uses herdr's SSH and plugin transports.
