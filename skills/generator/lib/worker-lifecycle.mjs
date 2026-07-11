import { spawnSync } from 'node:child_process'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export { planWorkerClosedActions, shouldEnqueueStuckWorkerRetry } from './failure-policy.mjs'

/**
 * Shared supervisor worker runtime plans.
 * harness-control applies side effects from these pure builders.
 */

export function ownedResourcesForClaim(claim) {
  return {
    port: claim?.port ?? null,
    worktree: claim?.worktree ?? null,
    profileDir: claim?.profileDir ?? null,
    processGroup: null,
  }
}

export function buildOrchestratorArgv({
  orchestrator,
  repo,
  host,
  claim,
  guidance = '',
  mode = 'work-items',
}) {
  const args = [
    orchestrator,
    '--host', host,
    '--repo', repo,
    '--workdir', claim.worktree,
    '--context', claim.context,
    '--port', String(claim.port),
    '--features', (claim.featureIds || []).join(','),
  ]
  if (mode === 'goal-review') {
    args.push('--mode', 'goal-review')
  }
  if (guidance) args.push('--guidance', guidance)
  return args
}

export function buildWorkerBase({ claim, logFile, reservationId = null }) {
  return {
    governorReservationId: reservationId,
    context: claim.context,
    featureIds: claim.featureIds || [],
    worktree: claim.worktree,
    port: claim.port,
    startedAt: new Date().toISOString(),
    logFile,
    ownedResources: ownedResourcesForClaim(claim),
  }
}

export function workerLogFileName(context) {
  if (context === 'goal-review') return `goal-review-${Date.now()}.log`
  return `${String(context).replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}.log`
}

/** Persist herdr pane tail so workerClosed can classify infra errors after the pane is gone. */
export async function persistWorkerPaneTail(logFile, tailText) {
  if (!logFile || !String(tailText || '').trim()) return false
  await mkdir(dirname(logFile), { recursive: true })
  const marker = '\n--- supervisor captured pane tail ---\n'
  await appendFile(logFile, `${marker}${tailText}\n`, 'utf8')
  return true
}

export function planWorkerHerdrMeta({
  claim,
  projectId,
  role,
  taskId,
  retry,
}) {
  const key = claim.context
  return {
    agentName: `worker-${projectId}-${key}`,
    taskId: taskId || claim.featureIds?.[0] || claim.context || key,
    role: role || (key === 'goal-review' ? 'goal-review' : 'coding'),
    project: projectId,
    retry: Math.max(1, Number(retry) || 1),
    cwd: claim.worktree,
  }
}

export function planWorkerStop(worker, { signal = 'SIGTERM' } = {}) {
  if (!worker) return { kind: 'noop' }
  const pid = worker.child?.pid || worker.childPid || worker.ownedResources?.processGroup || null
  // Herdr: close the pane, but always terminate the orchestrator tree when known —
  // pane-only stop left tsx/next/compose children holding RAM after "kill-worker".
  if (worker.type === 'herdr' && (worker.paneId || worker.tabId)) {
    return {
      kind: 'close_display',
      paneId: worker.paneId,
      tabId: worker.tabId,
      alsoTerminatePid: pid,
      signal,
    }
  }
  if (pid) return { kind: 'terminate_tree', pid, signal }
  return { kind: 'noop' }
}

export function planWorkerCleanupTargets(worker) {
  const owned = worker?.ownedResources || {}
  return {
    port: owned.port ?? worker?.port ?? null,
    workdir: owned.worktree ?? worker?.worktree ?? null,
    profileDir: owned.profileDir ?? null,
  }
}

export function terminateProcessTree(pid, signal = 'SIGTERM') {
  if (!pid) return { terminated: false }
  const sig = signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM'
  const killArg = sig === 'SIGKILL' ? '-9' : '-15'
  if (process.platform !== 'win32') {
    try {
      spawnSync('pkill', [`-${sig === 'SIGKILL' ? '9' : '15'}`, '-P', String(pid)], { stdio: 'ignore' })
      try { process.kill(-pid, sig) } catch {}
    } catch {}
    // Prefer the kill(1) binary — some sandboxes no-op Node process.kill.
    spawnSync('kill', [killArg, String(pid)], { stdio: 'ignore' })
  }
  try { process.kill(pid, sig) } catch {}
  return { terminated: true, pid, signal: sig }
}
