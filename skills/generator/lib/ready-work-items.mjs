function dependencySatisfied(queue, dependencyId) {
  return queue.some((item) => item.integration === true && (item.acceptance_checks || []).includes(dependencyId))
}

export function isWorkItemReady(item, queue, { mode = 'all' } = {}) {
  let pending = item.integration !== true
  if (mode === 'qa') pending = item.implementation === true && (item.qa !== true || item.integration !== true)
  if (!pending) return false
  const deps = item.depends_on || []
  return deps.every((dep) => dependencySatisfied(queue, dep))
}

export function readyWorkItems(queue, { mode = 'all', context = null, taskId = null } = {}) {
  if (!Array.isArray(queue)) return []
  let ready = queue.filter((item) => isWorkItemReady(item, queue, { mode }))
  if (context) ready = ready.filter((item) => item.context === context)
  if (taskId) ready = ready.filter((item) => String(item.id) === String(taskId))
  return ready
}

export function firstUnclaimedContext(queue, claims, claimKeyFn, { mode = 'all' } = {}) {
  const seen = new Set()
  for (const item of readyWorkItems(queue, { mode })) {
    if (seen.has(item.context)) continue
    seen.add(item.context)
    const key = claimKeyFn(item.context)
    if (!claims[key]) return item.context
  }
  return null
}
