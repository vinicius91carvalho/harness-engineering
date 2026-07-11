# Wake Triage (Strong #1)

## Attempt 1
- Outcome: Implemented `skills/generator/lib/wake-triage.mjs` with classify/shouldWake/foldProgress; wired thin `wakeTriage` hints into harness-control `events` and `status`; added lib tests; supervisor SKILL bullet.
- Evidence: `node --test tests/lib_test.mjs` (79 pass, 0 fail).
- Next: QA re-run Acceptance Checks at boundary.
