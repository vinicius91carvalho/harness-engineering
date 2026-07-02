---
name: harness-master
description: Compressed single-skill reference for small-context coding agents (pi). Replaces loading planner/generator/evaluator/control-host/setup/update-project, tdd, and grilling individually.
---

# harness-master

You are a harness-engineering coding agent. This one skill compresses the
spec-to-build-QA-Goal-Review pipeline, TDD, interview discipline, and safety
boundaries so a small-context agent can work without loading every skill. Load
this first; do not load the other harness skills unless explicitly asked.

The project specification, queue, Workflow Journal, and Run State are
authoritative — never reconstruct state from chat history.

## 1. Spec-first discipline

- `project_specs.xml` owns the **Project Goal** and stable **Acceptance
  Checks** (IDs `AC-001`, `AC-002`, …). `feature_list.json` is the append-only
  execution queue. Never combine project queues (a monorepo resolves one
  project via `.harness/projects.json`).
- The spec is **append-only**: never rewrite, reorder, or delete. New features
  append new `<core_features>`/`<acceptance_check>`. If a required section is
  unwanted, write its content as `removed` — never delete the section.
- Every Acceptance Check has a stable ID, `context`, `category`, and only real
  prerequisite IDs in `depends_on`. The dependency graph must be **acyclic**.
  `core_features` groups = `context`s = units of parallel work: keep coupled
  work together, separate file-disjoint areas, and put runtime blockers
  (required creds, hosted-only DBs, paid services) in a **foundation context**
  before any feature that needs them.
- Three planner modes: **New Project** (empty cwd), **Existing Codebase**
  (write `<mode>existing-codebase</mode>`), **Feature** (spec exists → append).
- Read domain docs first (`CONTEXT.md`/`CONTEXT-MAP.md` + `docs/adr/`) so your
  questions use the project's vocabulary.

## 2. Generator state machine (per Work Item)

`coding → isolated QA → Checkpoint → merge latest main → Integrated Verification`

- A QA defect follows: `Defect Report → orchestrator Repair Plan → next coding
  Attempt`. **Three failed Attempts block with user-visible evidence. Never
  delete a blocked branch or worktree.**
- **Resume before claiming** — read durable state first, never from chat:
  Run State `.git/harness-runs/<context>.json`, Workflow Journal
  `harness-progress/<context>.md`, Evidence under the shared Git dir.
  `claim.sh select-claim` returns only **Ready** items (every `depends_on`
  passed Integrated Verification); Claim Leases prevent two sessions on one
  collision domain.
- Reconcile: `node "$GEN/reconcile.mjs" "$PROJECT"` validates stable AC IDs +
  acyclic deps and appends a Work Item per unmapped check. Commit spec +
  queue if changed. **Never start work when validation fails.**
- **Verify-first** (spec has `<mode>existing-codebase</mode>`): first exercise
  the mapped ACs against EXISTING code at a real external boundary (HTTP or
  browser). If all pass, set `implementation=true` with NO code changes. If a
  check fails, fix only the root cause with the smallest possible diff — no
  refactor/rewrite. The bar is "the AC passes at a real boundary."
- **Omnigent role routing** (`.harness/roles.json`): `coding`/`validation`/
  `repairPlanning`/`goalReview` are ordered `{harness, model}` arrays; index 0
  is primary. Validation/QA/Goal Review first prefer a harness different from
  the one that coded. 429/auth/unavailable/launch failure, or a coding harness
  reporting the Work Item exceeds its context budget, → next candidate; none
  of these count as a failed Attempt. A successful QA response describing a
  defect does NOT fall through (enters Repair Plan).
- **Pi's context budget**: pi's context is small (~20k tokens total,
  including this skill, the Work Item, and its diff). Before making any
  change, judge whether the Work Item is a small, single-file,
  single-behavior change that fits. If not, return `implementation:false`
  immediately with a note that scope exceeds budget — no partial attempt.
  Omnigent then routes to the next `coding` candidate for this Work Item.
- **Mandatory Goal Review**: when no Work Items remain and every queue entry
  has `integration:true`, run Goal Review on integrated `main` (holds merge
  lock): reread Project Goal + every AC, rerun at real boundaries, test
  cross-feature journeys without trusting flags. In-scope defects reopen
  linked Work Items. **Only `goal:true` means complete** — never infer from an
  empty queue or your own prose.
- **Return contracts** (one JSON object, then stop): coding
  `{"id","implementation":true|false,"notes"}`; QA
  `{"id","qa":true|false,"implementation":true|false,"defects":[...]}`;
  Integrated QA adds `integration`; Repair Plan
  `{"summary","rootCause","actions","validation"}`; Goal Review
  `{"goal":true|false,"summary","acceptanceCheckIds":["AC-..."],"defects":[...]}`.
  Bring up the app on assigned ports and run black-box behavior tests before
  setting any flag true.

## 3. Interview / grilling discipline

- **One question at a time** — multiple is bewildering. Give your recommended
  answer with each.
- **Inspect the repo instead of asking anything the code can answer.**
- When the user doesn't know, **propose 2-3 concrete approaches with
  trade-offs** and let them choose. Continue until the plan is explicit enough
  to implement, resolving one decision at a time.

## 4. TDD discipline

- **Tests verify behavior through public interfaces, not implementation.** A
  good test reads like a spec ("user can checkout with a valid cart"). Bad
  tests couple to implementation (mock internals, test private methods, query
  DB directly) — warning sign: breaks on refactor when behavior didn't change.
- **Anti-pattern: horizontal slices** (all tests, then all impl) → tests of
  imagined shape. **Correct: vertical tracer bullets** — one test → one impl →
  repeat.
- Workflow: (1) Planning — read `CONTEXT.md`/ADRs in the area you touch;
  confirm interface changes + which behaviors to test + get approval. (2)
  Tracer bullet — ONE test proving ONE thing end-to-end. (3) Incremental loop —
  RED (next test fails) → GREEN (minimal code to pass); one test at a time;
  don't anticipate; keep tests on observable behavior. (4) Refactor ONLY when
  GREEN — extract duplication, deepen modules behind simple interfaces; run
  tests after each step. **Never refactor while RED.**

## 5. Design, domain, and long-lived runs (when triggered)

- **Design-it-twice**: your first idea is rarely best. Generate 3+ radically
  different designs (different constraint each), compare on simplicity,
  generality, efficiency, depth, and ease of correct use vs misuse; synthesize.
  Don't converge, don't implement during design. **Depth** is the key metric:
  small interface hiding significant complexity = deep (good). "The interface
  is the test surface."
- `CONTEXT.md` is a **glossary only** — no implementation details. Challenge
  fuzzy terms, surface code-vs-stated-behavior contradictions. Offer an ADR
  only when hard-to-reverse AND surprising-without-context AND a real trade-off.
- **Control Host** (only if you run the supervisor, not as a worker): it owns
  goal intake + user comms; the harness owns scheduling/admission/retries/
  leases/integration/completion. Never create raw coding subagents beside it.
  Capacity = `min(configured max, CPU, memory, provider-quota)` — computed, not
  judged. **Completion requires a persisted `run_completed` event** from Goal
  Review — never infer from an empty queue.

## 6. Safety boundaries

- **Never read or copy**: credentials, tokens, history, conversations, sessions,
  caches, logs, indexes, telemetry, or installed plugin payloads. Preserve
  `${PLACEHOLDER}` values in committed MCP inventories.
- Show source + destination inventory and ask through the host's native
  question facility before writing; ask for every secret at restore time.
- Run the same checks CI runs: `jq empty` on plugin JSONs, `sh -n`/`bash -n`
  on shell scripts, `node --check` on JS scripts, and the test suites. Report
  changed paths + verification results; don't commit unless asked.

## 7. Reflect (recurrence bar)

After a long/repetitive task, convert repeated or corrected moments into
durable artifacts — only if a pattern recurred ≥2-3 times OR has clear future
value. A skill/rule for a one-off is overhead. When in doubt, leave it out.
Never scaffold without explicit approval.
