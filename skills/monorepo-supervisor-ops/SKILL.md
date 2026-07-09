---
name: monorepo-supervisor-ops
description: Operate multiple harness supervisors in one monorepo (herdr tabs, leases, merge lock, restart without wiping workers). Use when restarting supervisors, injecting retry guidance, diagnosing empty/zombie panes, or syncing harness skills to ~/.agents.
---

# Monorepo supervisor ops

Use this when several subprojects share one Git top-level (e.g. `core`, `web`,
`relay`, `public-docs`) and each runs its own `harness-control.mjs` supervisor.

## Hard rules

1. Edit harness code / installed skills only unless the operator says otherwise.
2. Do not commit unless asked.
3. Pane/tab cleanup is **per project** (`worker-<project>-*`). Never close sibling supervisors' workers.
4. Supervisor exit must **not** close live herdr tabs — orchestrators outlive the supervisor; `rehydrateHerdrWorkers` reattaches them.
5. Shared merge lock (`.git/harness-locks/generator-merge`) is normal — one integrator at a time.

## Sync harness changes to live skills

After editing in the harness-engineering repo:

```bash
cp skills/generator/lib/{agent-spawn,agent-stream,supervisor-auto-respond}.mjs ~/.agents/skills/generator/lib/
cp skills/generator/prompts/feature.mjs ~/.agents/skills/generator/prompts/
cp skills/generator/orchestrator.mjs ~/.agents/skills/generator/
cp skills/supervisor/scripts/harness-control.mjs ~/.agents/skills/supervisor/scripts/
cp skills/supervisor/lib/herdr-spawn.mjs ~/.agents/skills/supervisor/lib/
```

Recycle orchestrators (`SIGTERM`) so new spawn/stream/prompt code loads.
Prefer `kill -9` on old supervisors so their `stop()` path does not close tabs.

## Restart one subproject supervisor (keep workers)

```bash
CONTROL=~/.agents/skills/supervisor/scripts/harness-control.mjs
REPO=/path/to/monorepo/<subproject>
STATE=/path/to/monorepo/.git/harness-control/<subproject>/state.json

# Optional: seed custom guidance before start (wins over auto-retry generics)
# Set retryQueue[context].guidance in state.json, clear workers={}, supervisorPid=null
# Neutralize pending inputs for that context so auto-respond cannot race.

kill -9 "$(jq -r .supervisorPid "$STATE")"
rm -rf /path/to/monorepo/.git/harness-control/<subproject>/supervisor.lock
node "$CONTROL" start --repo "$REPO" --host pi --display herdr \
  --max-workers 2 --quota-workers 2 --cpu-per-worker 1 \
  --memory-per-worker-mb 1024 --reserve-memory-mb 1024 --summary-minutes 20
```

## Inject guidance without losing it

1. Write `state.retryQueue[context] = { guidance, attempts: 0 }` **before** the worker exits, or
2. `harness-control.mjs respond --repo … --event <id> --action retry --guidance "…"`, or
3. Rely on the rule: existing `retryQueue` guidance is preserved when `response.auto` is true.

## Diagnose stuck / empty workers

| Symptom | Check |
|---|---|
| Progress near done, one WI looping | Run state `phase` / `currentFeatureId`; pane shows endless `thinking:` |
| Static AC but Mintlify/browser up | QA prompt must follow AC observation method — kill mint, restart with audit guidance |
| `status` has workers, herdr empty | Zombie pane IDs — restart supervisors; confirm project-scoped cleanup |
| Goal review exits with code 1 | Often merge lock wait — not a product failure |
| Memory pressure / `Session terminated` | Lower `--max-workers` / `--memory-per-worker-mb`; kill heavy mint/docker leftovers |

## Herdr layout

One tab per worker. Label: `{taskId} - {role} - {project} - r{retry}`.
Close the **tab** when the worker finishes (not only the pane).
Agent sidebar name remains `worker-<project>-<context>`.

## Status poll (20-min tick)

For each subproject: `harness-control status`, open goal-scoped inputs only,
`herdr agent list`, free memory. Act only on dead supervisors or goal-scoped
`input_required` that auto-retry cannot handle.
