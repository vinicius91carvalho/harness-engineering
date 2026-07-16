/**
 * Pure supervisor tick helpers (Control Plane, Wave C / ADR-0022).
 * Lives under skills/supervisor/lib/; harness-control.mjs only applies I/O.
 *
 * A supervisor tick (harness-control tick()) roughly:
 * 1. Sync control-file status and process pending user responses
 * 2. Inspect stuck workers and live claims
 * 3. Drain the retry queue (resume blocked contexts with guidance)
 * 4. Finalize a deferred Goal Review pass once retries are empty
 * 5. Maybe start Goal Review, recover interrupted claims, or claim new work
 *
 * Tick planners (nextTickDelay, tickWatchPaths, drainRetryQueue,
 * applyRetryResumeOutcome, shouldFinalizePendingGoal) and admission planning
 * (supervisor-admission.mjs) live here. harness-control remains the I/O adapter
 * (ADR-0007): resume, spawn, input, and save stay there.
 */

export const DEFAULT_RETRY_MAX_ATTEMPTS = 5

/** Floor when a watch fires so self-writes under watched paths cannot busy-loop. */
const DIRTY_MIN_MS = 50

export function nextTickDelay({
  pollMs = 2000,
  eventDriven = true,
  dirty = false,
  dueAt = null,
  now = Date.now(),
} = {}) {
  const base = Math.max(250, Number(pollMs) || 2000)
  if (!eventDriven) return base
  if (dirty) return DIRTY_MIN_MS
  if (dueAt) return Math.max(0, Math.min(base, Number(dueAt) - now))
  return base
}

/**
 * Paths that should wake an event-driven supervisor tick.
 * Do NOT watch controlRoot itself — Supervisor.save writes state.json there and
 * would dirty every tick into a 50ms busy loop. Watch only external input dirs
 * (responses/, runs, locks).
 */
export function tickWatchPaths({ controlRoot, runsDir, commonGit } = {}) {
  return [
    controlRoot ? `${controlRoot}/responses` : null,
    runsDir,
    commonGit ? `${commonGit}/harness-locks` : null,
  ].filter(Boolean)
}

/**
 * Order retry-queue entries to attempt resume while slots remain available.
 * A failed resume does not consume a slot; a successful resume consumes one.
 */
export function drainRetryQueue(retryQueue, slots) {
  const available = Math.max(0, Number(slots) || 0)
  const attempts = Object.entries(retryQueue || {})
    .map(([context, retry]) => ({ context, retry: { ...retry } }))
  if (available < 1) {
    // Defer: do not surface attempts that would burn counters without capacity.
    return { attempts: [], slots: 0, deferred: attempts.map((row) => row.context) }
  }
  return { attempts: attempts.slice(0, available), slots: available, deferred: attempts.slice(available).map((row) => row.context) }
}

/** Apply the outcome of one retry-queue resume attempt. */
export function applyRetryResumeOutcome(retryQueue, context, retry, succeeded, maxAttempts = DEFAULT_RETRY_MAX_ATTEMPTS) {
  const updatedQueue = { ...(retryQueue || {}) }
  if (succeeded) {
    delete updatedQueue[context]
    return { updatedQueue, exhausted: null, remainingSlotsDelta: -1 }
  }
  const attempts = (retry.attempts || 0) + 1
  if (attempts >= maxAttempts) {
    delete updatedQueue[context]
    return { updatedQueue, exhausted: { context, attempts }, remainingSlotsDelta: 0 }
  }
  updatedQueue[context] = { ...retry, attempts }
  return { updatedQueue, exhausted: null, remainingSlotsDelta: 0 }
}

/** Whether a deferred Goal Review result may finalize the run. */
export function shouldFinalizePendingGoal(retryQueue, pendingGoalResult) {
  return Boolean(pendingGoalResult) && Object.keys(retryQueue || {}).length === 0
}
