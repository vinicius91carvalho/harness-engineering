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

/**
 * Build one project's fleet bearings from harness-control state + journal tip.
 * @param {object} input
 * @param {string} [input.id]
 * @param {string} [input.root]
 * @param {object} [input.state]
 * @param {number} [input.eventsTip]
 * @param {{ shouldWake?: boolean }} [input.wakeTriage]
 */
export function buildProjectSnapshot({
  id = 'root',
  root = null,
  state = {},
  eventsTip = 0,
  wakeTriage = null,
} = {}) {
  const activeWorkers = activeWorkerRows(state)
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
  }
  if (wakeTriage && typeof wakeTriage.shouldWake === 'boolean') {
    snapshot.wakeTriage = { shouldWake: wakeTriage.shouldWake }
  }
  return snapshot
}

/**
 * Multi-project fleet snapshot from preloaded control state per project.
 * @param {{ projects: Array<{ id?: string, root?: string, state?: object, eventsTip?: number, wakeTriage?: object }> }} input
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
 */
export function fleetSnapshotFromState(state = {}) {
  const activeWorkers = activeWorkerRows(state)
  return {
    workers: activeWorkers.length,
    counts: state.progress || {},
    pendingInputs: pendingInputCount(state),
    retryQueueSize: Object.keys(state.retryQueue || {}).length,
    status: state.status || '',
    capacity: state.capacity || null,
  }
}
