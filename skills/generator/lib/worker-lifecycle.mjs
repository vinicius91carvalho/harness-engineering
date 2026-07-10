import { spawnSync } from 'node:child_process'
import { isHarnessInfrastructureError } from './stuck-worker.mjs'

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
  if (worker.type === 'herdr' && (worker.paneId || worker.tabId)) {
    return { kind: 'close_display', paneId: worker.paneId, tabId: worker.tabId }
  }
  const pid = worker.child?.pid || worker.childPid || worker.ownedResources?.processGroup || null
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
  if (process.platform !== 'win32') {
    try {
      spawnSync('pkill', [`-${sig === 'SIGKILL' ? '9' : '15'}`, '-P', String(pid)], { stdio: 'ignore' })
      try { process.kill(-pid, sig) } catch {}
    } catch {}
  }
  try { process.kill(pid, sig) } catch {}
  return { terminated: true, pid, signal: sig }
}

/**
 * Pure action plan for supervisor worker close handling.
 * Side effects are applied by harness-control from this plan.
 */
export function planWorkerClosedActions({
  key,
  exitCode,
  tail,
  result,
  rateLimited,
  crashCount,
  harnessRepairs,
  retryQueue,
  autoRepair,
  logFile,
}) {
  if (rateLimited) {
    return {
      action: 'quota_retry',
      context: key,
      guidance: 'Provider quota/rate limit; retry automatically after the quota window',
      clearCrashCount: true,
    }
  }

  if (result?.goal === true) {
    if (Object.keys(retryQueue || {}).length === 0) {
      return { action: 'goal_complete', result }
    }
    return { action: 'pending_goal', result }
  }

  if (result?.reopened?.length) {
    return {
      action: 'goal_defects',
      reopened: result.reopened,
      defects: result.defects,
    }
  }

  if (result?.blocked || result?.stuck?.length) {
    const goal = key === 'goal-review'
    return {
      action: 'blocked_input',
      scope: goal ? 'goal' : 'context',
      context: goal ? null : key,
      reason: result.summary || result.stuck?.[0]?.reason || 'Execution blocked',
      detail: result,
    }
  }

  if (exitCode === 0 && result?.stuck?.length === 0) {
    return {
      action: 'release',
      context: key,
      passed: result.passed,
      total: result.total,
      clearCrashCount: true,
    }
  }

  const goal = key === 'goal-review'
  const lastLine = tail.trim().split('\n').filter(Boolean).pop()?.slice(0, 200)
  const reason = lastLine
    ? `Worker exited with code ${exitCode}: ${lastLine}`
    : `Worker exited with code ${exitCode}`

  if (isHarnessInfrastructureError(tail)) {
    if (autoRepair && !harnessRepairs?.[key]) {
      return {
        action: 'harness_repair',
        context: key,
        guidance: `Fix harness infrastructure issue, then retry: ${lastLine || reason}`,
        logFile,
        clearCrashCount: true,
        emitHarnessIssue: { reason, logFile },
      }
    }
    return {
      action: 'blocked_input',
      scope: goal ? 'goal' : 'context',
      context: goal ? null : key,
      reason,
      detail: { log: logFile },
      emitHarnessIssue: { reason, logFile },
    }
  }

  return {
    action: 'crash_input',
    scope: goal ? 'goal' : 'context',
    context: goal ? null : key,
    reason,
    detail: { log: logFile },
    incrementCrashCount: true,
    crashCount: (crashCount || 0) + 1,
  }
}
