/**
 * Plan when to close finished herdr worker tabs without touching live panes.
 */

export const DEFAULT_REAP_INTERVAL_MS = 60_000

/**
 * Pane ids that must never be closed by the reaper.
 * @param {Map|object} workers - live supervisor workers
 */
export function collectLiveWorkerPaneIds(workers) {
  const keep = new Set()
  const rows = workers instanceof Map ? [...workers.values()] : Object.values(workers || {})
  for (const worker of rows) {
    if (worker?.type === 'herdr' && worker.paneId) keep.add(worker.paneId)
  }
  return keep
}

/**
 * @param {object} input
 * @param {Map|object} input.workers
 * @param {object} [input.workerHealth]
 * @param {number} [input.now]
 * @param {number} [input.lastReapAt]
 * @param {number} [input.minIntervalMs]
 * @param {boolean} [input.force] - bypass rate limit (workerClosed / workerHealth=done)
 */
export function planFinishedTabReap({
  workers,
  workerHealth = {},
  now = Date.now(),
  lastReapAt = 0,
  minIntervalMs = DEFAULT_REAP_INTERVAL_MS,
  force = false,
} = {}) {
  const keepPaneIds = collectLiveWorkerPaneIds(workers)
  const doneContexts = Object.entries(workerHealth || {})
    .filter(([, health]) => health?.verdict === 'done')
    .map(([context]) => context)

  if (!force && now - lastReapAt < minIntervalMs) {
    return {
      shouldReap: false,
      reason: 'rate_limited',
      keepPaneIds,
      doneContexts,
    }
  }

  return {
    shouldReap: true,
    reason: force ? 'forced' : (doneContexts.length > 0 ? 'worker_health_done' : 'tick'),
    keepPaneIds,
    doneContexts,
  }
}
