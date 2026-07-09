const DEFAULT_CRASH_BOUND = 5

export function liveClaimContexts(claims) {
  return new Set(Object.values(claims || {}).map((claim) => claim.context).filter(Boolean))
}

/** Drop context-scoped pending Input Requests with no live claim, retry queue entry, or worker. */
export function pruneOrphanPendingInputs(pendingInputs, { claims = {}, retryQueue = {}, workerContexts = [] } = {}) {
  const live = liveClaimContexts(claims)
  const workers = workerContexts instanceof Set ? workerContexts : new Set(workerContexts)
  const next = { ...(pendingInputs || {}) }
  let pruned = 0
  for (const [id, request] of Object.entries(pendingInputs || {})) {
    const context = request.context
    if (request.scope !== 'context' || !context) continue
    if (live.has(context) || retryQueue?.[context] || workers.has(context)) continue
    delete next[id]
    pruned++
  }
  return { pendingInputs: next, pruned }
}

export function isCrashBoundContext(context, crashCounts, bound = DEFAULT_CRASH_BOUND) {
  return (crashCounts?.[context] || 0) >= bound
}
