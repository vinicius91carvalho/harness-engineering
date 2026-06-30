<p align="center">
  <img src="assets/banner.svg" alt="harness-engineering" width="660">
</p>

<p align="center">
  <a href="https://github.com/vinicius91carvalho/harness-engineering/releases/latest"><img alt="Version" src="https://img.shields.io/github/v/release/vinicius91carvalho/harness-engineering?sort=semver&label=version&color=2496ED"></a>
  <a href="https://github.com/vinicius91carvalho/harness-engineering"><img alt="AI Harness Engineering System" src="https://img.shields.io/badge/AI%20Harness%20Engineering-System-8A2BE2"></a>
  <a href="https://github.com/vinicius91carvalho/harness-engineering/releases"><img alt="Last update" src="https://img.shields.io/github/release-date/vinicius91carvalho/harness-engineering?label=last%20update&color=2EA44F"></a>
</p>

<p align="center">
  <b>A curated developer workflow for any AI harness.</b>
</p>

> *"YOU SHOULD NOT PASS!"* — on the bad plugins, the boilerplate, and the 3am pages.
>
> *"A wizard is never late, nor is he early — he installs precisely the plugins he means to."*
>
> *"All we have to decide is what to do with the config that is given us."*

## About

> *"Not all those who wander are lost."*

`harness-engineering` is a portable workflow and plugin catalog for **Claude Code**, **OpenCode**, and **Codex**. It combines a spec→build→QA pipeline with compatible integrations such as Ponytail and optional local codebase memory.

It's opinionated but not precious: **feedback, tips, and plugin suggestions are very welcome** — open an [issue](https://github.com/vinicius91carvalho/harness-engineering/issues) or a PR.

### Website and learning guide

The project website teaches the complete workflow in plain language, including
Mermaid diagrams, generated file formats, recovery, customization, and known
limitations: **[vinicius91carvalho.github.io/harness-engineering](https://vinicius91carvalho.github.io/harness-engineering/)**.

It is a build-free static site under `site/`; Mermaid is loaded as one pinned
browser module. Preview it locally with:

```sh
cd site && python3 -m http.server 8000
```

`.github/workflows/pages.yml` uploads that directory through GitHub's native Pages
actions on pushes to `main`. In the repository's **Settings → Pages**, select
**GitHub Actions** as the publishing source once; no build command is required.

# Why does this project exists?

1) Long-running work loses coherence as context fills.
2) Host and model choices should remain user-controlled rather than pinned by the plugin.
3) From "Harness design for long-running application development" by Prithvi Rajasekaran on Anthropic Labs [1]
> "First is that models tend to lose coherence on lengthy tasks as the context window fills."
> "When asked to evaluate work they've produced, agents tend to respond by confidently praising the work—even when, to a human observer, the quality is obviously mediocre."
> "agents still sometimes exhibit poor judgment that impedes their performance while completing the task."

## Setup

> *"When in doubt, always follow your nose."*

On a new machine with any of the supported CLIs installed ([Claude Code](https://claude.com/claude-code), [Opencode](https://opencode.ai), or [Codex](https://github.com/openai/codex)), run:

**macOS / Linux / Windows (Git Bash or WSL)**

```sh
curl -sSL https://raw.githubusercontent.com/vinicius91carvalho/harness-engineering/main/install.sh | sh
```

The installer detects available CLIs. With more than one host, choose with numbers,
arrow keys, or Enter; non-interactive runs must pass `--cli`. Then pick what to
install from a single Space-to-toggle checklist (`a` selects or clears all, Enter
confirms) instead of one prompt per plugin. `--yes` and `--no` control checklist
contents, while `--cli` controls target hosts. Integrations are offered only on
documented hosts, and repeated runs are idempotent. The MCP inventory applies to
Claude, Codex, and OpenCode, resolving secrets before writing host configs.
OpenCode is also detected in
its official `~/.opencode/bin` install location before a shell restart updates
`PATH`. MCP secret prompts mask typed and pasted API keys.

For **native Windows**, run [`install.ps1`](install.ps1). It stages the repository
when invoked through a pipe, so it does not depend on `$PSScriptRoot`.

See [Installer behavior](docs/installer/README.md) for `--cli`, `--yes`, `--no`,
strict dry-run behavior, and Claude-only scope flags.

## Framework

> *"It's the job that's never started as takes longest to finish."*

The `harness` plugin bundles a resumable **Spec → Build → QA → Goal Review** pipeline. It turns a short idea into a Project Goal with stable Acceptance Checks, derives an execution queue, and loops until those checks pass on integrated `main`. Build sessions can run **in parallel**, each isolated in its own git worktree. Inspired by Anthropic's [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) and [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps).

### Components

| Invoke | Type | Role |
| --- | --- | --- |
| `/harness:planner` | skill | Defines the Project Goal and stable, dependency-aware Acceptance Checks in `project_specs.xml`. |
| `/harness:generator` | skill | Resumes or claims Ready Work Items and drives coding→QA→integration through one portable state machine. |
| `/harness:evaluator` | skill | Runs the mandatory independent Goal Review against integrated `main`. |
| `/harness:control-host` | skill | Connects a long-lived Hermes, nanobot, pi, or similar agent to the durable supervisor and notification interface. |
| `initializer` | agent | Scaffolds the project once and maps Acceptance Checks into `feature_list.json`. |
| `coding-agent` | agent | Implements one Work Item, including a supplied Repair Plan on retry. |
| `qa-agent` | agent | Performs isolated QA and Integrated Verification through a real browser or HTTP boundary. |

### Flow

```
/harness:planner ─► Project Goal + stable Acceptance Checks ─► human review
        │
        ▼
/harness:generator   (new session, ×N in parallel)
  ├─ reconcile every Acceptance Check into a dependency-aware Work Item
  ├─ Resume abandoned Run State, otherwise claim a Ready Work Item
  └─ coding → isolated QA → Checkpoint → merge → Integrated Verification
          ▲         │ defect
          └─ Repair Plan ◄─ Defect Report       (maximum three Attempts)
        │
        ▼
mandatory Goal Review on integrated main
        ├─ in-scope defect → reopen linked Work Item
        └─ goal:true       → Project Goal complete
```

`project_specs.xml` is the completion authority. The planner gives each observable Acceptance Check a stable ID and optional prerequisite IDs. `feature_list.json` is an append-only execution queue whose Work Items map back to those IDs and carry `implementation`, `qa`, and `integration` state. Reconciliation blocks missing mappings, unknown dependencies, and dependency cycles.

Each context has two durable views. Atomic Run State under
`.git/harness-runs/<context>.json` records ownership, heartbeat, child process,
phase, Attempt, last result, and next action. The tracked
`harness-progress/<context>.md` Workflow Journal records only concise transitions,
Defect Reports, Repair Plans, evidence paths, and next actions—not conversations
or raw logs.

### How the orchestrator works

`orchestrator.mjs` is the execution state machine, not the scheduler.
`/harness:generator` and `claim.sh` first select dependency-ready work and acquire
the context's Claim Lease, worktree, branch, and port. They then invoke the same
runner for every host:

```sh
node "<generator-skill-directory>/orchestrator.mjs" \
  --host codex \
  --repo /path/to/project \
  --workdir /path/to/project-wt-core \
  --context core \
  --port 5170 \
  --features WI-AC-001,WI-AC-002 \
  --claim-script "<generator-skill-directory>/claim.sh"
```

The host adapter changes only how an agent starts (`claude -p`, `codex exec`, or
`opencode run`). The state machine and prompts are shared, and no model argument is
passed, so the host's configured model remains authoritative.

For each invocation, the orchestrator:

1. Runs `reconcile.mjs --check` so every Work Item maps to valid Acceptance Checks
   and the dependency graph is still valid.
2. Reads the context's Run State. A fresh claim starts normally; interrupted work
   resumes from `nextAction`; blocked work requires explicit `--guidance` and starts
   a new bounded Attempt cycle.
3. Takes ownership with a unique lease token, records its PID, and refreshes a
   heartbeat every 15 seconds. Each child-agent PID, app PID, phase, Attempt,
   evidence path, result, and next action is written atomically.
4. Processes the claimed Work Items sequentially. Different contexts may run this
   same loop concurrently in separate worktrees.

One Work Item moves through these states:

| Phase | Agent/action | Durable proof |
| --- | --- | --- |
| Coding | `coding-agent` implements and black-box checks the Work Item | `implementation:true` plus a commit |
| Isolated QA | `qa-agent` tests the worktree independently | `qa:true` plus evidence |
| Checkpoint | Orchestrator commits its Journal transition and acquires the serialized merge lock | Checkpoint commit merged into latest `main` |
| Integrated Verification | `qa-agent` reruns mapped checks and core smoke behavior on integrated `main` | `integration:true` plus evidence |
| Complete | Orchestrator syncs integrated `main` back into the context worktree | Run State points to the next Work Item or claim release |

The three flags deliberately mean different things. `implementation:true` says the
coding agent finished, `qa:true` says the isolated worktree passed independent QA,
and `integration:true` says the Acceptance Checks still pass after merging with the
latest `main`. Only the last state satisfies dependencies and makes downstream work
ready.

#### Defect and repair loop

Any isolated or integrated QA defect follows the same communication path:

```text
QA verdict
  → structured Defect Report (expected, observed, reproduction, evidence)
  → orchestrator repair-planning call
  → persisted Repair Plan (root cause, bounded actions, validation)
  → next coding-agent prompt
```

The Defect Report and Repair Plan are written to Run State and summarized in the
Workflow Journal before coding runs again. Raw conversations are not appended;
bounded diagnostic output lives separately under `.git/harness-runs/evidence/`.
An Attempt is one coding→QA→integration cycle. After Attempt 3, or after three
operational failures in one phase, the Work Item becomes blocked. The orchestrator
stops its app process, releases active execution ownership, and preserves the
branch, worktree, queue state, defects, plans, Journal, and evidence for inspection.

#### Interruption and Resume

If the process receives an interrupt, it terminates the active child and records
`status:interrupted` with the current phase and next action. If it is killed without
that cleanup, the heartbeat and PIDs still let the next session distinguish live
work from abandoned work. Local work resumes automatically only when both owner and
child are provably dead. Stale cross-host work requires explicit takeover. A blocked
Resume also requires a concise user guidance summary, which is journaled before a
new three-Attempt cycle begins.

#### Goal Review

After every Work Item has `integration:true`, the same runner enters
`goal-review` mode. It locks `main`, requires a clean checkout, and asks an
independent agent to exercise the Project Goal, every Acceptance Check, and primary
cross-feature journeys without trusting queue flags. A pass records `goal:true`. A
concrete in-scope defect reopens the linked Work Items; an unknown mapping,
unauthorized checkout change, ambiguity, or exhausted Attempt budget blocks for
user guidance. Queue exhaustion alone never declares the project complete.

### Running contexts in parallel

Contexts remain collision boundaries, while the Acceptance Check dependency graph
controls readiness. This allows unrelated work to proceed without pretending every
foundation task blocks the whole project. Work Items are checkpointed individually,
so a late blocked item does not strand earlier verified work in its context.

Use this sequence:

1. In the project root, start one host session and run `/harness:generator`.
   Let it finish initialization and reconciliation before adding workers. This
   creates Git, `feature_list.json`, the initial Run State, and the dependency graph
   that every session will share.
2. Open one additional terminal/session per context you expect to be ready. Every
   session starts from the same project root—not from a generated worktree—and runs
   `/harness:generator` independently.
3. Choose **All** in each session for automatic distribution. `claim.sh` atomically
   assigns the next Ready context, so two sessions cannot receive the same context.
   Choose **A set** only when you deliberately want to pin a session to a named
   context.
4. Leave each session running. The harness creates and uses its own
   `gen/<context>` branch, sibling worktree, and unique port; do not create or switch
   those manually.
5. Use the status command from any terminal to monitor ownership, phase, Attempt,
   child/app PIDs, heartbeat, next action, port, and worktree.

For example, if `foundation`, `accounts`, and `reporting` are all Ready, three
sessions can claim them concurrently:

```text
project root ─┬─ session A: /harness:generator → foundation → project-wt-foundation
              ├─ session B: /harness:generator → accounts   → project-wt-accounts
              └─ session C: /harness:generator → reporting  → project-wt-reporting
```

Coding and isolated QA run concurrently. Checkpoint merges and Integrated
Verification are serialized by the merge lock, so every session verifies against a
stable latest `main`; waiting there is expected. After integration, the session
continues with its next claimed Work Item or releases the completed context.

The useful worker count is the number of Ready contexts, not the number of Work
Items. Extra sessions find no claim and stop. Do not use **1 task** to parallelize
Work Items from the same context: even a task selection leases the entire context
because those items are expected to touch the same files.

Each Claim Lease receives its own `gen/<context>` branch, worktree, port, owner,
child PID, and heartbeat. A new session refuses live local work, resumes immediately
when local owner and child processes are provably dead, and requires explicit
takeover for stale cross-host work. After Attempt 3, blocked work preserves its
branch, worktree, state, journal, defects, plans, and evidence until explicit Resume.
An explicit blocked Resume records the user's guidance and starts a new three-Attempt cycle.
Inspect active work with:

```sh
bash "<generator-skill-directory>/claim.sh" list "<project-root>"
```

The status view includes task IDs, port, phase, Attempt, next action, heartbeat,
and worktree. A context lease prevents duplicate or conflicting work.

If a session closes, start another session in the project root and run
`/harness:generator` again. It scans existing Run State before claiming new work:
live local owner/child PIDs are left alone, provably dead local work resumes in its
existing worktree, stale cross-host work requires explicit takeover, and blocked
work requires guidance. When all sessions reach the end together, the merge lock
allows only one Goal Review; other sessions reuse its verdict while `main` remains
at the reviewed commit.

**Why it holds together:** portable atomic-directory locks and Run State coordinate
parallel sessions. One host-neutral state machine owns retry, repair, persistence,
integration, and completion semantics; Claude, Codex, and OpenCode are thin launch
adapters and always preserve the host-configured model. Queue flags are evidence,
but only Integrated Verification plus Goal Review can declare completion.

### Long-running Control Hosts

Hermes, nanobot, and pi can keep a `/goal` alive and use Telegram, but they should
not independently implement the harness loop. They act as **Control Hosts**:
prepare the goal, start or inspect the supervisor, relay durable events, and send
identified user decisions back. `harness-control.mjs` remains the only scheduler;
`orchestrator.mjs` remains the per-context execution state machine.

```text
Telegram ⇄ Hermes / nanobot / pi (Control Host)
                         │ status, events, response
                         ▼
                 harness-control.mjs
                 ├─ Resource Governor
                 ├─ claim/resume contexts
                 ├─ 15-minute progress events
                 └─ immediate Input Requests
                         │ governed worker slots
             ┌───────────┼───────────┐
             ▼           ▼           ▼
       orchestrator  orchestrator  Goal Review
       worktree A    worktree B    integrated main
```

This mode requires Node, Git, Bash, `jq`, and one authenticated worker CLI:
`claude`, `codex`, or `opencode`. The Control Host itself is not the worker host;
for example, Hermes can supervise workers launched with `--host codex`.

The portable skill lives at `skills/control-host`. Expose that directory plus its
`planner` and `generator` siblings through the Control Host's normal skill path;
keep this repository as the single source instead of copying and editing three
variants:

| Control Host | Skill location | Long-running delivery surface |
| --- | --- | --- |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | `~/.hermes/skills/` | Gateway/Telegram plus cron; a script-only cron can run without an LLM call. |
| [nanobot](https://github.com/HKUDS/nanobot) | `~/.nanobot/workspace/skills/` | Telegram plus cron/heartbeat. |
| [pi](https://github.com/earendil-works/pi) | `~/.pi/agent/skills/` or `~/.agents/skills/` | Agent skills; Telegram requires a channel bridge such as [pi-chat](https://github.com/earendil-works/pi-chat). |

For example, choose the appropriate host directory and symlink all three sibling
skills so relative script references remain valid:

```sh
mkdir -p ~/.hermes/skills
ln -s /path/to/harness-engineering/skills/control-host ~/.hermes/skills/control-host
ln -s /path/to/harness-engineering/skills/planner ~/.hermes/skills/planner
ln -s /path/to/harness-engineering/skills/generator ~/.hermes/skills/generator
```

Use the equivalent base directory from the table for nanobot or pi. Also install
the harness plugin in the chosen worker CLI so its agents and normal planning
surface are available. The integration is deliberately one shared skill and one
CLI, not product-specific orchestration code.

#### Start, capacity, and recovery

After planning/scaffolding has produced valid `project_specs.xml` and
`feature_list.json`, a Control Host starts the detached supervisor:

```sh
CONTROL=/path/to/harness-engineering/skills/control-host/scripts/harness-control.mjs
node "$CONTROL" start --repo /path/to/project --host codex \
  --max-workers 4 --quota-workers 2 \
  --cpu-per-worker 2 --memory-per-worker-mb 2048 --reserve-memory-mb 2048
node "$CONTROL" status --repo /path/to/project
node "$CONTROL" capacity --repo /path/to/project --host codex
```

The Resource Governor admits new work up to the minimum of the configured maximum,
CPU slots, free-memory slots, current-load limit, and provider-quota slots. Its
defaults are conservative: four configured workers, two provider slots, two CPU
cores and 2 GiB per worker, 2 GiB reserved for the system, and an 85% one-minute
load limit. Lower capacity stops new admission without killing active workers.
Provider throttling creates a five-minute cooldown by default; an operator or
quota monitor can also set the known concurrent limit explicitly:

```sh
node "$CONTROL" quota --repo /path/to/project --workers 1
node "$CONTROL" quota --repo /path/to/project --pause-until 1782864000
```

All claim, resume, user-retry, and Goal Review starts pass through this same
capacity decision. LLMs never choose the worker count. The supervisor continues
unrelated Ready contexts when one context blocks; it pauses the goal only when
invalid planning, unsafe shared state, required security approval, or unavailable
shared infrastructure prevents useful work.

Durable control data is stored under the project's shared Git directory:

| Path | Purpose |
| --- | --- |
| `.git/harness-control/state.json` | Supervisor heartbeat, PID/host, status, workers, capacity, progress, retries, and pending Input Requests. |
| `.git/harness-control/supervisor.lock/` | Atomic singleton lease that keeps Resource Governor limits global across Control Host sessions. |
| `.git/harness-control/events.jsonl` | Ordered concise Control Events; not a transcript. |
| `.git/harness-control/responses/<event>.json` | One idempotent user response per Input Request. |
| `.git/harness-control/cursors/<consumer>.json` | Last successfully relayed event for each Telegram/channel consumer. |
| `.git/harness-control/logs/` | Per-invocation diagnostic output referenced by events. |

On a new conversation, read `status` first and call `start`. An atomic singleton
lease refuses a live local process or fresh remote supervisor heartbeat. Otherwise the new supervisor
continues from Run State: it leaves live claims alone, resumes provably abandoned
local claims, and emits an Input Request before taking over a stale cross-host
lease. If clean `main` is still the commit covered by the completed Goal Review,
`start` returns `started:false` instead of duplicating the run or its completion
notification. Atomic Claim Leases still prevent two workers from owning the same
context.

#### Telegram progress and blockers

Configure the Control Host's native heartbeat/cron to poll at least once per
minute. The supervisor emits `progress` every 15 minutes, `input_required` and
failures immediately, and `run_completed` only after Goal Review passes:

```sh
node "$CONTROL" events --repo /path/to/project --consumer hermes-telegram
node "$CONTROL" ack --repo /path/to/project \
  --consumer hermes-telegram --event 42
```

Deliver an event before acknowledging it. If Telegram fails, do not acknowledge;
the event is returned on the next poll. This is at-least-once delivery, so the
message may repeat after a crash but cannot disappear merely because chat context
rotated. Pending Input Requests also remain in `state.json` until answered.

An Input Request includes an ID, blocking scope/context, reason, evidence, next
action, and permitted choices. The Telegram relay should show all of them. Map the
user's reply back to that exact ID:

```sh
node "$CONTROL" respond --repo /path/to/project \
  --event 42 --action retry --guidance "Use the reviewed local fallback"
```

Responses are idempotent, and a retry waits for Resource Governor capacity. Use
`pause`, `resume`, or `stop` for operator control. If a planning error caused the
supervisor to exit, submit its `amend` response, call `start` to consume it, update
and reconcile the specification while paused, then call `resume` followed by
`start`. Plain `start` preserves an intentional pause. Never
report completion from an idle queue or an agent message; only the durable
`run_completed` Control Event is the completion signal.

## Learning loop

> *"Little by little, one travels far."*

`/harness:learning-loop` is a [hermes-agent](https://github.com/NousResearch/hermes-agent)–style self-improvement loop: **experience → reflect → create artifact → persist → curate**. It uses each host's native question surface and proposes portable automation without forcing a model or hidden memory directory.

| You did this in the session… | …it suggests |
| --- | --- |
| Re-derived a multi-step procedure (esp. more than once) | a portable **skill** |
| Corrected the same behavior repeatedly ("always/never do X") | an **AGENTS.md rule** |
| A delegatable, context-heavy investigation | a **subagent** |
| A durable fact about you or the project | a **memory entry** (written to your memory dir) |
| A convention it got wrong | an **AGENTS.md** addition |

It's an **orchestrator** — the reflection and routing are its job. A built-in **recurrence bar** (act on things that happened ≥2–3× or are clearly going to recur) keeps it from nagging. Durable learnings persist to your existing per-project memory directory + `MEMORY.md`, so the assistant grows across sessions instead of starting cold. Bundled `evals/` verify it with sample session transcripts.

Invocation is manual by default.

## Docs

| Doc | What's in it |
| --- | --- |
| [Plugins](docs/plugins.md) | Full list of available plugins with CLI support, namespaces, and descriptions. |
| [Extras](docs/extras.md) | Status line, shared config, MCP servers — what they do and how to enable by hand. |
| [Installer](docs/installer/README.md) | Host selection, checklist flags, dry-run guarantees, and scope. |
| [Installer contracts](docs/installer/contracts.md) | Native host contracts and maintained integration decisions. |
| [Installer testing](docs/installer/testing.md) | Automated and authenticated smoke tests. |
| [Keeping the backup in sync](docs/backup-sync.md) | How `/harness:update-project` backs up your live setup into this repo. |

## Releases

> *"The Road goes ever on and on — and so do the version tags."*

Versions are cut automatically from [Conventional Commits](https://www.conventionalcommits.org) on every push to `main`. Releases synchronize both Claude and Codex manifest versions.

Full notes for every version are on the [Releases page](https://github.com/vinicius91carvalho/harness-engineering/releases).

## References

1 - [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps) by Prithvi Rajasekaran on Anthropic Labs
2 - [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) by Justin Young on Anthropic Labs
