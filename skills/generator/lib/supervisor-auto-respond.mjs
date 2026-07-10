/** Reasons the supervisor may retry without waiting for a human operator. */
import { routePendingInput } from './repair-router.mjs'
import { isAutoRetryableReason } from './failure-policy.mjs'

export function isAutoRetryableInput(request) {
  if (!request || request.status !== 'pending') return false
  const reason = String(request.reason || '')
  const routed = routePendingInput(request)
  if (!routed.autoRetry) return false
  return isAutoRetryableReason(reason, {
    scope: request.scope || 'context',
    detail: request.detail || {},
  })
}

export function autoRetryGuidance(request) {
  const reason = String(request?.reason || '')
  const routed = routePendingInput(request)
  if (routed.defectClass && routed.defectClass !== 'product') return routed.guidance
  if (routed.action === 'pause' || routed.action === 'recycle') return routed.guidance
  if (reason.startsWith('Retry could not resume the Claim Lease')) {
    return 'Auto-retry: resume Claim Lease with force after bounded retry exhaustion.'
  }
  if (reason.startsWith('Worker exited with code')) {
    return 'Auto-retry: worker process exited; resume context after confirming worktree is healthy.'
  }
  if (reason.startsWith('Harness worker pane ended before run state completed')) {
    return 'Auto-retry: herdr pane shell ended before orchestrator wrote terminal run state; resume context.'
  }
  if (reason === 'integration could not complete') {
    return 'Auto-retry: integration merge/checkpoint failure; retry merge and integrated verification.'
  }
  if (reason === 'Harness worker is idle or waiting') {
    return 'Auto-retry: worker appeared idle while merge lock or turn boundary; resume.'
  }
  return 'Auto-retry: supervisor default retry without human input.'
}

export function planAutoRetryResponses(pendingInputs, {
  workers = new Set(),
  retryQueue = {},
  crashCounts = {},
  isCrashBound = (context) => (crashCounts?.[context] || 0) >= 5,
} = {}) {
  const planned = []
  for (const [id, request] of Object.entries(pendingInputs || {})) {
    if (!isAutoRetryableInput(request)) continue
    const context = request.context
    if (context) {
      if (workers.has(context)) continue
      if (retryQueue?.[context]) continue
      if (isCrashBound(context)) continue
    } else if (request.scope === 'goal' && workers.has('goal-review')) {
      continue
    }
    const queuedGuidance = context && retryQueue?.[context]?.guidance
    planned.push({
      eventId: Number(id),
      context,
      response: {
        eventId: Number(id),
        action: 'retry',
        guidance: queuedGuidance || autoRetryGuidance(request),
        at: new Date().toISOString(),
        auto: true,
      },
    })
  }
  return planned
}
