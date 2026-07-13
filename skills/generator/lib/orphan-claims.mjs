/** Pure Run State / Claim lease health helpers (no I/O). */

import {
  classifyRunStateHealth,
  isLiveRunOwner,
  processAlive,
} from './runtime-view.mjs'

const RUNNINGISH_STATUSES = new Set(['running', 'starting', 'resuming'])
const DEFAULT_ACTIVE_CLAIM_STATUSES = ['building']

export { classifyRunStateHealth, isLiveRunOwner, processAlive }

/**
 * Contexts with building-ish claims or running-ish Run State and dead PIDs.
 * @param {object} args
 * @param {Record<string, object>} args.claims
 * @param {Record<string, object>} args.runStatesByContext keyed by context
 * @param {(pid: *) => boolean} [args.processAlive]
 * @param {string[]} [args.activeClaimStatuses]
 */
export function listGhostClaims({
  claims = {},
  runStatesByContext = {},
  processAlive: alive = processAlive,
  activeClaimStatuses = DEFAULT_ACTIVE_CLAIM_STATUSES,
} = {}) {
  const ghosts = []
  const seen = new Set()
  const activeStatuses = new Set(activeClaimStatuses)

  for (const [key, claim] of Object.entries(claims)) {
    const context = claim?.context || key
    const runState = runStatesByContext[context] || runStatesByContext[key] || null
    const claimActive = activeStatuses.has(claim?.status)
    const health = classifyRunStateHealth(runState || {}, alive)
    if (health.health !== 'ghost') continue
    if (!claimActive && !RUNNINGISH_STATUSES.has(String(runState?.status || ''))) continue
    seen.add(context)
    ghosts.push({ context, key, claim, runState, health })
  }

  for (const [context, runState] of Object.entries(runStatesByContext)) {
    if (seen.has(context)) continue
    const health = classifyRunStateHealth(runState, alive)
    if (health.health !== 'ghost') continue
    ghosts.push({ context, key: context, claim: null, runState, health })
  }

  return ghosts
}

/** Returns a patched Run State marked abandoned (pure). */
export function abandonGhostRun(runState, { reason = 'ghost: owner/child PID dead', at = null } = {}) {
  const abandonedAt = at || new Date().toISOString()
  if (!runState || typeof runState !== 'object') {
    return {
      status: 'abandoned',
      phase: 'abandoned',
      abandonedAt,
      abandonReason: reason,
      ownerPid: null,
      childPid: null,
    }
  }
  return {
    ...runState,
    status: 'abandoned',
    phase: runState.phase || 'abandoned',
    abandonedAt,
    abandonReason: reason,
    ownerPid: null,
    childPid: null,
  }
}
