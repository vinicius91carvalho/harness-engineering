/** Reasons the supervisor may retry without waiting for a human operator. */
const AUTO_RETRY_PREFIXES = [
  'Retry could not resume the Claim Lease',
  'Worker exited with code',
  'Harness worker pane ended before run state completed',
  'Harness worker is idle or waiting',
  'Integrated Verification failed after Attempt 3',
  'integration could not complete',
  'coding agent failed three times',
  'Work Item blocked',
  'Claim Lease is stale on another host',
]

export function isAutoRetryableInput(request) {
  if (!request || request.status !== 'pending') return false
  const reason = String(request.reason || '')
  if (request.scope === 'goal') {
    return reason.startsWith('Worker exited with code')
      && String(request.detail?.log || '').includes('goal-review')
  }
  if (!request.context) return false
  return AUTO_RETRY_PREFIXES.some((prefix) => reason === prefix || reason.startsWith(prefix))
}

export function autoRetryGuidance(request) {
  const reason = String(request?.reason || '')
  if (reason.startsWith('Retry could not resume the Claim Lease')) {
    return 'Auto-retry: resume Claim Lease with force after bounded retry exhaustion.'
  }
  if (reason.startsWith('Worker exited with code')) {
    return 'Auto-retry: worker process exited; resume context after confirming worktree is healthy.'
  }
  if (reason.startsWith('Harness worker pane ended before run state completed')) {
    return 'Auto-retry: herdr pane shell ended before orchestrator wrote terminal run state; resume context.'
  }
  if (reason.startsWith('Integrated Verification failed after Attempt 3')) {
    return 'Auto-retry: re-run integrated verification for stuck Work Items.'
  }
  if (reason === 'integration could not complete') {
    return 'Auto-retry: integration merge/checkpoint failure; retry merge and integrated verification.'
  }
  if (reason === 'coding agent failed three times') {
    return 'Auto-retry: coding exhausted three attempts; apply smallest root-cause fix per Repair Plan.'
  }
  if (reason === 'Work Item blocked') {
    return 'Auto-retry: context blocked; resume with orchestrator Repair Plan.'
  }
  if (reason.startsWith('Claim Lease is stale on another host')) {
    return 'Auto-retry: stale claim lease on another host; take over with force.'
  }
  if (reason === 'Harness worker is idle or waiting') {
    return 'Auto-retry: worker appeared idle while merge lock or turn boundary; resume.'
  }
  return 'Auto-retry: supervisor default retry without human input.'
}

/**
 * Write retry responses for pending context Input Requests that qualify.
 * Returns event ids queued for processResponses() on the next line.
 */
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
        // Prefer operator/custom retryQueue guidance over the generic auto-retry text.
        guidance: queuedGuidance || autoRetryGuidance(request),
        at: new Date().toISOString(),
        auto: true,
      },
    })
  }
  return planned
}
