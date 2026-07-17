/**
 * Host-wide supervisor remediations (fail-closed ops).
 * Pure planners — I/O stays in harness-control / ops-remediate.
 *
 * Supervisor must keep work moving: clear capacity ghosts, clear stale
 * index.lock, and escalate to the operator only when playbooks are exhausted.
 */

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const REMEDIATION_ESCALATE_AFTER = 3

function remainingOf(project = {}) {
  const progress = project.progress || project.counts || {}
  if (progress.remaining != null) return Math.max(0, Number(progress.remaining) || 0)
  return Math.max(0, Number(progress.total || 0) - Number(progress.integrated || 0))
}

/** Ledger remaining WIs, or Goal Review still owed after N/N integrate. */
function needsSupervisorWork(project = {}) {
  return remainingOf(project) > 0 || Boolean(project.needsGoalReviewRetry)
}

function isCompleteProject(project = {}) {
  const status = String(project.status || '')
  if (status === 'complete' || status === 'stopped') return true
  // N/N integrated but Goal Review not done is not "complete" for ops.
  if (project.needsGoalReviewRetry) return false
  const total = Number(project.progress?.total || project.counts?.total || 0)
  return total > 0 && remainingOf(project) === 0
}

/**
 * @param {object} params
 * @param {Array<object>} params.projects fleet project rows
 * @param {object} params.reservations map id -> reservation
 * @param {string|null} [params.blockerProjectId]
 * @param {string|null} [params.indexLockPath]
 * @param {boolean} [params.indexLockHeld]
 * @param {number} [params.indexLockAgeMs]
 */
export function planHostRemediation({
  projects = [],
  reservations = {},
  blockerProjectId = null,
  indexLockPath = null,
  indexLockHeld = false,
  indexLockAgeMs = 0,
} = {}) {
  const actions = []
  const events = []
  const rows = Array.isArray(projects) ? projects : []

  const blocker = blockerProjectId
    ? rows.find((p) => p.id === blockerProjectId) || null
    : rows.find((p) => Number(p.workers || 0) === 0 && needsSupervisorWork(p))
      || rows.find((p) => needsSupervisorWork(p))
      || null

  if (indexLockPath && existsSync(indexLockPath) && !indexLockHeld) {
    const ageOk = !Number.isFinite(indexLockAgeMs) || indexLockAgeMs >= 5_000
    if (ageOk) {
      actions.push({
        kind: 'clear_index_lock',
        path: indexLockPath,
        reason: 'stale index.lock with no live git holder',
      })
      events.push({
        kind: 'host_remediation',
        detail: { action: 'clear_index_lock', path: indexLockPath },
        immediate: false,
      })
    }
  }

  const reservationList = Object.values(reservations || {})
  const seen = new Set()
  const release = (row, reason) => {
    if (!row?.id || seen.has(row.id)) return
    seen.add(row.id)
    actions.push({
      kind: 'release_reservation',
      reservationId: row.id,
      projectId: row.projectId,
      context: row.context,
      reason,
    })
  }

  const blockerNeedsSlots = Boolean(
    blocker && needsSupervisorWork(blocker) && Number(blocker.workers || 0) === 0,
  )

  for (const row of reservationList) {
    const owner = rows.find((p) => p.id === row.projectId)
    const workers = Number(owner?.workers || 0)

    // Unbacked reservation: no live workers on the owning project.
    // Supervisor PID alone must not keep costing slots (goal-review reuse leak).
    if (!owner) {
      release(row, `reservation for unknown project ${row.projectId}`)
      continue
    }
    if (workers > 0) continue

    const complete = isCompleteProject(owner)
    const isGoalReview = row.context === 'goal-review' || row.resourceClass === 'goal-review'

    if (complete && isGoalReview) {
      release(row, `complete project ${owner.id} holds idle goal-review reservation`)
      continue
    }
    if (blockerNeedsSlots && owner.id !== blocker.id && (complete || isGoalReview)) {
      release(row, `sibling ${owner.id}/${row.context} starves blocker ${blocker.id}`)
      continue
    }
    // Ghost coding reservation while fleet empty on that project
    if (!isGoalReview && (owner.emptyFleetActionable || remainingOf(owner) > 0)) {
      release(row, `orphan ${owner.id}/${row.context} with workers=0`)
    }
  }

  // Idle complete sibling supervisors must not linger (false "running", RAM).
  for (const owner of rows) {
    if (!owner?.id || (blocker && owner.id === blocker.id)) continue
    if (!isCompleteProject(owner)) continue
    if (Number(owner.workers || 0) > 0) continue
    if (!owner.supervisorLive && !owner.supervisorPid) continue
    actions.push({
      kind: 'stop_idle_complete_supervisor',
      projectId: owner.id,
      root: owner.root || null,
      reason: `complete project ${owner.id} still has a live idle supervisor`,
    })
  }

  // Dead process supervisor with remaining work — restart without LLM Control Host.
  // Cursor chat / agent shells that `setsid` a supervisor often SIGTERM it on
  // session teardown; systemd ops-remediate must own durable restart via
  // harness-control start (detached + unref).
  // Also restart when the ledger is N/N but Goal Review is still owed
  // (`needsGoalReviewRetry`) — remaining WI count alone is 0 then, which used
  // to skip ensure and leave empty_fleet_actionable + interrupted forever
  // (CauseFlow root OSS, 2026-07-17, after WI-AC-026 integrate / GR SIGTERM).
  for (const owner of rows) {
    if (!owner?.id) continue
    const statusName = String(owner.status || '')
    if (statusName === 'paused' || statusName === 'stopped' || statusName === 'complete') continue
    if (!needsSupervisorWork(owner)) continue
    if (owner.supervisorLive) continue
    const why = remainingOf(owner) > 0
      ? `remaining=${remainingOf(owner)}`
      : 'needsGoalReviewRetry=true'
    actions.push({
      kind: 'ensure_supervisor_running',
      projectId: owner.id,
      root: owner.root || null,
      reason: `supervisorLive=false while ${why} status=${statusName || 'unknown'}`,
    })
  }

  if (actions.some((a) => a.kind === 'release_reservation')) {
    events.push({
      kind: 'host_remediation',
      detail: {
        action: 'release_reservations',
        count: actions.filter((a) => a.kind === 'release_reservation').length,
        blocker: blocker?.id || null,
      },
      immediate: false,
    })
  }
  if (actions.some((a) => a.kind === 'stop_idle_complete_supervisor')) {
    events.push({
      kind: 'host_remediation',
      detail: {
        action: 'stop_idle_complete_supervisors',
        count: actions.filter((a) => a.kind === 'stop_idle_complete_supervisor').length,
        blocker: blocker?.id || null,
      },
      immediate: false,
    })
  }
  if (actions.some((a) => a.kind === 'ensure_supervisor_running')) {
    events.push({
      kind: 'host_remediation',
      detail: {
        action: 'ensure_supervisor_running',
        count: actions.filter((a) => a.kind === 'ensure_supervisor_running').length,
        projects: actions
          .filter((a) => a.kind === 'ensure_supervisor_running')
          .map((a) => a.projectId),
      },
      immediate: false,
    })
  }

  const available = blocker?.capacity?.available
  const needsEscalation = Boolean(
    blocker
    && needsSupervisorWork(blocker)
    && Number(blocker.workers || 0) === 0
    && actions.length === 0
    && available === 0,
  )

  return {
    actions,
    events,
    blockerId: blocker?.id || null,
    needsEscalation,
  }
}

export function indexLockInfo(commonGit) {
  const path = join(commonGit, 'index.lock')
  if (!existsSync(path)) return { path, present: false, ageMs: 0 }
  let ageMs = 0
  try { ageMs = Date.now() - statSync(path).mtimeMs } catch { ageMs = 0 }
  return { path, present: true, ageMs }
}

export function shouldEscalateRemediation({
  attempts = 0,
  threshold = REMEDIATION_ESCALATE_AFTER,
  emptyFleetActionable = false,
  available = 0,
  remaining = 0,
  needsGoalReviewRetry = false,
} = {}) {
  if (remaining <= 0 && !needsGoalReviewRetry) return false
  if (!emptyFleetActionable && available > 0) return false
  return Number(attempts || 0) >= threshold
}

export function escalationReason({ blockerId, codes = [] } = {}) {
  const codeList = codes.length ? codes.join(', ') : 'unresolved host pressure'
  return `Supervisor could not auto-remediate (${codeList}) for project ${blockerId || 'unknown'}; operator action required`
}

export { remainingOf as remainingWorkFromProject }
