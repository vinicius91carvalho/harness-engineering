/**
 * Pure tick-admission planner extracted from harness-control's Supervisor.tick()
 * (ADR-0007 / ADR-0009). harness-control remains the I/O adapter: spawn, Claim
 * Lease resume/release, Control Events, Input Requests, and save all stay
 * there. This module decides *what to do next*, not how to do it.
 *
 * Scope: the retry-queue drain loop (resume a Claim Lease, apply its outcome)
 * stays inline in harness-control using supervisor-tick.mjs's drainRetryQueue and
 * applyRetryResumeOutcome directly. Each retry attempt's own success is itself an
 * I/O result -- it decides whether a capacity slot was actually consumed, and a
 * failed attempt keeps trying the next queued context on the SAME slot (see
 * applyRetryResumeOutcome's remainingSlotsDelta) -- so that loop cannot be
 * pre-computed by a pure planner without either re-simulating I/O or accepting a
 * one-tick delay on the rare same-tick "queue just emptied, now finalize" case.
 *
 * planTickAdmission covers everything AFTER that drain loop settles: finalizing a
 * deferred Goal Review result, waiting for one, gating a new Goal Review, resuming
 * recoverable claims, and claiming new work -- the substantive branching that
 * otherwise lives as scattered if/for statements in tick().
 */

import { shouldFinalizePendingGoal } from './supervisor-tick.mjs'
import { goalReviewAdmissible as goalReviewGate } from './completion-contract.mjs'

export { goalReviewGate }

function goalReviewGateFromSnapshot({
  snapshot,
  activeWorkers,
  slots,
  hasGoalReviewWorker,
  checks = null,
  ledger = null,
  integrationHead = '',
  reviewedHead = '',
  cleanCheckout = true,
  status = '',
}) {
  return goalReviewGate({
    checks,
    catalog: snapshot?.queue,
    ledger,
    integrationHead,
    reviewedHead,
    cleanCheckout,
    activeWorkers,
    status,
    slots,
    hasGoalReviewWorker,
    counts: snapshot?.counts,
  })
}

/**
 * Boolean adapter for planTickAdmission. Treats already-reviewed-head as true so
 * maybeGoalReview can complete without spawning (preserves the short-circuit).
 */
export function goalReviewAdmissible(params) {
  const gate = goalReviewGateFromSnapshot(params)
  return gate.ok || gate.reason === 'already-reviewed-head'
}

/**
 * Decide the ordered admission actions for one tick, given the retry queue has
 * already settled (drained) for this tick. Returns one of:
 *   - [{ type: 'finalize_goal', result }]
 *   - [{ type: 'wait_pending_goal' }]
 *   - [{ type: 'start_goal_review' }]
 *   - [{ type: 'resume', context }, ..., { type: 'claim_new' }]
 *
 * The first three are terminal for the tick (the adapter returns after acting on
 * them); the last shape lets the adapter resume recoverable claims while slots
 * remain, then claim new work with whatever is left.
 */
export function planTickAdmission({
  slots,
  retryQueue,
  recoverable,
  pendingGoalResult,
  snapshot,
  activeWorkers,
  hasGoalReviewWorker,
  checks = null,
  ledger = null,
  integrationHead = '',
  reviewedHead = '',
  cleanCheckout = true,
  status = '',
}) {
  if (shouldFinalizePendingGoal(retryQueue, pendingGoalResult)) {
    return [{ type: 'finalize_goal', result: pendingGoalResult }]
  }
  if (pendingGoalResult) {
    return [{ type: 'wait_pending_goal' }]
  }
  if (goalReviewAdmissible({
    snapshot,
    activeWorkers,
    slots,
    hasGoalReviewWorker,
    checks,
    ledger,
    integrationHead,
    reviewedHead,
    cleanCheckout,
    status,
  })) {
    return [{ type: 'start_goal_review' }]
  }
  const actions = (recoverable || []).map((item) => ({ type: 'resume', context: item.context }))
  actions.push({ type: 'claim_new' })
  return actions
}
