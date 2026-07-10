import { validateAcyclic, validateCatalogDependencies } from './project-specification.mjs'
import { progressOf } from './completion-contract.mjs'

export { validateCatalogDependencies } from './project-specification.mjs'

function dependencySatisfied(queue, dependencyId, ledger = null) {
  return queue.some((item) => {
    const progress = progressOf(item, ledger)
    return progress.integration === true && (item.acceptance_checks || []).includes(dependencyId)
  })
}

/** Validate Acceptance Check deps (unknown ids, cycles) and optional Work Item catalog deps. */
export function validateDependencyGraph(checks, catalog = null) {
  const normalized = checks.map((check) => ({
    ...check,
    dependsOn: check.dependsOn || check.dependencies || [],
  }))
  validateAcyclic(normalized)
  if (catalog) validateCatalogDependencies(normalized, catalog)
}

export function isWorkItemReady(item, queue, { mode = 'all', ledger = null } = {}) {
  const progress = progressOf(item, ledger)
  let pending = progress.integration !== true
  if (mode === 'qa') pending = progress.implementation === true && (progress.qa !== true || progress.integration !== true)
  if (!pending) return false
  const deps = item.depends_on || []
  return deps.every((dep) => dependencySatisfied(queue, dep, ledger))
}

export function readyWorkItems(queue, { mode = 'all', context = null, taskId = null, ledger = null } = {}) {
  if (!Array.isArray(queue)) return []
  let ready = queue.filter((item) => isWorkItemReady(item, queue, { mode, ledger }))
  if (context) ready = ready.filter((item) => item.context === context)
  if (taskId) ready = ready.filter((item) => String(item.id) === String(taskId))
  return ready
}

export function firstUnclaimedContext(queue, claims, claimKeyFn, { mode = 'all', ledger = null } = {}) {
  const seen = new Set()
  for (const item of readyWorkItems(queue, { mode, ledger })) {
    if (seen.has(item.context)) continue
    seen.add(item.context)
    const key = claimKeyFn(item.context)
    if (!claims[key]) return item.context
  }
  return null
}
