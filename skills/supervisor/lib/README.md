# Supervisor Control Plane libraries

Control-owned modules live here (ADR-0007 / ADR-0009 / ADR-0022).
`harness-control.mjs` is the I/O adapter: it loads control modules from this
directory and shared execution primitives from `skills/generator/lib/`.

## Control modules (this directory)

| Module | Role |
| --- | --- |
| `control-journal.mjs` | Append-only Control Journal |
| `control-beacon.mjs` | Soft-stop / turn-end drain gates |
| `fleet-snapshot.mjs` | Fleet Snapshot + runtime-recovery planners |
| `supervisor-tick.mjs` | Pure tick delay / watch / retry-drain helpers |
| `supervisor-admission.mjs` | Post-drain admission planner |
| `wake-triage.mjs` | Event wake / fold / absorb |
| `supervisor-lease.mjs` | Fenced Supervisor Lease |
| `resource-governor.mjs` | Host-wide Resource Governor |
| `host-resources.mjs` | Host CPU/memory/load snapshot |
| `orphan-claims.mjs` | Ghost claim / Run State health helpers |
| `runtime-view.mjs` | Canonical runtime health vocabulary |
| `supervisor-preflight.mjs` | Fail-closed first-start repair |

Tick planners belong under this package; harness-control only applies them.

## Shared execution primitives (`skills/generator/lib`)

Claim Lease, Execution Ledger, worker outcome/lifecycle, failure policy,
worktree teardown, compose share, git/repo helpers, evidence, completion
contract, topology, and related modules remain under generator.
