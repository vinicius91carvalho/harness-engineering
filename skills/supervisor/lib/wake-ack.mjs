/**
 * Pure planner: whether wake-control-host may ack judgment events after
 * --invoke-agent. Exit status 0 alone is not enough — the agent may no-op.
 */

function remainingOf(st = {}) {
  const p = st.progress || st.counts || {}
  if (p.remaining != null) return Math.max(0, Number(p.remaining) || 0)
  return Math.max(0, Number(p.total || 0) - Number(p.integrated || 0))
}

function workerCount(st = {}) {
  const fromMap = Object.keys(st.workers || {}).length
  const health = Object.keys(st.workerHealth || {}).length
  const snap = Number(st.fleetSnapshot?.projects?.[0]?.workers || 0)
  const live = Number(st.fleetSnapshot?.projects?.[0]?.liveClaimWorkers || 0)
  return Math.max(fromMap, health, snap, live)
}

function retryKeys(st = {}) {
  return Object.keys(st.retryQueue || {})
}

function pendingInputCount(st = {}) {
  return Object.values(st.pendingInputs || {}).filter((i) => i?.status === 'pending').length
}

function goalReviewRetrySig(st = {}) {
  const gr = st.retryQueue?.['goal-review']
  if (!gr) return ''
  return `${gr.attempts || 0}|${String(gr.guidance || '').slice(0, 80)}`
}

function lastFailureSig(st = {}) {
  const f = st.lastGoalReviewFailure
  if (!f) return ''
  return `${f.at || ''}|${f.fingerprint || ''}|${(f.reopened || []).join(',')}`
}

/** Wake kinds that require a visible fleet/repair post-condition before ack. */
export const STRICT_ACK_WAKE_KINDS = new Set([
  'goal_review_failed',
  'goal_defects',
  'goal_review_retry_exhausted',
  'empty_fleet_actionable',
  'worker_stuck',
  'worker_crash_loop',
  'dead_runtime',
  'input_required',
])

/**
 * @returns {{ ack: boolean, reason: string }}
 */
export function planWakeAck({
  invokeAgent = false,
  invokeStatus = null,
  invokeStdout = '',
  invokeStderr = '',
  wakes = [],
  statusBefore = null,
  statusAfter = null,
} = {}) {
  if (!invokeAgent) return { ack: true, reason: 'no-invoke' }

  const kinds = new Set((wakes || []).map((w) => String(w?.kind || '')))
  const needsStrict = [...kinds].some((k) => STRICT_ACK_WAKE_KINDS.has(k))

  // Timeout / spawn failure: spawnSync status is null — never ack strict wakes.
  if (invokeStatus == null) {
    return needsStrict
      ? { ack: false, reason: 'invoke-status-null' }
      : { ack: true, reason: 'invoke-skipped' }
  }
  if (Number(invokeStatus) !== 0) {
    return { ack: false, reason: `invoke-exit-${invokeStatus}` }
  }

  if (!needsStrict) return { ack: true, reason: 'non-strict-wake' }

  const before = statusBefore && typeof statusBefore === 'object' ? statusBefore : {}
  const after = statusAfter && typeof statusAfter === 'object' ? statusAfter : null
  if (!after) return { ack: false, reason: 'missing-status-after' }

  const remBefore = remainingOf(before)
  const remAfter = remainingOf(after)
  const workersAfter = workerCount(after)
  const workersBefore = workerCount(before)
  const pendingBefore = pendingInputCount(before)
  const pendingAfter = pendingInputCount(after)
  const retriesAfter = retryKeys(after)
  const retriesBefore = new Set(retryKeys(before))
  const newRetry = retriesAfter.some((k) => !retriesBefore.has(k))
  const repairRetry = retriesAfter.some((k) => k !== 'goal-review')
  const reopened = Array.isArray(after.lastGoalReviewFailure?.reopened)
    ? after.lastGoalReviewFailure.reopened.length
    : 0
  const completed = after.status === 'complete' || after.status === 'stopped'
  const grRetryChanged = goalReviewRetrySig(before) !== goalReviewRetrySig(after)
    && Boolean(after.retryQueue?.['goal-review'] || before.retryQueue?.['goal-review'])
  const failureChanged = lastFailureSig(before) !== lastFailureSig(after)
    && Boolean(after.lastGoalReviewFailure)

  if (completed) return { ack: true, reason: 'run-complete' }
  if (reopened > 0) return { ack: true, reason: 'goal-review-reopened' }
  if (failureChanged) return { ack: true, reason: 'goal-review-failure-updated' }
  if (grRetryChanged) return { ack: true, reason: 'goal-review-retry-updated' }
  // Process supervisor often applies recovery before the wake bridge starts
  // (statusBefore already has lastGoalReviewFailure / pending input / retryQueue).
  // Ack so judgment-agent noops do not defer forever on already-handled wakes.
  const failure = after.lastGoalReviewFailure
  if ((kinds.has('goal_review_failed') || kinds.has('goal_defects')) && failure
    && (
      (failure.reopened || []).length > 0
      || failure.unmapped
      || failure.repairInFlight
      || repairRetry
    )) {
    return { ack: true, reason: 'goal-review-already-recovered' }
  }
  if (kinds.has('input_required') && pendingAfter > 0) {
    // Mechanical path already raised pending input before invoke — goal or context.
    const pendingAny = Object.values(after.pendingInputs || {}).some(
      (i) => i?.status === 'pending',
    )
    if (pendingAny) return { ack: true, reason: 'input-already-pending' }
  }
  if (kinds.has('goal_review_retry_exhausted')) {
    const attempts = Number(after.retryQueue?.['goal-review']?.attempts || 0)
    if (attempts >= 3) return { ack: true, reason: 'goal-review-retry-exhausted-recorded' }
  }
  if (remAfter < remBefore) return { ack: true, reason: 'remaining-decreased' }
  if (workersAfter > workersBefore) return { ack: true, reason: 'workers-increased' }
  if (workersAfter > 0 && (kinds.has('empty_fleet_actionable') || kinds.has('worker_stuck'))) {
    return { ack: true, reason: 'workers-live' }
  }
  if (pendingAfter < pendingBefore) return { ack: true, reason: 'input-cleared' }
  if (pendingAfter > pendingBefore) return { ack: true, reason: 'input-raised' }
  if (newRetry || repairRetry) return { ack: true, reason: 'retry-queue-seeded' }

  const blob = `${invokeStdout || ''}\n${invokeStderr || ''}`
  if (/\b(reopen|retryQueue|respond --action|applyGoalReview|goal_review_failed|updateLedger|seeded retry)\b/i.test(blob)) {
    return { ack: true, reason: 'agent-claimed-action' }
  }

  return { ack: false, reason: 'invoke-noop' }
}

/**
 * Build a Wake Triage fleet snapshot from harness-control status JSON.
 * Prefer the matching project row; fall back to aggregate bearings.
 */
export function fleetSnapshotForWakeTriage(st = {}, projectId = null) {
  const projects = st?.fleetSnapshot?.projects || []
  const self = (projectId && projects.find((p) => p.id === projectId))
    || projects.find((p) => p.id === 'root')
    || projects[0]
    || null
  const pendingInputs = pendingInputCount(st)
  const retryQueueSize = retryKeys(st).length
  const mapWorkers = Object.keys(st.workers || {}).length
  const liveClaims = Number(self?.liveClaimWorkers || 0)
  const rowWorkers = Number(self?.workers || 0)
  return {
    ...(self || {}),
    status: st.status || self?.status || '',
    progress: st.progress || self?.progress || {},
    counts: st.progress || self?.progress || self?.counts || {},
    workers: Math.max(mapWorkers, rowWorkers, liveClaims),
    liveClaimWorkers: Math.max(liveClaims, mapWorkers),
    pendingInputs,
    retryQueueSize,
    retryGoalReview: Boolean(st.retryQueue?.['goal-review'] || self?.retryGoalReview),
    needsGoalReviewRetry: Boolean(self?.needsGoalReviewRetry),
    emptyFleetActionable: Boolean(self?.emptyFleetActionable),
    supervisorLive: self?.supervisorLive ?? Boolean(st.supervisorPid),
  }
}
