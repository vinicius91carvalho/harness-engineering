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
`opencode`, or `agent`. An external control surface is not a `WORKER_HOST`; Omnigent role
routing is selected by project-local `.harness/roles.json` instead.

At a monorepo root, resolve one project through `.harness/projects.json` before
starting. Each project has its own specification, queue, supervisor state, and
Goal Review. Do not start one aggregate supervisor for multiple project queues.

## Prepare the goal

Read `CONTEXT.md`, relevant `docs/adr/`, and existing durable harness state before
acting. If the user's `/goal` is not yet represented by `project_specs.xml`, use
the sibling `planner` skill to create it. Make reversible defaults autonomously;
ask only when a material product, safety, credential, or destructive choice has
no safe default.

Before starting the supervisor, use the sibling `generator` skill's scaffold and
reconciliation procedure so both `project_specs.xml` and a valid
`feature_list.json` exist on `main`. Do not report a long-running goal as started
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
  --summary-minutes 15
node "$CONTROL/scripts/harness-control.mjs" quota --repo "$REPO" --workers 1
node "$CONTROL/scripts/harness-control.mjs" capacity --repo "$REPO" --host "$WORKER_HOST"
```

Do not increase limits merely because the user requested speed. Increase them
only from observed available resources and a known concurrent provider quota.

## Relay notifications

Create one durable consumer name per delivery channel, such as
`omnigent-mobile`. Poll at least once per minute through the Supervisor's native
heartbeat/cron mechanism:

```bash
node "$CONTROL/scripts/harness-control.mjs" events --repo "$REPO" --consumer omnigent-mobile
```

For each returned event:

- Deliver `immediate:true` events immediately. An `input_required` message must
  include its event ID, scope/context, reason, evidence, and permitted choices.
- Deliver `progress` as the `--summary-minutes` status update (default 15). It
  already contains queue, worker, blocked, and capacity counts.
- `run_completed` is the only completion notification.
- Other events may be folded into the next progress message.

After successful delivery or intentional folding, acknowledge the highest
processed ID. Never acknowledge before delivery:

```bash
node "$CONTROL/scripts/harness-control.mjs" ack --repo "$REPO" \
  --consumer omnigent-mobile --event "$EVENT_ID"
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
persisted `run_completed` event produced by mandatory Goal Review on integrated
`main`.
