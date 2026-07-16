/** Pure recovery planner for dead runtime / empty-fleet mechanics. */

export function planRuntimeRecovery({
  active = 0,
  fleet = {},
  ghostClaims = [],
  staleLocks = [],
  crashCounts = {},
  snapshotCounts = {},
} = {}) {
  const actions = []
  const events = []
  const statePatch = {}
  const ghosts = Array.isArray(ghostClaims) ? ghostClaims : []
  const locks = Array.isArray(staleLocks) ? staleLocks : []
  const emptyFleetActionable = active <= 0 && fleet?.emptyFleetActionable === true

  if (!emptyFleetActionable) {
    return { actions, events, statePatch, repaired: false, emptyFleetActionable: false }
  }

  for (const lock of locks) {
    actions.push({ kind: 'stale_lock_cleared', lock: lock.lock, reason: lock.reason })
  }
  for (const ghost of ghosts) {
    actions.push({ kind: 'abandon_ghost', context: ghost.context, reason: ghost.health?.reason || 'ghost runtime' })
  }

  const repaired = actions.length > 0
  if (locks.length > 0 && Object.keys(crashCounts || {}).length > 0) {
    statePatch.crashCounts = {}
    actions.push({ kind: 'reset_crash_counts', reason: 'infra recovery cleared stale runtime blockers' })
  }

  if (ghosts.length > 0 || locks.length > 0) {
    events.push({
      kind: 'dead_runtime',
      detail: {
        ghostContexts: ghosts.map((row) => row.context).filter(Boolean),
        staleLocks: locks.map((row) => row.lock).filter(Boolean),
        repaired,
      },
      immediate: !repaired,
    })
  }
  events.push({
    kind: 'empty_fleet_actionable',
    detail: {
      workers: active,
      ghostCount: ghosts.length,
      repaired,
      remaining: snapshotCounts || {},
    },
    immediate: !repaired,
  })

  return { actions, events, statePatch, repaired, emptyFleetActionable: true }
}
