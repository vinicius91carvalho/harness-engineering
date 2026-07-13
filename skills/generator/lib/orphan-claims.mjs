/** Pure Run State / Claim lease health helpers (no I/O). */

const TERMINAL_STATUSES = new Set(['complete', 'blocked', 'failed', 'abandoned'])
const RUNNINGISH_STATUSES = new Set(['running', 'starting', 'resuming'])
const DEFAULT_ACTIVE_CLAIM_STATUSES = ['building']

function defaultProcessAlive(pid) {
  if (!Number(pid)) return false
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}

/** True when ownerPid or childPid is alive. */
export function isLiveRunOwner(runState, processAlive = defaultProcessAlive) {
  if (!runState || typeof runState !== 'object') return false
  const alive = processAlive || defaultProcessAlive
  return Boolean(alive(runState.ownerPid) || alive(runState.childPid))
}

/**
 * Classify Run State health for supervisor recovery.
 * @returns {{ health: 'live'|'ghost'|'idle'|'terminal', status?: string, phase?: string, reason?: string, ownerPid?: *, childPid?: * }}
 */
export function classifyRunStateHealth(runState, processAlive = defaultProcessAlive) {
  if (!runState || typeof runState !== 'object') {
    return { health: 'idle', reason: 'no-run-state' }
  }

  const alive = processAlive || defaultProcessAlive
  const status = String(runState.status || '')
  const phase = String(runState.phase || '')

  if (TERMINAL_STATUSES.has(status)) {
    return { health: 'terminal', status, phase }
  }

  if (isLiveRunOwner(runState, alive)) {
    return {
      health: 'live',
      status,
      phase,
      ownerPid: runState.ownerPid ?? null,
      childPid: runState.childPid ?? null,
    }
  }

  const hadPid = Boolean(runState.ownerPid || runState.childPid)
  const runningish = RUNNINGISH_STATUSES.has(status) || (status === 'claimed' && hadPid)

  if (runningish) {
    return {
      health: 'ghost',
      status,
      phase,
      ownerPid: runState.ownerPid ?? null,
      childPid: runState.childPid ?? null,
      reason: 'dead-owner-or-child',
    }
  }

  if (status === 'claimed' || phase === 'claimed') {
    return { health: 'idle', status, phase, reason: 'awaiting-orchestrator' }
  }

  return { health: 'idle', status, phase }
}

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
  processAlive = defaultProcessAlive,
  activeClaimStatuses = DEFAULT_ACTIVE_CLAIM_STATUSES,
} = {}) {
  const ghosts = []
  const seen = new Set()
  const activeStatuses = new Set(activeClaimStatuses)

  for (const [key, claim] of Object.entries(claims)) {
    const context = claim?.context || key
    const runState = runStatesByContext[context] || runStatesByContext[key] || null
    const claimActive = activeStatuses.has(claim?.status)
    const health = classifyRunStateHealth(runState || {}, processAlive)
    if (health.health !== 'ghost') continue
    if (!claimActive && !RUNNINGISH_STATUSES.has(String(runState?.status || ''))) continue
    seen.add(context)
    ghosts.push({ context, key, claim, runState, health })
  }

  for (const [context, runState] of Object.entries(runStatesByContext)) {
    if (seen.has(context)) continue
    const health = classifyRunStateHealth(runState, processAlive)
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
