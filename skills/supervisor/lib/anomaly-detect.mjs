/**
 * Pure anomaly planners for event-driven Control Host wakes (zero-token).
 * harness-control applies I/O: emit Control Events, track exit history, escalate.
 *
 * Detects: worker never started (no live Run State after deadline) and
 * crash / start-stop flaps within a sliding window.
 */

export const DEFAULT_NEVER_STARTED_MS = 120_000
export const DEFAULT_CRASH_LOOP_WINDOW_MS = 10 * 60_000
export const DEFAULT_CRASH_LOOP_THRESHOLD = 3

/**
 * Claim/worker admitted but no live owner/child and no run heartbeat past deadline.
 * @returns {{ emit: boolean, kind: 'worker_never_started'|null, detail: object }}
 */
export function planNeverStarted({
  context = null,
  startedAt = null,
  runState = null,
  workerPid = null,
  now = Date.now(),
  deadlineMs = DEFAULT_NEVER_STARTED_MS,
  processAlive = () => false,
} = {}) {
  if (!context || !startedAt) {
    return { emit: false, kind: null, detail: { reason: 'missing-context-or-startedAt' } }
  }
  const startedMs = Date.parse(String(startedAt))
  if (!Number.isFinite(startedMs)) {
    return { emit: false, kind: null, detail: { reason: 'invalid-startedAt' } }
  }
  const ageMs = Math.max(0, now - startedMs)
  if (ageMs < Math.max(1_000, Number(deadlineMs) || DEFAULT_NEVER_STARTED_MS)) {
    return { emit: false, kind: null, detail: { reason: 'within-deadline', ageMs } }
  }

  const state = runState && typeof runState === 'object' ? runState : {}
  const ownerLive = Boolean(state.ownerPid && processAlive(state.ownerPid))
  const childLive = Boolean(state.childPid && processAlive(state.childPid))
  const workerLive = Boolean(workerPid && processAlive(workerPid))
  if (ownerLive || childLive || workerLive) {
    return { emit: false, kind: null, detail: { reason: 'process-live', ageMs } }
  }

  const heartbeat = state.lastAgentOutputAt || state.heartbeat || state.heartbeatAt || null
  if (heartbeat) {
    const hbMs = Date.parse(String(heartbeat))
    if (Number.isFinite(hbMs) && now - hbMs < Math.max(1_000, Number(deadlineMs) || DEFAULT_NEVER_STARTED_MS)) {
      return { emit: false, kind: null, detail: { reason: 'fresh-heartbeat', ageMs } }
    }
  }

  const phase = String(state.phase || '')
  const status = String(state.status || '')
  // Terminal run already handled elsewhere; never-started is for empty/ghost spawn.
  if (['complete', 'failed', 'abandoned', 'blocked'].includes(status)) {
    return { emit: false, kind: null, detail: { reason: 'terminal-run', status, ageMs } }
  }

  return {
    emit: true,
    kind: 'worker_never_started',
    detail: {
      context,
      ageMs,
      deadlineMs: Number(deadlineMs) || DEFAULT_NEVER_STARTED_MS,
      phase: phase || null,
      status: status || null,
      ownerPid: state.ownerPid || null,
      childPid: state.childPid || null,
      workerPid: workerPid || null,
    },
  }
}

/**
 * Record an exit timestamp and decide whether a crash-loop wake is warranted.
 * Pure: returns next history + optional emit plan (does not mutate input).
 */
export function planCrashLoop({
  context = null,
  recentExits = [],
  exitAt = Date.now(),
  windowMs = DEFAULT_CRASH_LOOP_WINDOW_MS,
  threshold = DEFAULT_CRASH_LOOP_THRESHOLD,
  alreadyEmitted = false,
} = {}) {
  const window = Math.max(1_000, Number(windowMs) || DEFAULT_CRASH_LOOP_WINDOW_MS)
  const bound = Math.max(2, Number(threshold) || DEFAULT_CRASH_LOOP_THRESHOLD)
  const at = Number(exitAt) || Date.now()
  const prior = Array.isArray(recentExits)
    ? recentExits.map(Number).filter((t) => Number.isFinite(t))
    : []
  const next = [...prior, at].filter((t) => at - t <= window)
  if (alreadyEmitted) {
    return {
      recentExits: next,
      emit: false,
      kind: null,
      detail: { reason: 'already-emitted', count: next.length, context },
    }
  }
  if (next.length < bound) {
    return {
      recentExits: next,
      emit: false,
      kind: null,
      detail: { reason: 'below-threshold', count: next.length, threshold: bound, context },
    }
  }
  return {
    recentExits: next,
    emit: true,
    kind: 'worker_crash_loop',
    detail: {
      context,
      count: next.length,
      threshold: bound,
      windowMs: window,
      exits: next,
    },
  }
}

/**
 * Spawn produced no child pid (immediate failure).
 */
export function planSpawnFailed({ context = null, pid = null, error = null } = {}) {
  if (!context) return { emit: false, kind: null, detail: { reason: 'missing-context' } }
  if (pid) return { emit: false, kind: null, detail: { reason: 'pid-present', pid } }
  return {
    emit: true,
    kind: 'worker_spawn_failed',
    detail: {
      context,
      error: error ? String(error.message || error) : 'spawn produced no pid',
    },
  }
}

/** Prune exit history older than window (pure). */
export function pruneExitHistory(recentExits = [], { now = Date.now(), windowMs = DEFAULT_CRASH_LOOP_WINDOW_MS } = {}) {
  const window = Math.max(1_000, Number(windowMs) || DEFAULT_CRASH_LOOP_WINDOW_MS)
  return (Array.isArray(recentExits) ? recentExits : [])
    .map(Number)
    .filter((t) => Number.isFinite(t) && now - t <= window)
}
