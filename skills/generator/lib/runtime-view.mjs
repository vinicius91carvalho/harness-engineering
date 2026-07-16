/** Canonical runtime health vocabulary for Run State, worker rows, and panes. */

const TERMINAL_STATUSES = new Set(['complete', 'blocked', 'failed', 'abandoned'])
const RUNNINGISH_STATUSES = new Set(['running', 'starting', 'resuming'])

export function processAlive(pid) {
  if (!Number(pid)) return false
  try {
    process.kill(Number(pid), 0)
    return true
  } catch (error) {
    if (error?.code === 'EPERM') return true
    return false
  }
}

export function isLiveRunOwner(runState, alive = processAlive) {
  if (!runState || typeof runState !== 'object') return false
  const check = alive || processAlive
  return Boolean(check(runState.ownerPid) || check(runState.childPid))
}

export function classifyRunStateHealth(runState, alive = processAlive) {
  const view = runtimeView({ runState, processAlive: alive })
  return {
    health: view.health,
    status: view.status,
    phase: view.phase,
    reason: view.reason,
    ownerPid: view.ownerPid,
    childPid: view.childPid,
    ownerHost: view.ownerHost,
  }
}

export function resolveWorkerLive(worker = {}, {
  processAlive: alive = processAlive,
  runState = null,
  paneExists = null,
} = {}) {
  return runtimeView({ worker, runState, paneExists, processAlive: alive }).live
}

export function runtimeView({
  context = null,
  worker = null,
  runState = null,
  claim = null,
  paneExists = null,
  localHost = '',
  nowEpoch = Math.floor(Date.now() / 1000),
  leaseSeconds = 60,
  staleSeconds = 120,
  workerOwned = false,
  processAlive: alive = processAlive,
} = {}) {
  const state = runState && typeof runState === 'object' ? runState : {}
  const row = worker && typeof worker === 'object' ? worker : {}
  const status = String(state.status || row.status || '')
  const phase = String(state.phase || '')
  const ownerPid = state.ownerPid ?? null
  const childPid = state.childPid ?? row.childPid ?? null
  const workerPid = row.childPid || row.pid || null
  const ownerHost = state.ownerHost || row.ownerHost || null
  const isHerdr = row.type === 'herdr' || row.display === 'herdr'
  const ownerLive = Boolean(ownerPid && alive(ownerPid))
  const childLive = Boolean(childPid && alive(childPid))
  const workerPidLive = Boolean(workerPid && alive(workerPid))
  const anyLive = ownerLive || childLive || workerPidLive
  const heartbeatEpoch = Number(state.heartbeatEpoch || 0)
  const heartbeatAge = heartbeatEpoch > 0 ? Math.max(0, nowEpoch - heartbeatEpoch) : null
  const terminal = TERMINAL_STATUSES.has(status) || row.terminal === true || row.health === 'done'

  if (terminal) {
    return base({ context, status, phase, ownerPid, childPid, ownerHost, health: 'terminal', live: false, reason: 'terminal-status' })
  }
  if (row.live === false) {
    return base({ context, status, phase, ownerPid, childPid, ownerHost, health: 'idle', live: false, reason: 'worker-marked-not-live' })
  }
  if (isHerdr && row.paneId && paneExists === false) {
    if (anyLive && !workerOwned && heartbeatAge != null && heartbeatAge >= staleSeconds) {
      return base({ context, status, phase, ownerPid, childPid, ownerHost, health: 'live_stale', live: true, reason: 'live-pid-stale-missing-pane' })
    }
    return base({ context, status, phase, ownerPid, childPid, ownerHost, health: 'idle', live: false, reason: 'herdr-pane-missing' })
  }
  if (ownerHost && localHost && ownerHost !== localHost) {
    if (heartbeatAge != null && heartbeatAge < Math.max(1, Number(leaseSeconds) || 60)) {
      return base({ context, status, phase, ownerPid, childPid, ownerHost, health: 'remote_owned', live: true, reason: 'remote-owner-heartbeat-fresh' })
    }
    return base({ context, status, phase, ownerPid, childPid, ownerHost, health: 'ghost', live: false, reason: 'remote-owner-heartbeat-stale' })
  }
  if (anyLive) {
    if (!workerOwned && heartbeatAge != null && heartbeatAge >= staleSeconds) {
      return base({ context, status, phase, ownerPid, childPid, ownerHost, health: 'live_stale', live: true, reason: 'live-pid-stale-heartbeat' })
    }
    return base({ context, status, phase, ownerPid, childPid, ownerHost, health: 'live', live: true, reason: 'live-pid' })
  }

  const hadPid = Boolean(ownerPid || childPid || workerPid || claim?.session)
  const runningish = RUNNINGISH_STATUSES.has(status) || (status === 'claimed' && hadPid)
  if (runningish) {
    return base({ context, status, phase, ownerPid, childPid, ownerHost, health: 'ghost', live: false, reason: 'dead-owner-or-child' })
  }
  if (status === 'claimed' || phase === 'claimed') {
    return base({ context, status, phase, ownerPid, childPid, ownerHost, health: 'idle', live: false, reason: 'awaiting-orchestrator' })
  }
  return base({ context, status, phase, ownerPid, childPid, ownerHost, health: 'idle', live: false, reason: 'no-live-runtime' })
}

function base(fields) {
  return {
    context: fields.context ?? null,
    health: fields.health,
    live: Boolean(fields.live),
    status: fields.status || '',
    phase: fields.phase || '',
    reason: fields.reason || '',
    ownerPid: fields.ownerPid ?? null,
    childPid: fields.childPid ?? null,
    ownerHost: fields.ownerHost ?? null,
  }
}
