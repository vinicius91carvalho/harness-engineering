---
name: grilling
description: Stress-test a plan one decision at a time — ambiguous requirements, architectural trade-offs, and edge cases — until the Completion Contract is predictable.
---

# Grilling

Interview the user about unresolved design decisions **one question at a time**.
Give your recommended answer with each question.
Inspect the repository instead of asking anything the code can answer.
Continue until the plan is explicit enough that a fresh agent can implement and QA it without further product Q&A.

Grilling is how the planner makes the Project Goal predictable and the Completion Contract straightforward to achieve.
Do not treat it as optional polish.

## Mandatory coverage (all three)

Before a plan is ready, grill until each area below is either **resolved in the specification** or **explicitly out of scope with a recorded reason**.

### 1. Ambiguous requirements

Anything a second reader could interpret two ways that would change Acceptance Checks, UX, data shape, auth, or failure behavior.

Examples: who the actor is, what “done” looks like, soft vs hard deletes, guest vs signed-in, offline behavior, empty states, sorting defaults, timezone, locale, idempotency.

For each ambiguity: state the interpretations, recommend one, capture the choice and why in the specification, point at the Acceptance Check IDs that prove it, and add or update the canonical term under `<domain><glossary>` when vocabulary was fuzzy.

### 2. Architectural trade-offs

Any choice with two or more viable approaches that changes stack, boundaries, persistence, integration shape, or operational cost.

Examples: monolith vs split services, SQLite vs Postgres, REST vs realtime, sync vs async jobs, which system owns auth, local stub vs required cloud dependency.

For each trade-off: propose 2–3 concrete options with costs/benefits, recommend one, record choice + rationale in the specification (usually `technology_stack`, `integrations`, or `planning_decisions`), and ensure dependent Acceptance Checks assume that choice.

### 3. Edge cases

In-scope failure and boundary behaviors that users or QA will hit and that would otherwise become mid-build Input Requests.

Examples: empty input, max length, duplicate submit, expired session, missing dependency, partial failure of an integration, concurrent edit, first-run vs returning user, permission denied, not-found.

For each in-scope edge case: write an observable Acceptance Check (or attach it to an existing check’s description with a clear expected result).
Out-of-scope edge cases must be listed with an explicit deferral reason — never silently omitted.

## Interview rules

1. One question at a time; one recommended answer each time.
2. Prefer the host’s native question tool with 2–3 concrete options when the user is unsure.
3. Answer from the repo or domain docs when possible; only ask what the tree cannot decide.
4. Do not advance to implementation detail that the generator should invent; stay at behavior and architecture that Acceptance Checks must pin down.
5. Stop only when the **Ready Gate** below is satisfied.

## Ready Gate

The plan is ready for review/finalize (and then `/generator`) only when:

- No open ambiguity would change an Acceptance Check if resolved later.
- Every material architectural trade-off has a recorded choice and rationale.
- Every in-scope edge case maps to at least one Acceptance Check ID.
- A fresh agent could judge pass/fail of the Completion Contract without asking the user product questions.

If any gate fails, keep grilling.
Do not write or finalize `project_specs.xml` while the gate fails.
