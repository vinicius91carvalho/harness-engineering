/**
 * Gate for host ops cron: only act when a harness workflow is live or
 * still has actionable work. Fully complete/idle fleets must stay quiet.
 */

export function remainingFromProgress(progress = {}) {
  const total = Number(progress.total || 0)
  const integrated = Number(progress.integrated || 0)
  if (progress.remaining != null) return Math.max(0, Number(progress.remaining) || 0)
  return Math.max(0, total - integrated)
}

/** True when one fleet project still needs ops attention or has a live run. */
export function projectWorkflowActive(project = {}) {
  const status = String(project.status || '')
  const terminal = status === 'complete' || status === 'stopped'
  const remaining = remainingFromProgress(project.progress || {})
  const workers = Math.max(
    Number(project.workers || 0) || 0,
    Number(project.liveClaimWorkers || 0) || 0,
    Array.isArray(project.activeWorkers) ? project.activeWorkers.length : 0,
  )
  if (project.supervisorLive) return true
  if (workers > 0) return true
  if (Array.isArray(project.stuck) && project.stuck.length > 0) return true
  if (Number(project.pendingInputs || 0) > 0) return true
  if (Number(project.retryQueueSize || 0) > 0) return true
  if (project.emptyFleetActionable) return true
  if (project.needsGoalReviewRetry) return true
  if (['running', 'needs_input', 'interrupted'].includes(status)) return true
  if (!terminal && remaining > 0 && status !== 'paused') return true
  return false
}

/**
 * @param {object} fleet fleet-snapshot JSON
 * @param {object[]} [projects] optional already-filtered project list
 */
export function fleetWorkflowActive(fleet = {}, projects = null) {
  if (fleet?.wakeTriage?.shouldWake === true) return true
  const list = Array.isArray(projects)
    ? projects
    : (Array.isArray(fleet.projects) ? fleet.projects : [])
  return list.some(projectWorkflowActive)
}
