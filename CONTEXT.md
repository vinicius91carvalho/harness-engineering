# Harness Workflow

The harness turns a **Project Goal** into independently checked work while keeping enough durable state for another session to continue safely.

## Bounded contexts

Four contexts matter.
Only the **workflow pipeline** is required to deliver software; the others are optional packaging or control surfaces.

| Context | What lives here | You interact through |
| --- | --- | --- |
| **Plugin marketplace** | `install.sh`, manifests, host configuration | Installer checklist |
| **Workflow pipeline** | `project_specs.xml`, `feature_list.json` (Work Item catalog), Execution Ledger, `orchestrator.mjs`, `workflow/attempt-machine.mjs`, `lib/claim-lease.mjs` (CLI: `claim.sh` / `claim.ps1`), Goal Review policy | Skills below + files in your repo |
| **Supervisor control** | `harness-control.mjs`, Resource Governor, Control Journal (Control Events + Input Requests) | `/harness:supervisor` |
| **Optional routing** | `.harness/roles.json`, MCP servers | `config/roles.example.json` |

**Skills** (under `skills/`) are what **you** type in chat — planner, setup, generator, supervisor, evaluator.
They prepare specs, start runs, or relay progress.
They do not replace the orchestrator.

**Agents** (under `agents/`) are what the **orchestrator** spawns per phase — coding-agent, qa-agent, initializer.
You do not invoke them directly; the state machine selects them from `roles.json` or the active host.

```mermaid
flowchart LR
  subgraph User["User conversation — Skills"]
    P[planner]
    S[setup]
    G[generator]
    SV[supervisor]
  end
  subgraph Engine["Execution engine — deterministic"]
    HC[harness-control]
    OR[orchestrator]
  end
  subgraph Workers["LLM workers — Agents"]
    C[coding-agent]
    Q[qa-agent]
    I[initializer]
  end
  P -->|writes spec| SPEC[(project_specs.xml)]
  S -->|maps repo| SPEC
  G --> OR
  SV --> HC --> OR
  OR --> C
  OR --> Q
  G -.->|scaffold once| I
```

### Generator modules (deterministic, no LLM)

Orchestrator owns host adapters and Goal Review; the Attempt loop and shared policy live in libraries so supervisor and orchestrator stay aligned without duplicating execution rules.

```mermaid
flowchart TD
  orchestrator[orchestrator.mjs] --> attempt[attempt-machine.mjs]
  orchestrator --> workflowState[workflow-state.mjs]
  orchestrator --> routePlan[route-plan.mjs]
  orchestrator --> claimLease[claim-lease.mjs]
  harnessControl[harness-control.mjs] --> workerLifecycle[worker-lifecycle.mjs]
  harnessControl --> supervisorTick[supervisor-tick.mjs]
  harnessControl --> supervisorAdmission[supervisor-admission.mjs]
  harnessControl --> claimLease
```

## Language

**Project Goal**:
The observable outcome defined by `project_specs.xml` that the workflow must deliver.
_Avoid_: Task list, feature flags

**Acceptance Check**:
A stable, traceable statement of observable behavior that proves part of the Project Goal.
_Avoid_: Feature, test case, task

**Work Item**:
An executable unit derived from one or more Acceptance Checks and listed in the immutable `feature_list.json` catalog.
_Avoid_: Acceptance Check, Project Goal

**Execution Ledger**:
The durable, machine-owned record of mutable Work Item progress (implementation, QA, integration, Attempt, Blocking Scope) separate from the Work Item catalog.
_Avoid_: feature_list flags, chat status

**Control Journal**:
The append-only, ordered record of Supervisor transitions, Control Events, and Input Request lineage from which current supervisor status is derived.
_Avoid_: state.json alone, transcript

**Completion Contract**:
The Project Goal is complete only when every Acceptance Check passes on the integrated plan branch and Goal Review confirms the whole spec - not when chat goes quiet or queue flags flip to true.
_Avoid_: All flags are true

**Grilling**:
The planner's one-question-at-a-time interview about ambiguous requirements, architectural trade-offs, and edge cases so "done" is predictable before coding starts.
_Avoid_: Optional brainstorm, free-form chat

**Ready Gate**:
The checklist grilling must pass before the blocking localhost spec review opens or `project_specs.xml` is finalized: no open ambiguities, recorded trade-offs, and in-scope edge cases mapped to Acceptance Check IDs, then the user must submit the review.
_Avoid_: User said "looks good", planner gut feel

**Planning Decision**:
One grilled answer (for example soft-delete vs hard-delete) written under `<planning_decisions>` in `project_specs.xml` and linked to the Acceptance Checks that prove it.
_Avoid_: Chat note, implicit assumption

**Defect Report**:
A QA handoff describing observed behavior, expected behavior, reproduction evidence, and the affected Acceptance Checks.
_Avoid_: QA response, failure message

**Repair Plan**:
The orchestrator's persisted diagnosis and bounded instructions for the next coding run after a Defect Report.
_Avoid_: Retry prompt, QA notes

**Attempt**:
One coding, isolated-QA, and—when reached—Integrated Verification cycle for a Work Item.
_Avoid_: Agent invocation, tool retry

**Blocked Work Item**:
A Work Item that has failed QA after three Attempts and requires user direction, with its Defect Reports, Repair Plans, and current state preserved.
_Avoid_: Failed task, abandoned task

**Run State**:
The atomically updated machine-readable snapshot of one active context, including ownership, liveness, phase, Attempt, last result, and next action.
_Avoid_: Log, progress notes, status file

**Workflow Journal**:
The concise, human-readable history of meaningful workflow transitions and handoffs for one context.
_Avoid_: Transcript, raw agent output, status file

**Evidence Artifact**:
A separately stored, immutable screenshot, HTTP result, command output, or runtime log referenced by a Workflow Journal entry or Defect Report.
_Avoid_: Journal entry, conversation log

**Claim Lease**:
Exclusive ownership of a context, proven by an owner identity and liveness data in its Run State.
_Avoid_: Lock file, task assignment

**Resume**:
Atomic acquisition of an abandoned Claim Lease followed by continuation from the Run State's recorded next action in the existing worktree.
_Avoid_: Restart, rerun

**Checkpoint**:
A Work Item whose isolated QA has passed and whose committed changes are ready for integration with the latest plan integration branch.
_Avoid_: Context completion, QA pass

**Integrated Verification**:
Black-box execution of a Checkpoint's mapped Acceptance Checks after its changes are combined with the latest integration branch (never `main` while a plan is in flight).
_Avoid_: Branch QA, merge check

**Goal Review**:
The mandatory independent, system-level verification of the Project Goal on the integrated plan branch after the work queue is empty.
_Avoid_: Evaluator sweep, final QA, queue completion

**Plan integration branch**:
The long-lived Git branch that owns a Project Goal's integrated queue and merges (for example `plan/opensource-docker`).
Side Work Items branch from it as `gen/*` and merge back into it only.
Pin it in `.harness/integration-branch` at the repo root.
_Avoid_: main, master, feature branch

**Dependency Graph**:
The acyclic relationships between Acceptance Checks that determine when their Work Items are eligible to run.
_Avoid_: Foundation phase, execution order

**Ready Work Item**:
A queued Work Item whose mapped Acceptance Check dependencies have all passed Integrated Verification.
_Avoid_: Pending task, next feature

**Skill**:
A user-invoked harness command (`/harness:planner`, `/harness:generator`, …) defined under `skills/<name>/SKILL.md`.
_Avoid_: Agent, plugin command, slash command for workers

**Agent**:
An orchestrator-spawned executor with a fixed JSON contract (`agents/coding-agent.md`, `agents/qa-agent.md`, `agents/initializer.md`).
_Avoid_: Skill, subagent, chat session

**Initializer**:
The scaffold-only agent that maps stable Acceptance Checks into `feature_list.json`, creates a PORT-parameterized `init.sh` and project structure, and makes the first commit on `main`. Idempotent; never implements Work Items.
_Avoid_: Code Agent, generator skill

**Supervisor**:
The single long-lived control loop per project (`harness-control.mjs`) that admits workers, relays Control Events, and escalates Input Requests without owning execution policy.
_Avoid_: worker, scheduler, generator skill

**Orchestrator**:
The deterministic entry point (`orchestrator.mjs`, no LLM) that delegates the Attempt loop to `attempt-machine.mjs`, runs Goal Review, and owns host adapters plus `roles.json` routing and Demotion.
_Avoid_: Supervisor, LLM planner

**Input Request**:
A durable, uniquely identified request for user direction that records why work cannot proceed, permitted actions, and supporting evidence.
_Avoid_: Alert, log message, chat question

**Resource Governor**:
The deterministic admission policy that limits new workers to the minimum capacity allowed by configured concurrency, CPU, free memory, current load, and provider quota state.
It is host-wide and provider-aware across repositories; every admission path must obtain a grant.
_Avoid_: Agent judgment, scheduler prompt, worker pool

**Supervisor Lease**:
Atomic singleton ownership of one repository's Resource Governor participation, stored in its shared Git directory and refreshed by heartbeat.
_Avoid_: Context Claim Lease, PID file, chat session

**Control Event**:
A durable, ordered machine-readable record of a meaningful supervisor transition that a Supervisor can relay or summarize.
_Avoid_: Transcript, console output, notification

**Blocking Scope**:
The smallest execution boundary stopped by a failure: one context by default, or the entire Project Goal only when shared safety, specification, or infrastructure prevents useful independent work.
_Avoid_: Global pause, failed task

**Verify-First Mode**:
A spec mode (`<mode>existing-codebase</mode>`) where coding agents first exercise the Acceptance Checks against existing code at a real external boundary, set `implementation=true` with no code changes when they pass, and only repair the root cause with the smallest possible diff when a check fails. QA and Integrated Verification still independently re-run the checks. Turns `/generator` into a safe audit pass over a working codebase rather than a rewrite.
_Avoid_: Audit mode, verify-only mode, read-only generator

**Observation Method**:
How an Acceptance Check (or its Work Item) must be exercised at a real external boundary: `grep`, `cli`, `http`, or `browser`, projected into the Work Item catalog.
_Avoid_: test type, QA mode, verification strategy

**Observation Hard Gate**:
The spawn-time rule that validation (and Goal Review) host selection must match the Work Item's Observation Methods; if no eligible strong host remains, the Supervisor raises a durable Input Request instead of admitting a weak host or waiting silently.
Coding soft-aligns its prompt to those methods but does not hard-exclude hosts.
_Avoid_: soft reorder, pre-suite phase, host preference hint

**Wake Triage**:
A zero-token classifier over Control Journal deltas that absorbs or folds benign progress and wakes the Control Host LLM only for actionable events (Input Requests, stuck workers, fail-closed gaps).
_Avoid_: peer agent bus, supervisor tick replacement, event-driven coding↔QA channel

**Evidence Corpus**:
A read-only index over create-only Evidence Artifacts used by the learning loop to cluster recurring defects and propose workflow-skill patches with operator approval.
_Avoid_: pane stream mining, auto-applied skill edits, mutable evidence rewrite

**Control-host Beacon**:
The stop policy that blocks blind Control Host exit while workers are live or required journal consumers are behind, with a turn-end backstop that drains finalizers before lease release.
_Avoid_: second supervisor, auto-ack to unblock stop, lease fence

**Fleet Snapshot**:
A structured cross-project bearings contract (journal tips, capacity, stuck, pending inputs) that fleet-ops recovery and monorepo ops consume instead of reparsing raw control files.
Built by `skills/generator/lib/fleet-snapshot.mjs` (`harness-fleet-snapshot.v1`); exposed via `harness-control status` (`fleetSnapshot`) and `harness-control fleet-snapshot`.
_Avoid_: monorepo skill dump into harness-control, ad-hoc sibling state scrapes

**User**:
The human who sets up the harness, requests features or refactors, answers escalations, and reads relayed progress.
_Avoid_: operator, client

**Code Agent**:
The coding executor (`agents/coding-agent.md`) selected by `roles.json` `coding` routing, responsible for implementing one Work Item.
_Avoid_: QA Agent, generator skill

**QA Agent**:
The validation executor (`agents/qa-agent.md`) selected by `roles.json` `validation` routing and run independently of the Code Agent, so the reviewer is never the coder.
_Avoid_: Code Agent, self-review

**Strike Count**:
A per-project-run integer that increases by one on a qualifying failure (infrastructure or quality) and decreases by one on a clean success, with a floor of zero. Infrastructure strikes keyed by `(harness, model)` apply globally across roles; quality strikes keyed by `(role, harness, model)` stay local.
_Avoid_: retry counter, error log

**Demotion**:
Sorting a struck candidate to the back of its role list at selection time.
_Avoid_: ban, removal

**Repair Budget**:
The number of QA rejections allowed on one Work Item before switching to the next coder; set by `HARNESS_REPAIR_BUDGET`, default 2.
_Avoid_: Attempt limit, retry cap

**noCredits tier**:
An optional free fallback list in `roles.json`, reached only when paid candidates are exhausted by infrastructure or credit errors.
_Avoid_: free tier default, primary route
