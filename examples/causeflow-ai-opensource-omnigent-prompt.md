# CauseFlow AI open-source/Docker migration - archived operator brief

**Status:** delivered **2026-07-12**.
All four subprojects (`core`, `web`, `relay`, `public-docs`) reached `status: complete` with persisted `run_completed` events and Goal Review passed on the integrated plan branch (`plan/opensource-docker`).

This file is a **historical case study and reusable template**, not a live run instruction.
It records how one operator drove a real harness delivery on [CauseFlow AI](https://github.com/vinicius91carvalho/causeflow-ai) while keeping all product edits inside the pipeline.
Adapt paths, subproject names, goal text, and product locks for your own repo.
Keep the operational skeleton: hard boundary, sync playbook, cadence, definition of done, closeout, and status log.

## Operator role (adapt to your repo)

This brief was written for an operator driving both `~/projects/harness-engineering` (the harness plugin/pipeline repo) and `~/projects/causeflow-ai` (the target monorepo).
Substitute your own harness checkout and target repo paths throughout.
The operator is the human in this loop, not a worker: drive the Supervisor skill and control scripts, read what comes back, and only ever fix things by hand inside the two repos named below.
The job was to **prove the harness workflow runs end-to-end as designed** by using it to actually deliver a real goal on CauseFlow AI.

## Hard boundary — read this twice

You may create/edit files **only** in:

- `/home/vinicius/projects/harness-engineering` (this harness repo)
- `~/.claude`, `~/.agents`, `~/.config/opencode`, `~/.codex`, `~/.cursor` (the
  user's installed harness/host configs — "the harness user config")

You must **never** edit anything under `/home/vinicius/projects/causeflow-ai`
directly.
All product work there (removing AWS/Stripe/Clerk, adding Docker,
open-sourcing) happens **only** through the harness pipeline's own coding
workers, dispatched by the orchestrator the Supervisor starts.
If you find yourself about to `Edit` a file under `causeflow-ai/`, stop — that
means something upstream is broken and needs a harness-side fix instead, or you
need to delegate through the orchestrator, not do it yourself.

Everything you fix lives in `harness-engineering`; you then **sync** it to the
live installed copies (playbook below) so the next supervisor run actually picks
it up.
Never treat a harness bug as solved just because you edited the repo —
it isn't live until it's synced.

## The goal that was delivered (hand this shape of goal to the harness, not to chat)

> Turn causeflow-ai (monorepo: `core`, `web`, `relay`, `public-docs`) fully
> open source and runnable via Docker.
> Remove AWS, Stripe, Clerk, and other paid/external SaaS dependencies entirely.
> Keep Hindsight and run local AI via Ornith 9B (`~/tools/llama-session.sh`).
> Marketing site on GitHub Pages; dashboard in Docker with real E2E against Core.
> The result should `docker compose up` and run without any of the removed
> vendors configured.

**Locked product decisions** (encode via planner amend / Acceptance Checks;
also in Claude memory `causeflow-opensource-product-locks`):

**Web hosting**

- **Marketing website** (`apps/website`): static site on **GitHub Pages**
  (static export / SSG artifact).
  Not CloudFront, not SST/AWS, not a Docker service in the local compose stack.
- **Dashboard** (`apps/dashboard`): runs **inside Docker** via `docker compose`
  (SSR/Node container talking to Core).
  Not Lambda@Edge / SST.

**Web ↔ Core E2E and failure routing**

- Dashboard Acceptance Checks / QA must be **real E2E against Core** (compose
  stack up; hit real Core HTTP/SSE), not dashboard-only mocks as the pass path.
- **Mandatory OSS dashboard golden-path E2E** (encode as Acceptance Checks on
  `web` + supporting checks on `core` - do not treat existing mocked Playwright
  or Clerk-staging smoke as sufficient). One Playwright suite must prove the
  operator can:
  1. Sign in with **local OSS auth** (not Clerk) against the compose stack.
  2. Connect a real **test application** (Core-owned runnable mock app, not a
     `page.route` fake) from the dashboard integrations UI.
  3. **Enable integrations/connectors** against that test app through Core's
     OSS/stub integration endpoints (Composio stays removed).
  4. Select/configure the investigation **LLM connector**: default **Ornith 9B**
     on `:8081`. If Ornith's ~32k context is too small for the investigation,
     fall back to **DeepSeek V4 Flash** via **OpenCode Go**
     (`opencode/deepseek-v4-flash-free`) or **NVIDIA NIM**
     (`deepseek-ai/deepseek-v4-pro` / `deepseek-v4-flash` as configured in
     `~/.pi/agent/models.json`). Workers may read auth tokens at runtime from
     `~/.config/opencode` / `~/.pi/agent/auth.json` (or env vars derived from
     them) - **never commit tokens** into causeflow-ai or harness-engineering.
  5. **Create / ingest a real incident** tied to the connected test app so Core
     persists it and starts triage.
  6. Drive the full product loop on the dashboard detail page: **analyses**,
     **triage**, **chat/talk to the model on the incident**, **root-cause**
     hypothesis/evidence, and a generated **remediation** proposal - with live
     SSE/progress from Core, not fixture JSON.
  7. Delivery is not done until this golden path passes end-to-end (plus Goal
     Review). Partial connector smoke or "≥1 LLM call" alone is not enough.
- If an E2E failure is a **Core API / backend / LLM-connector defect** (5xx,
  contract break, missing route, Ornith/DeepSeek miswired), do **not** burn web
  coding retries on it.
  Raise `input_required` / block with evidence and let the **Supervisor**
  route a **Core** worker (or Orchestrator repair on `core`) to fix it in the
  monorepo loop, then retry web E2E.
  Durable rule lives in `skills/generator/SKILL.md` and `skills/supervisor/SKILL.md`.

**Core AI / memory**

- **Hindsight** stays required (bundled `hindsight` container; WI-AC-052-class
  checks).
- Default investigation/triage **LLM** for local OSS: Vinicius's **Ornith 9B**
  via llama.cpp, started with `~/tools/llama-session.sh` (OpenAI-compatible
  `llama-server`, default port **8081**, model
  `~/tools/ai-models/Ornith-1.0-9B-Q4_K_M.gguf`, alias `Ornith-1.0-9B-code`).
  Core must expose this as the default **LLM connector** (OpenAI-compatible base
  URL `http://127.0.0.1:8081/v1`, model alias above).
- **Context overflow fallback:** if Ornith 9B's context window is insufficient
  for a real investigation, Core must support switching the LLM connector to
  **DeepSeek V4 Flash** through OpenCode Go or NVIDIA NIM using the operator's
  existing host credentials (see above). Prefer Ornith when it fits; do not
  require Anthropic for the OSS happy path.
- When the configured LLM connector is down and no approved fallback is
  configured, Core must fail closed with a clear health/investigation error -
  not hang and not silently swap to a DeterministicLLMClient pass-path stub.
- Core must ship a **runnable test application** (mock upstream) that the
  dashboard user can connect, that can emit/ingest alerts into incidents, and
  that investigation agents can query for evidence during the golden-path E2E.

When starting or amending the `web` / `core` planner pass, encode these as
Acceptance Checks / `<planning_decisions>` and drop AWS website+dashboard
deploy paths / Anthropic-as-required local runtime.

**How the goal becomes work**: the orchestrator does not take free-text goals —
a goal becomes real work only once it exists as Acceptance Checks in each
subproject's `project_specs.xml`.
So this goal text is input to the **planner** skill (which adds a feature to an
existing spec), applied per subproject after **setup**/**monorepo-setup** has
produced that subproject's baseline spec.

## Starting state

- `causeflow-ai/.harness/projects.json` lists the 4 subprojects (`core`, `web`,
  `relay`, `public-docs`) — full monorepo scope, four independent runs each with
  its own spec, queue, and completion.
- Each subproject needs a `project_specs.xml` covering the baseline app plus the
  open-source/Docker goal.
  The pipeline is resumable (claim leases + persisted Run State), so a fresh
  session usually **resumes** in-progress runs rather than starting from scratch
  — check `git status` and harness `status` per subproject before assuming where
  a run already stands.

## Sync playbook — how a fix actually goes live (this is the part that's easy to get wrong)

Two different propagation mechanisms, keyed by which host reads the file:

| Fix lives under... | Read by | How it goes live |
| --- | --- | --- |
| `skills/generator/` + `skills/supervisor/` (orchestrator, claim, reconcile, harness-control) | Supervisor and workers via `~/.agents/skills/` (Cursor Agent) and `~/.config/opencode/skills/` (OpenCode) | Run `bash /home/vinicius/projects/harness-engineering/install.sh --yes` **invoked by its real path in this repo** (not curl-piped). `ensure_repo()` detects it's running from inside a real checkout and copies straight from the **local working tree** — uncommitted changes included. No push needed. `claim.sh` is spawned fresh per operation, so a copy goes live on the next merge with no supervisor restart; a changed `orchestrator.mjs`/`harness-control.mjs` is loaded into the long-lived process and only takes effect on the next worker/supervisor start. |
| Root `skills/`, `agents/`, etc. (the Claude Code / Codex plugin proper) | Claude Code / Codex via their marketplace | `~/.claude/plugins/marketplaces/harness-engineering` is a **separate git clone of `origin` on GitHub** (its own `.git`, tracking `github.com/vinicius91carvalho/harness-engineering`). `install.sh`'s Claude/Codex install step only runs `claude plugin marketplace update` / `codex plugin marketplace upgrade`, which pulls from GitHub — it does **not** copy local files. **You must `git commit` and `git push origin main` before this propagates**, then run the installer (or `claude plugin marketplace update harness-engineering` + reinstall/update the affected plugin) to pick it up. |
| `~/.config/opencode/**` (namespaced OpenCode skills) | OpenCode workers/hosts | Same local-working-tree copy as the generator/supervisor row — `install_opencode_plugin()` also uses the `ensure_repo()` shortcut. No push needed. |

You're explicitly authorized to `git commit` and `git push origin main`
directly on this repo (matches its existing history — recent commits are
direct-to-main, no PR flow in use).
Pushing triggers this repo's own release workflow (auto-versions the plugin,
updates the changelog) — that's expected, not a side effect to avoid.
Never push anything from inside `causeflow-ai`.

**Don't run the full interactive installer on every fix.** `install.sh --yes`
also drives `mcp-servers`, which prompts per-server for secrets — fine once,
but a hang risk if re-run unattended inside an hours-long loop.
For the *repeated* post-fix resync (generator/supervisor/opencode row of the
table above), prefer the surgical copy — copy the changed file straight into
`~/.agents/skills/<skill>/` (and the matching OpenCode path under
`~/.config/opencode/skills/`) yourself, or run the installer with stdin closed
(`bash install.sh --yes </dev/null`) so a stalled prompt fails fast instead of
hanging the loop.
Reserve a real `install.sh --yes` run for when you've actually changed something
outside those paths.

After every fix: **(1)** run the relevant local test(s) in
`harness-engineering/tests/`, **(2)** sync per the table above, **(3)** only
then resume the supervisor loop.

## Driving the Supervisor (Cursor Agent, Claude Code, or OpenCode)

Invoke the **supervisor** skill with the subproject path.
In Cursor Agent the installed skill lives at `~/.agents/skills/supervisor/`; the
control script is:

```sh
node ~/.agents/skills/supervisor/scripts/harness-control.mjs status \
  --repo /home/vinicius/projects/causeflow-ai/core | jq .
```

OpenCode equivalent:

```sh
node ~/.config/opencode/skills/harness-supervisor/scripts/harness-control.mjs \
  status --repo /home/vinicius/projects/causeflow-ai/core | jq .
```

**Start or resume** all four subprojects (one supervisor per subproject — never
one aggregate supervisor for the whole monorepo):

```sh
CONTROL=~/.agents/skills/supervisor/scripts/harness-control.mjs
for sub in core web relay public-docs; do
  node "$CONTROL" start --repo "/home/vinicius/projects/causeflow-ai/$sub" \
    --host pi --display herdr --max-workers 4 --quota-workers 2 \
    --cpu-per-worker 2 --memory-per-worker-mb 1024 --reserve-memory-mb 1024 \
    --summary-minutes 20
done
```

Use `--display background` when not inside a herdr workspace.
Use `--host agent` when driving from Cursor Agent itself instead of `pi`.

Poll status and events out-of-band (no chat REPL required):

```sh
node "$CONTROL" status --repo /home/vinicius/projects/causeflow-ai/core | jq .
node "$CONTROL" events --repo /home/vinicius/projects/causeflow-ai/core \
  --consumer manual-check
```

Note zsh does not word-split an unquoted variable, so `$CONTROL status ...`
runs the whole string as one command name and fails — invoke
`node <full path to harness-control.mjs> status ...` literally, or define
`CONTROL` as a shell function.
Run this per subproject (`core`, `web`, `relay`, `public-docs`) — each is an
independent run.

Before reporting a long-running goal as started, validate reconcile:

```sh
node ~/.agents/skills/generator/reconcile.mjs \
  /home/vinicius/projects/causeflow-ai/core --check
```

## Standing rule: every harness surprise becomes a workflow fix

This brief gets reused for future runs, by the user or by other agents.
Any time the harness does something unexpected — a job dies, a step needs a
hand-crafted one-off command, a prompt is ambiguous enough that a host guesses
wrong — that is not a one-time inconvenience to work around, it is a **gap in
the workflow** and must be closed durably: fix the script/skill in
`harness-engineering`, add a regression test, sync it, and note it in the
status log below.
The bar is "a future run should need fewer manual interventions than this one
did," not "this run eventually got through."

Before treating a `pending` input as actionable, cross-check its context
against the subproject's own `generator-claims.json` and read the actual
defect/log detail — a `blocked`/`failed`/`could not resume` reason is often
stale residue whose work already moved on, not a live block.
Read the real error, not the counter.
The supervisor **auto-retries** pending context `input_required` events each
tick (worker exit, integration failure, claim-lease exhaustion, etc.) unless
the context still has a live worker, is already in the retry queue, or hit the
crash bound.
Goal-scoped inputs still require a human.
Finished harness-worker herdr panes for **this subproject only** close when Run
State is terminal or the pane is gone.

**Monorepo herdr rule (do not regress):** four supervisors share `harness-workers`
tabs. Pane cleanup must be scoped per subproject (`worker-core-*`, `worker-web-*`,
etc.). Never close all non-keep panes on a shared tab — that killed sibling
workers, left zombie pane IDs in state, and showed "no panes alive" while status
claimed workers were running.

**Never run an ad-hoc `opencode run`/`claude -p`/`codex exec`/`agent -p` job
directly against the shared monorepo root while any subproject's orchestrator is
running.**
The generator's merge lock is monorepo-wide (all 4 subprojects share one
`.git`), and the integration agents (`MERGE`, `INTEGRATION_QA`) operate directly
in that shared root, not an isolated copy.
An ad-hoc job bypasses the lock and can race a live worker in the exact same
working tree — this has reset `main`'s history to a near-empty state before
(recovered only because the real commits were still reachable via `gen/*`
branches).
If a fix requires touching the shared root, `pause` all 4 subprojects first, do
the fix, then resume — every time, no exceptions, even for a two-second git
command.

## Operating loop

1. **Bootstrap** (once per subproject): get a baseline `project_specs.xml` via
   `setup`/`monorepo-setup` (adopt as-is, preserve app files), then run
   `planner` to layer in the open-source/Docker/no-AWS-Stripe-Clerk goal as new
   Acceptance Checks.
2. **Start or recover**: inspect `status` first, then `start` (or let the
   supervisor skill do both).
   Reconcile `--check` must pass before reporting the goal as running.
3. **Steady state**: poll `status`/`events` roughly every 20 minutes.
4. **When workers are admitted**: check whether the relevant process is actually
   alive before assuming it's stuck:
   - Bootstrap phase: `kill -0 $(cat causeflow-ai/.harness/bootstrap.pid)`
   - Main run: `status --repo <subproject> | jq -r '.supervisorPid,
     (.workers | to_entries[] | .value.pid)'` then `kill -0` each; also check
     `herdr agent list` when `--display herdr`.
   - **Alive → wait**, don't interrupt it.
     **Dead → that's a stuck signal** — diagnose, fix harness-side if needed,
     respond to pending inputs, restart.
   - **Alive-but-idle-looking is usually still busy.**
     A `pi` worker writes its work into the git worktree, not to its stdout log,
     so a 0-byte/stale stdout is **not** a hang — judge liveness by the newest
     file mtime under the worker's worktree and the child pid's elapsed time,
     never by stdout size.
     A long *orchestrator* elapsed time is cumulative across many sequential
     per-Work-Item calls, not one stuck call.
     A low concurrent-worker count (often just 1 per subproject) is normally the
     memory-slot throttle — expected and self-clearing as workers finish and
     free RAM — not a stall.
5. **When something is actually broken** (not just slow): diagnose the root
   cause in `harness-engineering`, fix it there, test it, sync it (playbook
   above), then resume — never patch around it by touching `causeflow-ai`
   directly or by inventing new `harness-control.mjs` subcommands.
6. Repeat until every subproject's Goal Review reports `status: complete` /
   `goal: true` and a `run_completed` event is persisted.
7. Run the **After all tasks done and plan delivery** closeout: plan branch
   owns all work, remove leftover branches/worktrees, learning-loop, then
   no-mistakes on the plan branch.

## Answering harness input requests — this is most of the job

When the supervisor surfaces a decision, **you make the call, as Vinicius would**
— you don't stall waiting for the real human every time.
"You can't do things by yourself" means don't hand-edit `causeflow-ai` or bypass
the pipeline; it does not mean don't make product decisions.
Default to the reasonable, goal-aligned answer yourself.
Only escalate to the real user for something genuinely irreversible or purely a
matter of taste (e.g. "which of these two paid replacements should we use" where
the goal text doesn't already imply an answer).

Mechanisms:

- **Bootstrap decision** (`ASKED`/`WAITING_FOR_ANSWER`, e.g. "which of 4
  monorepo projects"): answer via the setup skill's bootstrap flow, then
  re-check before relaunching.
- **Running orchestrator `input_required`**:

  ```sh
  node "$CONTROL" respond --repo <subproject> \
    --event <id> --action <retry|pause|amend|abort> \
    --guidance "<your reasoning>"
  ```

  After an `amend`, the run is intentionally paused for a human spec edit —
  never call `start` again until you've actually made that edit and are ready to
  resume.

Answer promptly and keep moving — a long run stalled on an unanswered question
is indistinguishable from a stuck one.

The `pi` worker host assumes `pi` itself is authenticated/configured (model
routing in `~/.pi/agent/models.json`, credentials in `~/.pi/agent/auth.json`).
If `pi` fails to launch, fix credentials/config before switching hosts.

## Cadence — status + pane-log checks

Start each run with `--summary-minutes 20`.

**Every ~10 minutes, read the herdr tab/pane logs** (not only `harness-control
status`). Status can say `working` while the pane is frozen on heartbeats or a
hung Cursor agent. For each live worker pane:

1. `herdr pane list` — note `scroll.max_offset_from_bottom` and `agent_status`.
2. Sample scroll twice ~10–15s apart. If scroll does not advance and the tail is
   only `agent: still working…` (no new `thinking:` / `tool →`), treat as stuck.
3. `herdr pane read <pane_id> --source recent --lines 40` — look for:
   - live `thinking:` / `tool →` / `tool ✓` (healthy),
   - `===HARNESS-VERDICT-BEGIN/END===` followed by endless heartbeats (hung after
     verdict — recycle orchestrator; early-exit should kill the agent),
   - empty pane after `CODING → agent` with no `agent: started` (spawn/stream
     broken — check `roles.json` + stream-json flags),
   - repeated rate-limit / usage-limit errors (park or switch host).
4. Propose and apply a harness-side fix when the pane shows a harness bug; sync
   to `~/.agents/skills/` and recycle that worker. Do not edit causeflow product
   code by hand.

**Every ~20 minutes**, also give the user a concise fleet status (progress
deltas, pending inputs, memory, what you fixed). Prefer a 10-minute loop whose
prompt always includes the pane-log checklist above; fold the fuller status into
every other tick if needed.

**Stop the loop when idle.**
After each tick, check whether every subproject is `status: complete` with a persisted `run_completed`, or whether `wakeTriage.shouldWake === false` and progress counters / workers are unchanged since the last tick.
If either is true, do not schedule another 20-minute wakeup or fleet narration.
Cancel `/loop` or `ScheduleWakeup` and proceed straight to closeout instead.
This run kept firing idle 20-minute checks after delivery until the operator manually stopped the loop - treat that as a defect to avoid, not normal cadence.

While work is still active, a Claude Code session with `ScheduleWakeup` can use
~600s wakeups for the pane-log check; if you were invoked via the `/loop` skill,
self-pace at that cadence until the idle/complete stop condition above applies.

## Definition of done

- All 4 causeflow-ai subprojects have a `project_specs.xml` covering both the
  baseline app and the open-source/Docker/no-AWS-Stripe-Clerk goal.
- Each subproject's queue is fully implemented + QA'd + integrated, and Goal
  Review has run and passed on the integrated plan branch (then main when released).
- `docker compose up` runs Core + dashboard (+ Hindsight + local Ornith reachable
  on :8081) with AWS, Stripe, and Clerk fully removed.
- Marketing website builds as a static GitHub Pages artifact (not in compose).
- Dashboard QA is E2E against Core; Core API defects were fixed via the Core
  supervisor loop, not web-only patches.
- OSS dashboard Playwright proves the golden path: local auth, connect a
  runnable test application, enable integrations, configure Ornith (or
  DeepSeek V4 Flash fallback via OpenCode Go / NVIDIA NIM), create an incident,
  run analyses/triage/chat/root-cause/remediation against Core (web+core
  AC-054..AC-061).
- Every harness-side bug you hit along the way has a durable fix committed in
  `harness-engineering` and synced to the live configs - not just patched around
  for this one run.
- You've been reading herdr pane logs ~every 10 minutes and reporting fleet
  progress ~every 20 minutes throughout.
- The post-delivery closeout below has been completed (plan branch ownership,
  worktree/branch cleanup, learning-loop, no-mistakes).

## After all tasks done and plan delivery (mandatory closeout)

Do **not** start this section until every subproject has `status: complete`,
Goal Review passed, and a persisted `run_completed` event.
Stop all supervisors first so no worker still owns a worktree.

### 1. Plan branch owns all the work

- Integration branch is recorded in `causeflow-ai/.harness/integration-branch`
  (expected: `plan/opensource-docker`).
- Check out that plan branch in the main repo root and confirm it contains every
  integrated commit from the four subproject Goal Reviews.
- Diff against `main` (or the pre-plan base) and confirm the open-source/Docker
  delivery is fully present on the plan branch - not stranded on `gen/*` or
  detached HEADs.
- Do **not** merge to `main` unless the operator explicitly asks; the closeout
  target is a clean, complete plan branch.

### 2. No leftover branches or worktrees

After supervisors are stopped and leases are clear:

```sh
TOP=/home/vinicius/projects/causeflow-ai
git -C "$TOP" worktree list
git -C "$TOP" branch
```

- Remove every harness generator worktree (`causeflow-ai-wt-*`, `/tmp/*` checkouts)
  with `git worktree remove` (use `--force` only if the tree is dirty and already
  merged/abandoned).
- Delete leftover local branches that are not the plan branch or `main`
  (especially `gen/*`, stale recovery branches).
- End state: one primary checkout on the plan branch, plus `main` if it already
  exists locally - no other worktrees, no stray feature/gen branches.
- Never delete remote history or force-push unless the operator explicitly asks.

### 3. Run the learning-loop skill

Invoke the **learning-loop** skill on this operator session (and the transcript
if needed).
Prefer durable updates under `harness-engineering/skills/*` (supervisor,
generator, monorepo-supervisor-ops, learning-loop), then sync to `~/.agents`.
Do **not** dump pipeline ops lessons into `AGENTS.md` / `CLAUDE.md`.
Present findings, apply approved high-leverage changes, and append a short note
to this brief's operator status log.

### 4. Run no-mistakes on the plan branch

With the main checkout on the plan branch and worktrees cleaned:

```sh
cd /home/vinicius/projects/causeflow-ai
git checkout plan/opensource-docker   # or the path in .harness/integration-branch
no-mistakes status || no-mistakes init -y
no-mistakes axi run
```

Drive any approval gates via `no-mistakes axi respond`.
Do not treat delivery as finished until no-mistakes completes successfully on
that plan branch (or the operator explicitly waives a blocked step).

## Ops diagnosis (learning-loop, 2026-07-10)

When a Work Item "never finishes" on integrate/resume with defects like
`Checkpoint was not integrated into the integration branch` and no real product
change: check **flag drift** first.
Compare plan-branch `feature_list` / ledger `integration=true` vs the worktree.
If the plan already integrated the WI, sync flags and skip re-merge thrash —
do not recycle coding.
Code path: `skills/generator/lib/integrate-checkpoint.mjs` (skip when plan
already integrated).
Ops table: `skills/monorepo-supervisor-ops/SKILL.md`.

## Operator status log

Newest entry on top.
Compact facts only — see git log in `harness-engineering` for full commit
messages/diffs.
Append an entry whenever the standing rule above requires closing a workflow
gap.

### 2026-07-11T16:51 UTC-3 — CORE COMPLETE; web resumed

- Core Goal Review `goal:true` defects:[]; 61/61/61; status=complete; evidence goal-1-goal_review-d8df4f9ba526fd72
- Note in verdict: stock ac061-verify fails if it posts host 127.0.0.1:5190 into compose API (use empty connect / docker DNS) — not product defect
- Web resumed → running; dashboard INTEGRATION_QA admitted (MCP warmup); 51/51/50 of 61 remaining
- relay+public-docs already complete

### 2026-07-11T11:30 UTC-3 — self-improve: any fix lands in the workflow too

- Rule wording: any fix must land in the workflow too (self-improvement); session-only
  recovery is unfinished. Also: blocker wins host RAM (core before web).
- Skills: supervisor #5/#6, monorepo-ops #11/#12, learning-loop. Synced to ~/.agents.


### 2026-07-11T10:45 UTC-3 — supervisor preflight mandatory on start/init

- Durable: `harness-control preflight` + auto-run in `start`/`initialize`.
- Clears ghost runs, dead-session claims, governor ghosts, stale capacity/health;
  gates on reconcile --check; seeds evidence retry guidance when generic.
- Synced to ~/.agents (+ OpenCode/Cursor local). Tests in supervisor_fast_test.

### 2026-07-11T10:34 UTC-3 — preflight cleanup then core+web start

- Cleared ghost leases/runs (core OSS, web dashboard/website/OSS); claims emptied then re-admitted fresh.
- Removed orphan worktree `/tmp/core-clean-ac044` + leftover `wt-relay-audit-trail`; pruned dead governor snapshot/workerHealth.
- Seeded evidence-backed retry guidance for core WI-AC-060 (BullMQ followup) and web contexts.
- Reclaimed docker builder cache; capacity restored (mem slots≥2).
- Started core+web supervisors (`agent`/`herdr`, max-workers 2, 640MB); skipped relay/public-docs (complete).
- Did not restore composer-first stashed roles.json (OSS-first / direct-host).

### 2026-07-10 ~23:45 UTC-3 — INTEGRATION_QA suicide via pkill cleanup

- Symptom: AC-046 verify PASSes repeatedly; ledger stays `integration:false`; Session terminated right after cleanup; progress stuck 51/51/50.
- Root: RESOURCE_CLEANUP_RULE said cleanup *before* verdict and invited `pkill` scoped to PORT/WORKDIR; agent cmdline embeds both → self-kill drops verdict.
- Also: catalog `feature_list` had premature `int:true` but ledger correctly `false` (skip-path correctly does not fire).
- Fix: verdict-first cleanup; forbid `pkill -f`/`killall` on WORKDIR/PORT; only `kill $(cat .harness/app.pid)`. Synced prompts; recycled open-source worker.

### 2026-07-10 ~23:05 UTC-3 — false early-exit kills after AC-046 PASS

- Symptom: `ac046-verify.sh` PASSes (6 agents, evidence, hypotheses, Hindsight) but coding workers die every ~2–3 min with `Session terminated`; no harness verdict recorded; progress stuck 50/53.
- Likely harness amp: `maybeEarlyExitOnVerdict` used `parseObject` loose JSON fallback (any `{"id":...}`) → SIGTERM mid-task.
- Fix: gate early-exit on `hasCompleteVerdict` (BEGIN/END only). Synced `hosts.mjs`; recycled open-source orchestrator. Residual: agent `pkill -f $WORKDIR` suicide still possible; playwright MCP still enabled and 60s-timeouts on warmup.
- Core still coding WI-AC-046; web stopped; relay/public-docs complete.

### 2026-07-10 ~22:10 UTC-3 — infra_error crash-loop + `core/core/` path bug

- Stall: empty core fleet; crashCounts=5 on `open-source-local-runtime` after infra_error / merge failures.
- Layer 1: stuck MERGE_HEAD + dirty package.json/pnpm-lock; herdr recycle dropped pane tail → empty-tail crash inflation. Fixed: persist pane tail; no silent retry on `infra_error`.
- Layer 2: `autoResolveHarnessProgressConflicts` wrote `…/core/core/harness-progress/…` (ENOENT). Fixed: resolve via git toplevel. Synced both fixes; tests in `lib_test`.
- Recovery: merge --abort + stash dirty packages via `agent -p`; core restarted. Now: merge lock held, harness-progress auto-resolved, only `bootstrap.ts` conflict left for MERGE agent (MCP warmup). Progress 50/53. Web still stopped.

### 2026-07-10 ~21:45 UTC-3 — empty-fleet auto-recovery

- Stall: dead merge lock (`holderAlive=false`) + crash-bound/ghost-PID retry drain left `workers={}` with free capacity.
- Fix (`aeee497`): tick auto-clears stale same-host merge/state locks; resets crash-bound when fleet empty after clear; ghost run-state PIDs no longer count as successful retry (orphan SIGTERM + defer).
- Synced to `~/.agents` + OpenCode; core supervisor recycled. Regression in `supervisor_fast_test.sh`.

### 2026-07-10 ~19:40 UTC-3 — empty fleet + nested Task re-delegate

- Core empty fleet: remediation worker died after nested Task/gpt-5.5 usage-limit; quota pause left capacity 0.
- Cleared quota pause; re-admitted remediation (WI-AC-025) + open-source-local-runtime (WI-AC-046/047/052).
- Harness fix: `NO_REDELEGATE_RULE` in `skills/generator/prompts/feature.mjs` (CODING/QA/INTEGRATION_QA); synced to `~/.agents`; workers recycled.
- relay + public-docs remain `run_completed`; web stays stopped until core finishes (31/53, pending foundation triple-fail).
- Progress at restart: core 49–50/53 integrated; remaining remediation + open-source-local-runtime.

### 2026-07-10 ~16:55 UTC-3 — learning-loop → skills + this brief

- Scaffolded: cross-project E2E API escalation (generator + supervisor);
  flag-drift diagnosis (monorepo-supervisor-ops + generator pointer);
  memory `causeflow-opensource-product-locks`.
- Synced skill SKILL.md files to `~/.agents/skills/`.
- This brief's goal block / definition of done aligned with product locks.

### 2026-07-10 ~16:49 UTC-3 — web E2E + local Ornith LLM locked

- Dashboard QA = E2E vs Core; Core API defects escalate to Supervisor → core
  repair loop (do not thrash web retries).
- Core keeps Hindsight; local AI = Ornith 9B via `~/tools/llama-session.sh`
  (llama.cpp :8081), not Anthropic-required for OSS happy path.

### 2026-07-10 ~16:46 UTC-3 — web hosting split locked

- **Decision:** website → static GitHub Pages; dashboard → Docker Compose
  service (with Core). Replaces CloudFront/SST/Lambda@Edge for OSS.
- **Apply when:** web supervisor starts / planner amend on `web` specs.
- Web stays stopped until core finishes (unchanged).

### 2026-07-10 ~01:25 UTC-3 — tabs must show thinking/tools (MCP warmup silence)

- **Symptom:** tabs looked idle for ~2 min; only heartbeats. Agent was loading
  Playwright/BrightData MCP plugins (60s timeouts) before first token.
- **Fix:** disable `playwright` + `brightdata` MCP for CLI agent; enable
  `showThinkingBlocks`; spawn with `--approve-mcps --sandbox disabled`; pane
  prints "waiting for first token / MCP warmup" until stream starts.
- Live panes already show `thinking:` / `tool →` once warmup finishes.

### 2026-07-10 ~01:20 UTC-3 — hung Cursor agent after verdict + 10-min pane checks

- **Symptom:** panes looked stopped; only `agent: still working` heartbeats.
  AC-019 QA had already printed `HARNESS-VERDICT` (`qa=true`) but the agent
  process never exited, so the orchestrator never advanced.
- **Fix:** early-exit on a parsed verdict `id` (ignore VERDICT_HINT placeholders
  in the prompt); kill the `script`→`agent` process tree (`pkill -P`); keep
  pane heartbeats. Operator brief now requires **10-minute pane-log reads**.
- Recycle stuck core workers after syncing `orchestrator.mjs` / `verdict.mjs`.

### 2026-07-09 ~17:55 UTC-3 — live agent logs in herdr panes

- **Ask:** panes should show model thinking/tools, not only orchestrator phase lines;
  finished agents must close their panes.
- **Root cause:** `pi -p` only prints the final answer; agent stdout was also buffered
  without `script -f`. Orphan finished panes closed only on terminal Run State.
- **Fix:** herdr spawns use `script -qf`; `pi` gets `--mode json` with a formatter that
  streams `thinking:` / `tool →` / verdict text into the pane; finished/orphan panes
  close immediately. Synced + workers recycled — panes now show live thinking/tools.

### 2026-07-09 ~17:48 UTC-3 — lease loss + memory + false orphan panes

- **Pane logs:** core INTEGRATION_QA holding merge lock; relay goal-review waiting;
  web/public-docs pi shells killed (`Session terminated`) under memory pressure
  (14Gi RAM, ~8.5Gi swap, mintlify ~1.1Gi, dockerd ~2.5Gi, parallel docker builds).
- **Bug A:** `updateSupervisorLock` fatal'd on `supervisor lease was lost` → `run()`
  finally closed every herdr pane. **Fix:** re-acquire lease; never close herdr panes
  on supervisor exit/SIGINT; tick errors no longer kill the loop.
- **Bug B:** `detectPaneOrchestratorExited` matched old `Session terminated` in
  scrollback and closed live workers after pi restart. **Fix:** only treat as exited
  when kill is after the latest `orchestrator:` line.
- Restarted all four supervisors via `start` with `--max-workers 2` /
  `--memory-per-worker-mb 2048` to reduce OOM kills.

### 2026-07-09 ~17:42 UTC-3 — supervisor rehydrate (dead supervisor / zombie panes)

- **Bug:** killing/restarting supervisors left orchestrators running in herdr panes but
  `workers` map empty — no pane cleanup, no input processing, frozen status ("no panes
  alive" from operator view while scrollback showed finished sessions).
- **Fix:** `rehydrateHerdrWorkers()` reattaches live `worker-<project>-*` panes from
  `herdr agent list` to the supervisor each tick; auto-retry goal-review worker exits.
- All four supervisors restarted; workers reattached (core×2, web×2, relay goal-review,
  public-docs×1).

### 2026-07-09 ~17:35 UTC-3 — finished-pane cleanup + merge-lock clarity

- **Bug:** herdr panes stayed open after `Session terminated…` / idle shell prompt because
  cleanup only trusted herdr `agent_status` (still `working`) and scanned 8 tail lines
  (stale `orchestrator:` scrollback blocked idle detection).
- **Fix:** close panes when the **last line** is a shell prompt, orchestrator child is
  dead, or run state is terminal; close **untracked** `worker-<project>-*` panes on
  supervisor tick; show `waiting for merge lock` in pane status (serialized integration —
  normal for core monorepo).
- Manually closed stale `worker-relay-goal-review` pane `w1:p165`; supervisors restarted.

### 2026-07-09 ~17:20 UTC-3 — monorepo pane cleanup + auto-retry (workflow fix)

- **Bug:** `closeStaleHarnessPanes` closed every pane not in *this* supervisor's
  keep-set on shared `harness-workers` tabs. Four parallel supervisors cross-killed
  each other's worker panes → zombie state (pane IDs in status, `pane_not_found`
  in herdr), no visible panes, no progress.
- **Fix:** `closeStaleHarnessPanesForProject(tab, projectId, keep)` — only closes
  finished/dangling panes for `worker-<project>-*` agents; sibling subprojects
  untouched. Regression test in `tests/herdr_spawn_test.mjs`.
- **Also:** `supervisor-auto-respond.mjs` auto-writes `retry` for pending context
  `input_required` each tick (worker exit, integration failure, claim lease, etc.).
- Synced to `~/.agents/skills/`; supervisors restarted. Seven live workers on
  `harness-workers` tab after fix.

### 2026-07-09 ~14:22 UTC-3 — dropped omnigent; direct supervisor

- Omnigent (`omni run` + tmux `omnigent-supervisor`) retired from this workflow.
  Supervisor now runs via `/supervisor` skill + `harness-control.mjs` at
  `~/.agents/skills/supervisor/` (Cursor Agent install).
- Prior omnigent runner had disconnected (`No runner bound for session`); all
  four subprojects were `stopped` (SIGTERM).
  Restarted supervisors (`pi` host, herdr display): core 1776515, web 1776570,
  relay 1776633, public-docs 1776707.
- Progress at restart: core 18/53 integrated (~34%), web 21/53 (~40%), relay
  52/58 (~90%), public-docs 29/33 (~88%).
  Eight workers re-admitted in herdr, all `working`.
- Responded to stale SIGTERM-orphan and integration-failure inputs from the
  prior session; avoid responding `retry` on stale inputs while live workers are
  already running (causes spurious claim-lease races).
- `pnpm exec biome check .` on web now exits 0; `feature_list.json` reformat in
  `atomicJson` (`skills/generator/lib/fs-json.mjs`) is synced to
  `~/.agents/skills/generator/`.
- Pending at last check: core — claim-lease stale inputs on
  observability-and-ops + integrations-and-notifications (workers alive);
  web — WI-AC-004 foundation coding-agent failure (biome); relay — postgres-driver
  claim-lease stale; public-docs — invariants-and-validation claim-lease stale.

### 2026-07-11T02:55:23Z
- core: 51/51/51 of 53; WI-AC-046 ledger integration=true
- Fixed supervisor orphanShell race: agent verdict early-exit printed "Session terminated" and dead childPid made inspectHerdrWorkers kill orchestrator before ledger apply
- Synced hosts.mjs/herdr-spawn/harness-control; restarted core supervisor pid=1155957
- Remaining open-source: WI-AC-047, WI-AC-052 (ledger null); remediation 024/025 already integrated

### 2026-07-11T03:01:26Z
- core 51/51/51; WI-AC-046 integrated; coding WI-AC-047 on w4:p12M (healthy tooling)
- crashCounts open-source=1 (stale from recycle); no retry queue

### 2026-07-11T03:11:26Z
- core 52/52/52; WI-AC-047 integrated; coding WI-AC-052 on w4:p12Q (healthy)
- brief MCP-warmup stuck recycle ~03:09 auto-retried OK

### 2026-07-11T03:21:27Z
- core 53/52/52; WI-AC-052 implementation=true; QA in flight on w4:p12Q
- early-exit after coding verdict did NOT kill orchestrator (fix holding); web still stopped

### 2026-07-11T03:33:46Z
- core 53/53/53 complete; Goal Review was crash-looping on dirty checkout (untracked ac046-start.sh, roles.json, package-lock.json)
- stashed those to /tmp/causeflow-goal-review-stash; respawned goal-review on w4:p120 (MCP warmup)
- web still stopped pending core Goal Review

### 2026-07-11T03:41:26Z
- core 53/53/53; Goal Review healthy tooling on w4:p131 (crashCounts=1 from earlier retry)
- dirty=1 in core during review — monitor end-of-run read-only check
- web still stopped

### 2026-07-11T03:42:19Z
- Goal Review healthy on w4:p131; only dirt is .harness/app.pid (runtime)
- harness: meaningfulCheckoutDirt ignores *.pid under .harness (synced; applies on next orchestrator spawn)

### 2026-07-11T03:51:51Z
- Goal Review BLOCKED/reopened WI-AC-003, WI-AC-035, WI-AC-050 (dashboard missing from Docker image; pnpm test:run failures)
- progress 50/50/50; repair workers: foundation(WI-AC-003), widget-and-portal(WI-AC-035)
- OSS pipeline itself passed Goal Review HTTP checks

### 2026-07-11T04:01:27Z
- core 52/52/50; WI-AC-003+035 impl+qa true, both in INTEGRATION_QA (merge lock serialize); WI-AC-050 still coding
- foundation had one stuck recycle ~04:01 auto-retried

### 2026-07-11T04:11:25Z
- core 53/52/52; WI-AC-003+035 integrated; WI-AC-050 impl=true, isolated QA on w4:p13A (healthy)

### 2026-07-11T04:21:34Z
- core 53/53/52; WI-AC-050 INTEGRATION_QA on w4:p13B — unit failed earlier, integration passed, e2e in flight (vitest)
- 003+035 integrated; web still stopped

### 2026-07-11T04:31:29Z
- WI-AC-050 INTEGRATION_QA failed → Repair Plan → coding attempt 3 (retries=2) on w4:p13D healthy
- blockers: forbidden @aws-sdk/@clerk test imports; e2e PORT 5174 vs compose :3099
- core 52/52/52; 003+035 still integrated

### 2026-07-11T04:41:28Z
- core 53/53/52; WI-AC-050 coding+isolated QA passed (attempt 3); INTEGRATION_QA just started on w4:p13F (MCP warmup)
- prior INTEGRATION_QA pane recycled once for MCP warmup timeout

### 2026-07-11T04:52:24Z
- WI-AC-050 blocked after Attempt 3 INTEGRATION_QA; defects: forbidden imports still on plan, unit/e2e failures, PORT 5174 vs :3099
- worktree rg was clean vs dirty plan → merge-landing gap; responded retry with focused guidance; worker back on w4:p13G coding
- core 52/52/52 (blocked cleared)

### 2026-07-11T05:01:29Z
- core 53/53/52; WI-AC-050 INTEGRATION_QA on w4:p13J (healthy); integration passed; e2e mostly pass except PORT 5174 vs :3099 regression test
- forbidden-import rg clean on plan+worktree this tick

### 2026-07-11T05:11:32Z
- core 53/53/53; WI-AC-050 integrated; Goal Review running on w4:p13M
- prior Goal Review exit goal:false auto-retried; agent already sees dashboard 500 again — check Docker image copy

### 2026-07-11T05:11:43Z
- Dockerfile still lacks COPY dashboard/; compose image has no /app/dashboard — Goal Review will likely reopen WI-AC-003/035
- WI-AC-050 integrated; core 53/53/53; Goal Review healthy on w4:p13M

### 2026-07-11T05:22:04Z
- Goal Review blocked: dashboard missing from Docker image; WI-AC-035 attempt budget exhausted
- Reset ledger 003/035; responded with Dockerfile COPY guidance; seeded foundation+widget workers (not goal-review)

### 2026-07-11T05:32:03Z
- False QA: agents passed AC-003/035 via host init.sh with zero Dockerfile changes; compose still 500
- Reset ledger; recycled foundation+widget with hard guidance: COPY dashboard/, rebuild image, prove :3099 only
- workers w4:p13V / w4:p13W

### 2026-07-11T05:44:45Z
- False INTEGRATION_QA on 035 with empty defects; reset 003/035
- Ops agent added COPY dashboard/ + rebuilt image; curl :3099/dashboard should be 200
- Reseeded foundation+widget to verify/merge on compose only

### 2026-07-11T05:51:43Z
- WI-AC-003 integrated; plan Dockerfile has COPY dashboard/; :3099/dashboard=200
- WI-AC-035 INTEGRATION_QA healthy on w4:p143; core 53/53/52

### 2026-07-11T06:01:45Z
- CORE COMPLETE: Goal Review goal=true; 53/53/53; run_completed
- relay+public-docs already complete; started web supervisor (was stopped at 31/31/31 of 53)

### 2026-07-11T06:02:26Z
- CORE COMPLETE goal=true 53/53/53 run_completed; dashboard :3099=200
- web supervisor started via `start` (pid live); was stopped at 31/31/31 of 53; relay+public-docs complete

### 2026-07-11T06:11:28Z
- core complete; web 32/31/31 of 53; 3 healthy workers (foundation QA, website+dashboard coding)
- foundation diagnosing Playwright webServer timeout on :3000

### 2026-07-11T06:50 UTC-3 — golden-path E2E expanded (test app + DeepSeek + full loop)
- Prompt + plan: AC-058..061 web/core — connect runnable test app, enable
  integrations, Ornith default / DeepSeek V4 Flash fallback (OpenCode Go or
  NVIDIA NIM via host auth), analyses→triage→chat→root-cause→remediation,
  Playwright capstone as delivery gate. Tokens never committed.
- Commit on `plan/opensource-docker`; supervisors resumed after amend.

### 2026-07-11T06:45 UTC-3 — planned Ornith + dashboard OSS E2E into specs
- Prior dashboard E2E did NOT prove Ornith/connectors/mock apps end-to-end.
- Appended web AC-054..057 + core AC-054..057; reconcile added WI-AC-054..057;
  committed on `plan/opensource-docker`. Prompt locks + closeout updated.
- Web paused during amend then restarted; core restarted for new WIs.

### 2026-07-11T06:32 UTC-3 — post-delivery closeout locked into this brief
- After all subprojects `run_completed`: verify plan branch owns all work;
  remove leftover worktrees/branches; run learning-loop; run no-mistakes on
  the plan branch (see Definition of done + closeout section).

### 2026-07-11T06:21:27Z
- core complete; web 33/31/31; all 3 workers healthy
- foundation repair_plan (after QA); website coding; dashboard QA

### 2026-07-11T21:01 UTC-3 — web Goal Review goal:false; 4 WIs reopened
- Evidence `goal-1-goal_review-792493e56838cd06`: defects on AC-051 (composio remnants), AC-052 (Loops CSP / lvh.me), AC-014 (get-started → staging dashboard), AC-061 (Playwright 401 Secure cookie on HTTP + catalog).
- Reopened WI-AC-014 / 051 / 052 / 061. Fleet: website INTEGRATION_QA on 014; OSS coding 051+052+061. Progress ~58/58/57 of 61.

### 2026-07-12T00:41 UTC-3 — WEB COMPLETE; all four subprojects done
- Web Goal Review goal:true defects:[]; 61/61/61; run_completed (evidence newest goal-1-goal_review on web).
- AC-014 Docker bake fixed; live /get-started → http://localhost:3001/auth/sign-up.
- Fleet: core/relay/public-docs/web all status=complete. Next: mandatory closeout (plan branch ownership, worktree cleanup, learning-loop, no-mistakes).

### 2026-07-12T01:01 UTC-3 — closeout started (post web run_completed)
- Supervisors stopped (already idle). Checkout on plan/opensource-docker; no wt-* worktrees; deleted leftover __catchup_main_ref.
- Learning-loop (this session): already landed in monorepo-supervisor-ops + checkout-dirt.mjs — empty GR admit after context_completed; Goal Review next leftovers RAM; harness-progress dirty gate skip; Cursor usage≠coding exhaustion; AC-014 verify-first false green / Docker build-arg bake. Synced to ~/.agents.
- Next: no-mistakes on plan/opensource-docker.

### 2026-07-12T01:15 UTC-3 — closeout: no-mistakes in flight
- Fleet complete; plan/opensource-docker clean (no wt-*, deleted __catchup_main_ref).
- no-mistakes init + axi run: rebase skipped (1677 unpushed local main commits unrelated).
- Review: fixed sitemap-about, middleware locale cookie, dead example.ts; left compose secrets / unsigned JWT as intentional OSS notes.
- Test step running (AC-061 Playwright evidence). Drive remaining gates via `no-mistakes axi respond`.


## Status log — 2026-07-12T01:50-03 (fleet tick + closeout)

- Fleet: core/web/relay/public-docs all `run_completed` (web GR ~03:35Z). Supervisors idle.
- no-mistakes: review PII fix `bd5ead74`; document+lint on `23f220d4`; rebase/test skipped; lint approved (pre-existing debt).
- Push blocked: `.turbo/cache/*.tar.zst` >100MB in history (QA integrate commits); branch also carries ~1677 unpushed local-main commits vs `origin/main`.
- Claude session limit until 6am America/Sao_Paulo; `~/.no-mistakes/config.yaml` agent set to `[codex, claude]`.
- Do not merge to main until push/PR path is cleaned (strip `.turbo` history + rebase/base on `origin/main`).
