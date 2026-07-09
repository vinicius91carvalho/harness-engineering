import { isHarnessInfrastructureError } from './stuck-worker.mjs'

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
