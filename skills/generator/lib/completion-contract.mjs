/** Completion Contract: one proof that the Project Goal is done. */

export function everyCheckMapped(checks, catalog) {
  const mapped = new Set(catalog.flatMap((item) => item.acceptance_checks || []))
  return checks.every((check) => mapped.has(check.id))
}

export function progressOf(item, ledger = null) {
  if (ledger?.items?.[String(item.id)]) return ledger.items[String(item.id)]
  return {
    implementation: item.implementation === true,
    qa: item.qa === true,
    integration: item.integration === true,
    blocked: item.blocked === true,
    retries: item.retries || 0,
  }
}

export function catalogFullyIntegrated(catalog, ledger = null) {
  if (!Array.isArray(catalog) || !catalog.length) return false
  return catalog.every((item) => progressOf(item, ledger).integration === true)
}

export function anyBlocked(catalog, ledger = null) {
  return catalog.some((item) => progressOf(item, ledger).blocked === true)
}

/** True when every Acceptance Check is mapped and every Work Item is integrated. */
export function completionSatisfied({ checks, catalog, ledger = null }) {
  if (!checks?.length || !Array.isArray(catalog)) return false
  if (!everyCheckMapped(checks, catalog)) return false
  if (anyBlocked(catalog, ledger)) return false
  if (!catalogFullyIntegrated(catalog, ledger)) return false
  // Reject impossible flag combinations on catalog fallback
  for (const item of catalog) {
    const p = progressOf(item, ledger)
    if (p.integration && (!p.implementation || !p.qa)) return false
  }
  return true
}

function queueComplete({ checks, catalog, ledger, counts }) {
  if (!catalog?.length) return false
  if (checks?.length) return completionSatisfied({ checks, catalog, ledger })
  if (ledger) return catalogFullyIntegrated(catalog, ledger)
  if (counts) return counts.total === catalog.length && counts.integrated === counts.total
  return catalogFullyIntegrated(catalog, ledger)
}

/**
 * Single Goal Review admission gate. Returns { ok, reason } where reason is one of:
 * incomplete-queue | blocked-items | active-workers | no-slot | goal-review-running |
 * dirty-checkout | already-reviewed-head | empty-queue | admissible
 */
export function goalReviewAdmissible({
  checks = null,
  catalog = null,
  ledger = null,
  integrationHead = '',
  reviewedHead = '',
  cleanCheckout = true,
  activeWorkers = 0,
  status = '',
  slots = undefined,
  hasGoalReviewWorker = undefined,
  counts = null,
} = {}) {
  if (activeWorkers > 0) return { ok: false, reason: 'active-workers' }
  if (slots !== undefined && slots < 1) return { ok: false, reason: 'no-slot' }
  if (hasGoalReviewWorker === true) return { ok: false, reason: 'goal-review-running' }
  if (!cleanCheckout) return { ok: false, reason: 'dirty-checkout' }
  if (!catalog?.length) return { ok: false, reason: 'empty-queue' }
  if (anyBlocked(catalog, ledger)) return { ok: false, reason: 'blocked-items' }

  if (!queueComplete({ checks, catalog, ledger, counts })) {
    return { ok: false, reason: 'incomplete-queue' }
  }

  if (status === 'complete' && reviewedHead && integrationHead && reviewedHead === integrationHead) {
    return { ok: false, reason: 'already-reviewed-head' }
  }

  return { ok: true, reason: 'admissible' }
}
