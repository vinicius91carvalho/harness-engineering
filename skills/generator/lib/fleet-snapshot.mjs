/**
 * Structured cross-project fleet bearings (ADR-0020).
 * Pure JSON builder — does not read sibling control dirs ad hoc.
 */

export const FLEET_SNAPSHOT_SCHEMA = 'harness-fleet-snapshot.v1'

function activeWorkerRows(state = {}) {
  const workers = state.workers && typeof state.workers === 'object' ? state.workers : {}
  return Object.entries(workers).map(([context, worker]) => ({
    context,
    type: worker?.type || null,
    paneId: worker?.paneId || null,
    pid: worker?.pid || null,
    tabId: worker?.tabId || null,
  }))
}

function stuckRows(state = {}) {
  const workerHealth = state.workerHealth && typeof state.workerHealth === 'object'
    ? state.workerHealth
    : {}
  return Object.entries(workerHealth)
    .filter(([, health]) => health?.verdict === 'stuck')
    .map(([context, health]) => ({ context, ...health }))
}

function pendingInputCount(state = {}) {
  return Object.values(state.pendingInputs || {})
    .filter((row) => row?.status === 'pending').length
}

function capacityView(capacity) {
  if (!capacity || typeof capacity !== 'object') return null
  return {
    limit: capacity.limit ?? null,
    available: capacity.available ?? null,
    slots: capacity.slots ?? null,
    active: capacity.active ?? null,
  }
}

function defaultProcessAlive(pid) {
  if (!Number(pid)) return false
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}

function remainingWork(counts = {}) {
  if (counts.remaining != null) return Math.max(0, Number(counts.remaining) || 0)
  const total = Number(counts.total ?? 0)
  const integrated = Number(counts.integrated ?? 0)
  return Math.max(0, total - integrated)
}

export function queueCompleteInFleet(fleetSnapshot = {}) {
  if (fleetSnapshot.queueComplete === true) return true
  const counts = fleetSnapshot.counts || fleetSnapshot.progress || {}
  const total = Number(counts.total ?? 0)
  const integrated = Number(counts.integrated ?? 0)
  return total > 0 && integrated === total
}

/**
 * Empty fleet should wake for Goal Review when the ledger-backed queue is done
 * but reviewedHead is stale, or when a flag-drift retry is queued.
 */
export function needsGoalReviewRetry(fleetSnapshot = {}) {
  if (Number(fleetSnapshot.workers ?? 0) > 0) return false
  const status = String(fleetSnapshot.status || '')
  if (status === 'complete' || status === 'stopped') return false
  if (fleetSnapshot.retryGoalReview) return true
  if (!queueCompleteInFleet(fleetSnapshot)) return false
  const integrationHead = String(fleetSnapshot.integrationHead || '')
  const reviewedHead = String(fleetSnapshot.reviewedHead || '')
  if (!integrationHead) return false
  return !reviewedHead || reviewedHead !== integrationHead
}

function progressCounts(event, fleetSnapshot) {
  if (event?.implemented != null || event?.blocked != null || event?.total != null) return event
  return fleetSnapshot?.counts || fleetSnapshot?.progress || {}
}

/**
 * Empty fleet with remaining work or pending inputs must stay actionable (wake),
 * not auto-absorbed as benign heartbeat noise.
 */
export function isEmptyFleetActionable(event, fleetSnapshot = null) {
  const workers = Number(event?.workers ?? fleetSnapshot?.workers ?? 0)
  if (workers > 0) return false

  const status = String(fleetSnapshot?.status || '')
  if (status === 'complete' || status === 'stopped') return false

  const counts = progressCounts(event, fleetSnapshot)
  const blocked = Number(counts.blocked ?? 0)
  const remaining = remainingWork(counts)
  const pendingInputs = Number(fleetSnapshot?.pendingInputs ?? 0)
  const retryQueueSize = Number(fleetSnapshot?.retryQueueSize ?? 0)

  if (needsGoalReviewRetry(fleetSnapshot)) return true
  return blocked > 0 || remaining > 0 || pendingInputs > 0 || retryQueueSize > 0
}

/** Latest run_completed summary from journal events (newest last). */
export function lastRunCompletedSummaryFromEvents(events = []) {
  if (!Array.isArray(events) || events.length === 0) return null
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.kind !== 'run_completed') continue
    if (typeof event.summary === 'string' && event.summary.trim()) return event.summary
    if (typeof event.detail?.summary === 'string' && event.detail.summary.trim()) return event.detail.summary
    return null
  }
  return null
}

/**
 * Derive supervisorLive from persisted state when caller did not pass it.
 * @param {object} state
 * @param {{ processAlive?: (pid: *) => boolean, localHost?: string, leaseSeconds?: number }} [options]
 */
export function deriveSupervisorLive(state = {}, {
  processAlive = defaultProcessAlive,
  localHost = '',
  leaseSeconds = 30,
} = {}) {
  if (typeof state.supervisorLive === 'boolean') return state.supervisorLive
  const pid = state.supervisorPid
  if (!pid) return false
  if (state.supervisorHost && localHost && state.supervisorHost !== localHost) {
    const heartbeatAge = Math.floor(Date.now() / 1000) - Number(state.heartbeatEpoch || 0)
    return processAlive(pid) || heartbeatAge < Math.max(1, Number(leaseSeconds) || 30)
  }
  return processAlive(pid)
}

function ghostClaimCount(ghostClaims) {
  if (Array.isArray(ghostClaims)) return ghostClaims.length
  if (typeof ghostClaims === 'number') return Math.max(0, ghostClaims)
  return 0
}

/** True when tick repair cleared ghosts, spawned workers, or marked repaired on the event. */
export function isEmptyFleetRepaired(fleetSnapshot = {}) {
  if (fleetSnapshot.repaired === true) return true
  if (Number(fleetSnapshot.workers ?? 0) > 0) return true
  if (Array.isArray(fleetSnapshot.ghostClaims) && fleetSnapshot.ghostClaims.length === 0) return true
  return false
}

function compactFleetShape(state = {}, extras = {}) {
  const activeWorkers = activeWorkerRows(state)
  return {
    workers: activeWorkers.length,
    counts: state.progress || {},
    pendingInputs: pendingInputCount(state),
    retryQueueSize: Object.keys(state.retryQueue || {}).length,
    status: state.status || '',
    capacity: state.capacity || null,
    ...extras,
  }
}

/**
 * Pure ops-bearing fields shared by project snapshots and wake triage fleet shapes.
 */
export function fleetOpsFields({
  state = {},
  events = [],
  ghostClaims = [],
  wakeExtended = {},
  supervisorLive,
  processAlive,
  localHost = '',
  leaseSeconds = 30,
} = {}) {
  const fleet = compactFleetShape(state, { ...wakeExtended, ghostClaims })
  const live = typeof supervisorLive === 'boolean'
    ? supervisorLive
    : deriveSupervisorLive(state, { processAlive, localHost, leaseSeconds })
  return {
    supervisorLive: live,
    ghostClaims: Array.isArray(ghostClaims) ? ghostClaims : [],
    emptyFleetActionable: isEmptyFleetActionable(null, fleet),
    needsGoalReviewRetry: needsGoalReviewRetry(fleet),
    lastRunCompletedSummary: lastRunCompletedSummaryFromEvents(events),
  }
}

/**
 * Build one project's fleet bearings from harness-control state + journal tip.
 * @param {object} input
 * @param {string} [input.id]
 * @param {string} [input.root]
 * @param {object} [input.state]
 * @param {number} [input.eventsTip]
 * @param {Array<object>} [input.events]
 * @param {boolean} [input.supervisorLive]
 * @param {Array<object>|number} [input.ghostClaims]
 * @param {boolean} [input.emptyFleetActionable]
 * @param {boolean} [input.needsGoalReviewRetry]
 * @param {string|null} [input.lastRunCompletedSummary]
 * @param {{ shouldWake?: boolean }} [input.wakeTriage]
 * @param {object} [input.wakeExtended]
 */
export function buildProjectSnapshot({
  id = 'root',
  root = null,
  state = {},
  eventsTip = 0,
  events = [],
  supervisorLive,
  ghostClaims,
  emptyFleetActionable,
  needsGoalReviewRetry: needsGoalReviewRetryFlag,
  lastRunCompletedSummary,
  wakeTriage = null,
  wakeExtended = null,
  processAlive,
  localHost = '',
  leaseSeconds = 30,
} = {}) {
  const activeWorkers = activeWorkerRows(state)
  const ops = fleetOpsFields({
    state,
    events,
    ghostClaims: ghostClaims ?? [],
    wakeExtended: wakeExtended || {},
    supervisorLive,
    processAlive,
    localHost,
    leaseSeconds,
  })
  const snapshot = {
    id,
    root,
    status: state.status || '',
    journalTip: Number(eventsTip) || 0,
    capacity: capacityView(state.capacity),
    activeWorkers,
    workers: activeWorkers.length,
    stuck: stuckRows(state),
    pendingInputs: pendingInputCount(state),
    retryQueueSize: Object.keys(state.retryQueue || {}).length,
    progress: state.progress || {},
    supervisorLive: typeof supervisorLive === 'boolean' ? supervisorLive : ops.supervisorLive,
    ghostClaims: Array.isArray(ghostClaims) ? ghostClaims : ops.ghostClaims,
    emptyFleetActionable: typeof emptyFleetActionable === 'boolean'
      ? emptyFleetActionable
      : ops.emptyFleetActionable,
    needsGoalReviewRetry: typeof needsGoalReviewRetryFlag === 'boolean'
      ? needsGoalReviewRetryFlag
      : ops.needsGoalReviewRetry,
    lastRunCompletedSummary: lastRunCompletedSummary !== undefined
      ? lastRunCompletedSummary
      : ops.lastRunCompletedSummary,
  }
  if (wakeTriage && typeof wakeTriage.shouldWake === 'boolean') {
    snapshot.wakeTriage = { shouldWake: wakeTriage.shouldWake }
  }
  return snapshot
}

/**
 * Multi-project fleet snapshot from preloaded control state per project.
 * @param {{ projects: Array<object> }} input
 */
export function buildFleetSnapshot({ projects } = {}) {
  if (!Array.isArray(projects)) {
    throw new TypeError('buildFleetSnapshot requires { projects: [...] }')
  }
  return {
    schema: FLEET_SNAPSHOT_SCHEMA,
    generatedAt: new Date().toISOString(),
    projects: projects.map((project) => buildProjectSnapshot(project)),
  }
}

/**
 * Compact bearings shape for Wake Triage classifiers.
 * @param {object} state - harness-control state.json
 * @param {object} [extras] - optional ops / wake fields (ghostClaims, integrationHead, repaired, ...)
 */
export function fleetSnapshotFromState(state = {}, extras = {}) {
  const fleet = compactFleetShape(state, extras)
  const ops = fleetOpsFields({
    state,
    events: extras.events || [],
    ghostClaims: extras.ghostClaims ?? [],
    wakeExtended: extras,
    supervisorLive: extras.supervisorLive,
    processAlive: extras.processAlive,
    localHost: extras.localHost || '',
    leaseSeconds: extras.leaseSeconds,
  })
  return {
    ...fleet,
    supervisorLive: extras.supervisorLive ?? ops.supervisorLive,
    ghostClaims: extras.ghostClaims ?? ops.ghostClaims,
    emptyFleetActionable: extras.emptyFleetActionable ?? ops.emptyFleetActionable,
    needsGoalReviewRetry: extras.needsGoalReviewRetry ?? ops.needsGoalReviewRetry,
    lastRunCompletedSummary: extras.lastRunCompletedSummary ?? ops.lastRunCompletedSummary,
  }
}
