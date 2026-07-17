/**
 * Structured cross-project fleet bearings (ADR-0020).
 * Pure JSON builder — does not read sibling control dirs ad hoc.
 */

import { processAlive as defaultProcessAlive, resolveWorkerLive } from './runtime-view.mjs'

export const FLEET_SNAPSHOT_SCHEMA = 'harness-fleet-snapshot.v1'

/** Pure recovery planner for dead runtime / empty-fleet mechanics. */

export function planRuntimeRecovery({
  active = 0,
  fleet = {},
  ghostClaims = [],
  staleLocks = [],
  crashCounts = {},
  snapshotCounts = {},
  pressureReason = null,
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
      pressureReason: pressureReason ?? null,
      remaining: snapshotCounts || {},
    },
    immediate: !repaired,
  })

  return { actions, events, statePatch, repaired, emptyFleetActionable: true }
}

export function shouldEmitEmptyFleet(last, detail, now, windowMs = 60_000) {
  if (!last || JSON.stringify(last.detail) !== JSON.stringify(detail)) return true
  return now - last.at >= windowMs
}

function activeWorkerRows(state = {}, { processAlive = defaultProcessAlive } = {}) {
  const workers = state.workers && typeof state.workers === 'object' ? state.workers : {}
  return Object.entries(workers)
    .filter(([, worker]) => {
      const pid = worker?.childPid || worker?.pid
      return !pid || resolveWorkerLive(worker, { processAlive })
    })
    .map(([context, worker]) => ({
      context,
      type: worker?.type || 'background',
      pid: worker?.pid || null,
      childPid: worker?.childPid || null,
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
    activeCost: capacity.activeCost ?? null,
    pressureReason: capacity.pressureReason ?? null,
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
  const fleet = fleetSnapshot && typeof fleetSnapshot === 'object' ? fleetSnapshot : {}
  if (Number(fleet.workers ?? 0) > 0) return false
  const status = String(fleet.status || '')
  if (status === 'complete' || status === 'stopped') return false
  if (fleet.retryGoalReview) return true
  if (!queueCompleteInFleet(fleet)) return false
  const integrationHead = String(fleet.integrationHead || '')
  const reviewedHead = String(fleet.reviewedHead || '')
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
  const fleet = fleetSnapshot && typeof fleetSnapshot === 'object' ? fleetSnapshot : {}
  // Prefer the higher count: progress events may under-count (state.workers={}
  // after recycle) while fleetSnapshot includes liveClaimWorkers.
  const workers = Math.max(
    Number(event?.workers ?? 0) || 0,
    Number(fleet.workers ?? 0) || 0,
  )
  if (workers > 0) return false

  const status = String(fleet.status || '')
  if (status === 'complete' || status === 'stopped') return false

  const counts = progressCounts(event, fleet)
  const blocked = Number(counts.blocked ?? 0)
  const remaining = remainingWork(counts)
  const pendingInputs = Number(fleet.pendingInputs ?? 0)
  const retryQueueSize = Number(fleet.retryQueueSize ?? 0)

  if (needsGoalReviewRetry(fleet)) return true
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

/** True when tick repair cleared ghosts, spawned workers, or marked repaired on the event. */
export function isEmptyFleetRepaired(fleetSnapshot = {}) {
  if (fleetSnapshot.repaired === true) return true
  if (Number(fleetSnapshot.workers ?? 0) > 0) return true
  // Claim-less Goal Review / external orchestrators count as live workers even
  // when state.workers={} — do not re-wake Control Host after ops-remediate.
  if (Number(fleetSnapshot.liveClaimWorkers ?? 0) > 0) return true
  return false
}

function compactFleetShape(state = {}, extras = {}, { processAlive = defaultProcessAlive } = {}) {
  const activeWorkers = activeWorkerRows(state, { processAlive })
  const liveClaimWorkers = Math.max(0, Number(extras.liveClaimWorkers || 0))
  return {
    workers: Math.max(activeWorkers.length, liveClaimWorkers),
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
  liveClaimWorkers = 0,
  supervisorLive,
  processAlive,
  localHost = '',
  leaseSeconds = 30,
} = {}) {
  const fleet = compactFleetShape(state, {
    ...wakeExtended,
    ghostClaims,
    liveClaimWorkers: Math.max(0, Number(liveClaimWorkers || wakeExtended.liveClaimWorkers || 0)),
  }, { processAlive })
  const live = typeof supervisorLive === 'boolean'
    ? supervisorLive
    : deriveSupervisorLive(state, { processAlive, localHost, leaseSeconds })
  return {
    supervisorLive: live,
    ghostClaims: Array.isArray(ghostClaims) ? ghostClaims : [],
    emptyFleetActionable: isEmptyFleetActionable(null, fleet),
    needsGoalReviewRetry: needsGoalReviewRetry(fleet),
    lastRunCompletedSummary: lastRunCompletedSummaryFromEvents(events),
    liveClaimWorkers: fleet.workers,
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
 * @param {number} [input.liveClaimWorkers] live Claim Lease / orchestrator count
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
  liveClaimWorkers = 0,
  emptyFleetActionable,
  needsGoalReviewRetry: needsGoalReviewRetryFlag,
  lastRunCompletedSummary,
  wakeTriage = null,
  wakeExtended = null,
  hostResources = null,
  governorReservations = null,
  sharedRuntime = null,
  recoveryReasons = [],
  pressureAdvice = null,
  staleLocks = [],
  deadRuntime = [],
  processAlive,
  localHost = '',
  leaseSeconds = 30,
} = {}) {
  const activeWorkers = activeWorkerRows(state, { processAlive })
  const liveClaims = Math.max(0, Number(liveClaimWorkers || 0))
  const ops = fleetOpsFields({
    state,
    events,
    ghostClaims: ghostClaims ?? [],
    wakeExtended: wakeExtended || {},
    liveClaimWorkers: liveClaims,
    supervisorLive,
    processAlive,
    localHost,
    leaseSeconds,
  })
  const workers = Math.max(activeWorkers.length, liveClaims)
  const snapshot = {
    id,
    root,
    status: state.status || '',
    journalTip: Number(eventsTip) || 0,
    capacity: capacityView(state.capacity),
    activeWorkers,
    workers,
    liveClaimWorkers: liveClaims,
    stuck: stuckRows(state),
    pendingInputs: pendingInputCount(state),
    retryQueueSize: Object.keys(state.retryQueue || {}).length,
    progress: state.progress || {},
    hostResources,
    governorReservations,
    sharedRuntime,
    recoveryReasons: Array.isArray(recoveryReasons) ? recoveryReasons : [],
    pressureAdvice,
    staleLocks: Array.isArray(staleLocks) ? staleLocks : [],
    deadRuntime: Array.isArray(deadRuntime) ? deadRuntime : [],
    supervisorLive: typeof supervisorLive === 'boolean' ? supervisorLive : ops.supervisorLive,
    supervisorPid: state.supervisorPid || null,
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
  const {
    processAlive: alive = defaultProcessAlive,
    ...fleetExtras
  } = extras || {}
  const fleet = compactFleetShape(state, fleetExtras, { processAlive: alive })
  const ops = fleetOpsFields({
    state,
    events: fleetExtras.events || [],
    ghostClaims: fleetExtras.ghostClaims ?? [],
    wakeExtended: fleetExtras,
    liveClaimWorkers: fleetExtras.liveClaimWorkers || 0,
    supervisorLive: fleetExtras.supervisorLive,
    processAlive: alive,
    localHost: fleetExtras.localHost || '',
    leaseSeconds: fleetExtras.leaseSeconds,
  })
  return {
    ...fleet,
    workers: Math.max(fleet.workers, Number(fleetExtras.liveClaimWorkers || 0)),
    liveClaimWorkers: Number(fleetExtras.liveClaimWorkers || 0),
    hostResources: fleetExtras.hostResources ?? null,
    governorReservations: fleetExtras.governorReservations ?? null,
    sharedRuntime: fleetExtras.sharedRuntime ?? null,
    recoveryReasons: Array.isArray(fleetExtras.recoveryReasons) ? fleetExtras.recoveryReasons : [],
    pressureAdvice: fleetExtras.pressureAdvice ?? null,
    staleLocks: Array.isArray(fleetExtras.staleLocks) ? fleetExtras.staleLocks : [],
    deadRuntime: Array.isArray(fleetExtras.deadRuntime) ? fleetExtras.deadRuntime : [],
    supervisorLive: fleetExtras.supervisorLive ?? ops.supervisorLive,
    ghostClaims: fleetExtras.ghostClaims ?? ops.ghostClaims,
    emptyFleetActionable: fleetExtras.emptyFleetActionable ?? ops.emptyFleetActionable,
    needsGoalReviewRetry: fleetExtras.needsGoalReviewRetry ?? ops.needsGoalReviewRetry,
    lastRunCompletedSummary: fleetExtras.lastRunCompletedSummary ?? ops.lastRunCompletedSummary,
  }
}
