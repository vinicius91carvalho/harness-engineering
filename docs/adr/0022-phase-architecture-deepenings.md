# Phase architecture deepenings in waves

Status: Accepted
Date: 2026-07-16

Ship architecture deepenings as phased waves.
Neither a mega-refactor nor opportunistic-only cleanup.

Vocabulary stays in `CONTEXT.md`.
Each wave must leave CI green.

**Wave A.** Shallow module folds, docs/vocab alignment, and the tick-watch self-wake fix (do not watch `controlRoot`).
Keep `herdr-notify` as an opaque journal consumer id; no rename required for Wave A.

**Wave B.** Install/catalog becomes the sole write path.
Generate the marketplace triad from the catalog.
`AGENTS.md` is canonical; `CLAUDE.md` is projected from it.

**Wave C.** Deepen the Supervisor Control Plane.
Relocate control modules out of `skills/generator/lib` into supervisor/runtime package locality.
Clean break: supervisor/runtime owns control-plane modules; no permanent dual-home shims in generator.

**Wave D.** Deepen Worktree Runtime Lifecycle (`init.sh` interface) and Shared Runtime Lease (ADR-0021).
Split the Claim Lease megamodule.

**Wave E.** Planner, setup, and evaluator ownership: spec-finalize, projects-registry sole writer, `detectProjectBoundaries`, and goal-review CLI.

Ops skills deepen around the Fleet Snapshot interface.
Do not dump monorepo narrative into `harness-control` (ADR-0020).
