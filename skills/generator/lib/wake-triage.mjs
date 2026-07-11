/**
 * Zero-token Wake Triage over Control Journal deltas (ADR-0017).
 * Classifies events before a Control Host LLM turn; does not replace
 * supervisor-tick or Resource Governor admission.
 */

import { fleetSnapshotFromState } from './fleet-snapshot.mjs'

export { fleetSnapshotFromState }

const WAKE_KINDS = new Set([
  'worker_stuck',
  'supervisor_failed',
  'supervisor_tick_failed',
  'harness_issue',
  'goal_defects',
  'quota_wait',
  'run_completed',
  'supervisor_stopped',
])

const ABSORB_KINDS = new Set([
  'worker_started',
  'context_completed',
  'input_received',
  'input_auto_responded',
  'stale_lock_cleared',
  'goal_review_started',
  'retry_deferred_orphan_pid',
])

function remainingWork(counts = {}) {
  if (counts.remaining != null) return Math.max(0, Number(counts.remaining) || 0)
  const total = Number(counts.total ?? 0)
  const integrated = Number(counts.integrated ?? 0)
  return Math.max(0, total - integrated)
}

function queueCompleteInFleet(fleetSnapshot = {}) {
  if (fleetSnapshot.queueComplete === true) return true
  const counts = fleetSnapshot.counts || {}
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
  return fleetSnapshot?.counts || {}
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

/**
 * @param {object} event - valid Control Journal event
 * @param {object} [fleetSnapshot] - optional fleet bearings
 * @returns {{ action: 'absorb'|'fold'|'wake', reason: string }}
 */
export function classify(event, fleetSnapshot = null) {
  const kind = event?.kind
  if (!kind) return { action: 'wake', reason: 'unknown event kind' }

  if (kind === 'input_required') {
    return {
      action: 'wake',
      reason: event.scope === 'goal' ? 'goal-scoped input required' : 'input required',
    }
  }

  if (WAKE_KINDS.has(kind)) {
    return { action: 'wake', reason: kind }
  }

  if (kind === 'worker_health') {
    if (event.verdict === 'stuck') return { action: 'wake', reason: 'worker health stuck' }
    return { action: 'absorb', reason: 'healthy worker heartbeat' }
  }

  if (kind === 'progress') {
    if (needsGoalReviewRetry(fleetSnapshot)) {
      return { action: 'wake', reason: 'stale Goal Review with integrated queue' }
    }
    if (isEmptyFleetActionable(event, fleetSnapshot)) {
      return { action: 'wake', reason: 'empty fleet with remaining work or pending inputs' }
    }
    return { action: 'fold', reason: 'routine progress snapshot' }
  }

  if (ABSORB_KINDS.has(kind)) {
    return { action: 'absorb', reason: kind }
  }

  if (kind === 'run_started') {
    return { action: 'wake', reason: 'supervisor run started' }
  }

  if (event.immediate === true) {
    return { action: 'wake', reason: 'immediate event' }
  }

  return { action: 'absorb', reason: 'benign event' }
}

/** True when any event in the batch requires a Control Host LLM wake. */
export function shouldWake(batch, fleetSnapshot = null) {
  if (!Array.isArray(batch) || batch.length === 0) return false
  return batch.some((event) => classify(event, fleetSnapshot).action === 'wake')
}

/**
 * Fold benign progress / heartbeat events into one summary.
 * Returns null when the batch has nothing worth folding.
 */
export function foldProgress(batch, fleetSnapshot = null) {
  if (!Array.isArray(batch) || batch.length === 0) return null

  const foldable = batch.filter((event) => {
    const { action } = classify(event, fleetSnapshot)
    return action === 'fold' || action === 'absorb'
  })
  if (foldable.length <= 1) return null

  const progress = foldable.filter((event) => event.kind === 'progress')
  const health = foldable.filter((event) => event.kind === 'worker_health')
  const latestProgress = progress.at(-1) || null

  return {
    foldedCount: foldable.length,
    firstId: Math.min(...foldable.map((event) => Number(event.id) || 0)),
    lastId: Math.max(...foldable.map((event) => Number(event.id) || 0)),
    progressCount: progress.length,
    healthCount: health.length,
    latestProgress,
    kinds: [...new Set(foldable.map((event) => event.kind))],
  }
}
