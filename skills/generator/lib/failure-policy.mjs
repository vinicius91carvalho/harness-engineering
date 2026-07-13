/** Failure classification, routing, authorization, and recovery decisions (single policy module). */

import { isHarnessInfrastructureError } from './worker-outcome.mjs'
import { enrichGuidanceWithEvidence } from './evidence-guidance.mjs'

export const FAILURE_CLASSES = [
  'product',
  'observation_mismatch',
  'infra',
  'quota',
  'merge_conflict',
  'capacity',
  'operational',
]

/** Subset used by defect reports and repair routing. */
export const DEFECT_CLASSES = [
  'product',
  'observation_mismatch',
  'infra',
  'quota',
  'merge_conflict',
]

export const REPAIR_ACTIONS = [
  'retry_same_host',
  'switch_candidate',
  'repair_plan',
  'block',
  'recycle',
  'pause',
]

/** Reasons the supervisor may retry without waiting for a human operator. */
export const AUTO_RETRY_PREFIXES = [
  'Retry could not resume the Claim Lease',
  'Worker exited with code',
  'Harness worker pane ended before run state completed',
  'Harness worker is idle or waiting',
  'integration could not complete',
]

const DURABLE_APPROVAL_PATTERNS = [
  /Integrated Verification failed after Attempt 3/i,
  /QA failed after Attempt 3/i,
  /Work Item blocked/i,
  /coding agent failed three times/i,
  /Claim Lease is stale on another host/i,
  /every coding candidate declined/i,
]

// ADR: observation_mismatch→repair_plan, infra→block.
const SAFE_RECOVERY_BY_CLASS = {
  product: 'repair_plan',
  observation_mismatch: 'repair_plan',
  infra: 'block',
  quota: 'provider_cooldown',
  merge_conflict: 'repair_plan',
  capacity: 'defer',
  operational: 'retry_same',
}

/** Infer defectClass from verdict JSON or free-text defects when agents omit the field. */
export function inferDefectClass(verdict = {}, text = '') {
  const explicit = String(verdict?.defectClass || verdict?.defect_class || '').trim()
  if (DEFECT_CLASSES.includes(explicit)) return explicit

  const blob = [
    text,
    ...(Array.isArray(verdict?.defects) ? verdict.defects : []),
    verdict?.reason,
    verdict?.notes,
  ].filter(Boolean).join('\n').toLowerCase()

  if (/\b(429|rate.?limit|usage limit|quota|out of (?:extra )?usage|credits?)\b/.test(blob)) {
    return 'quota'
  }
  if (/\b(observation method|static audit|grep.?only|should not (?:start|launch) (?:a )?(?:server|browser)|mintlify)\b/.test(blob)) {
    return 'observation_mismatch'
  }
  if (/\b(merge conflict|<<<<<<<|>>>>>>>)\b/.test(blob) || /\bmerge_conflict\b/.test(blob)) {
    return 'merge_conflict'
  }
  if (/\b(dynamo|bootstrap|EADDRINUSE|ENOENT|infra|wiring|repository still uses|oss runtime)\b/.test(blob)) {
    return 'infra'
  }
  return 'product'
}

/**
 * One classifier for agent exits, pending input reasons, and defect reports.
 * Delegates explicit defectClass and defect heuristics before exit-code fallbacks.
 */
export function classifyFailure({
  phase = '',
  exitCode = 0,
  stderr = '',
  stdout = '',
  defectClass = '',
  reason = '',
  capacitySlots = null,
  verdict = null,
} = {}) {
  if (capacitySlots === 0) {
    return { class: 'capacity', safeRecovery: 'defer', consumesAttempt: false }
  }

  const explicit = String(defectClass || '').trim()
  if (explicit && FAILURE_CLASSES.includes(explicit)) {
    return {
      class: explicit,
      safeRecovery: SAFE_RECOVERY_BY_CLASS[explicit] || 'repair_plan',
      consumesAttempt: explicit === 'product' || explicit === 'merge_conflict',
    }
  }

  const text = [reason, stderr, stdout].filter(Boolean).join('\n')
  const inferred = inferDefectClass(verdict || {}, text)
  if (inferred && inferred !== 'product') {
    return {
      class: inferred,
      safeRecovery: SAFE_RECOVERY_BY_CLASS[inferred] || 'repair_plan',
      consumesAttempt: inferred === 'merge_conflict',
    }
  }

  const lower = text.toLowerCase()
  if (/429|rate.?limit|quota|insufficient.?credit|no credits/.test(lower)) {
    return { class: 'quota', safeRecovery: 'provider_cooldown', consumesAttempt: false }
  }
  if (/\b402\b|payment required|billing/.test(lower)) {
    return { class: 'quota', safeRecovery: 'provider_cooldown', consumesAttempt: false }
  }
  if (/auth|unauthorized|login|api.?key|not logged/.test(lower)) {
    return { class: 'infra', safeRecovery: SAFE_RECOVERY_BY_CLASS.infra, consumesAttempt: false }
  }
  if (/merge conflict|conflict marker/.test(lower)) {
    return { class: 'merge_conflict', safeRecovery: 'repair_plan', consumesAttempt: true }
  }
  if (exitCode && exitCode !== 0 && phase !== 'QA' && phase !== 'INTEGRATED-QA') {
    return { class: 'operational', safeRecovery: 'retry_same', consumesAttempt: false }
  }
  return { class: 'product', safeRecovery: 'repair_plan', consumesAttempt: true }
}

/** Classify a durable Input Request reason string. */
export function classifyInputReason(reason = '') {
  return classifyFailure({ reason })
}

/** True when recovery must wait for a durable operator response (ADR-0016). */
export function requiresDurableApproval(reason = '') {
  const text = String(reason || '')
  return DURABLE_APPROVAL_PATTERNS.some((re) => re.test(text))
}

/**
 * Authorization: which recoveries may proceed without a durable user response.
 * Attempt exhaustion, blocked Work Items, and cross-host takeover require user authority.
 */
export function authorizeRecovery({ failureClass, safeRecovery, reason = '', scope = 'context', auto = false } = {}) {
  const text = String(reason || '')

  if (scope === 'goal' && !/^Worker exited with code/.test(text)) {
    return { allowed: false, requiresInputRequest: true, action: null }
  }
  if (requiresDurableApproval(text)) {
    return { allowed: false, requiresInputRequest: true, action: null }
  }
  if (failureClass === 'capacity' || safeRecovery === 'defer') {
    return { allowed: true, requiresInputRequest: false, action: 'defer' }
  }
  if (!auto) return { allowed: true, requiresInputRequest: false, action: safeRecovery }

  // Automatic path: only operational worker exits / idle / lease resume exhaustion (same host).
  const autoOk = AUTO_RETRY_PREFIXES.some((prefix) => text === prefix || text.startsWith(prefix))
  if (autoOk) return { allowed: true, requiresInputRequest: false, action: 'retry' }
  return { allowed: false, requiresInputRequest: true, action: null }
}

/** Combine classification and authorization for a recovery decision. */
export function recoveryDecision({
  reason = '',
  scope = 'context',
  auto = false,
  defectClass = '',
  phase = '',
  exitCode = 0,
  stderr = '',
  stdout = '',
  verdict = null,
} = {}) {
  const classified = classifyFailure({
    reason,
    defectClass,
    phase,
    exitCode,
    stderr,
    stdout,
    verdict,
  })
  const auth = authorizeRecovery({
    failureClass: classified.class,
    safeRecovery: classified.safeRecovery,
    reason,
    scope,
    auto,
  })
  return { ...classified, ...auth }
}

/** Whether a pending input reason may be auto-retried by the supervisor. */
export function isAutoRetryableReason(reason, { scope = 'context', detail = {} } = {}) {
  const decision = recoveryDecision({ reason, scope, auto: true })
  if (!decision.allowed || decision.action !== 'retry') return false
  if (scope === 'goal') {
    return String(reason || '').startsWith('Worker exited with code')
      && String(detail.log || '').includes('goal-review')
  }
  return AUTO_RETRY_PREFIXES.some((prefix) => reason === prefix || String(reason || '').startsWith(prefix))
}

/**
 * Defect-class repair routing: decide retry / switch host / block / recycle
 * without burning coding exhaustion or infra bugs as product retries.
 */
export function routeRepair(input = {}) {
  const {
    defectClass = 'product',
    phase = '',
    attempt = 1,
    maxAttempts = 3,
    healthVerdict = '',
    tailClass = '',
    inputReason = '',
    codingExhausted = false,
  } = input

  const reason = String(inputReason || '')

  if (codingExhausted || reason === 'coding agent failed three times'
    || reason.startsWith('coding agent failed three times')) {
    return {
      action: 'pause',
      defectClass: defectClass || 'product',
      autoRetry: false,
      guidance: 'Coding exhausted three attempts — pause for operator or stronger-host Repair Plan; do not auto-burn.',
    }
  }

  if (healthVerdict === 'stuck' && (tailClass === 'verdict_hung' || tailClass === 'mcp_warmup' || tailClass === 'spawn_silence')) {
    return {
      action: 'recycle',
      defectClass: 'infra',
      autoRetry: true,
      guidance: `Auto-recycle: worker ${tailClass}; resume after orchestrator restart (not a product defect).`,
    }
  }

  if (defectClass === 'quota' || /\b(429|rate.?limit|usage limit)\b/i.test(reason)) {
    return {
      action: 'switch_candidate',
      defectClass: 'quota',
      autoRetry: true,
      guidance: 'Quota/rate-limit — switch host/model candidate; do not retry same host.',
    }
  }

  if (defectClass === 'observation_mismatch') {
    return {
      action: 'repair_plan',
      defectClass: 'observation_mismatch',
      autoRetry: true,
      guidance: 'Observation-method mismatch — re-run QA/audit with the AC observation method; do not start coding.',
    }
  }

  if (defectClass === 'infra') {
    return {
      action: 'block',
      defectClass: 'infra',
      autoRetry: false,
      guidance: 'Infrastructure/bootstrap defect — block for structured repair; do not auto-retry coding.',
    }
  }

  if (defectClass === 'merge_conflict') {
    return {
      action: 'retry_same_host',
      defectClass: 'merge_conflict',
      autoRetry: true,
      guidance: 'Merge conflict — retry merge resolution on integration branch.',
    }
  }

  // product (default)
  if (attempt >= maxAttempts && /qa|integration/i.test(phase)) {
    return {
      action: 'repair_plan',
      defectClass: 'product',
      autoRetry: true,
      guidance: 'Product defects after max attempts — run Repair Plan then coding.',
    }
  }

  return {
    action: 'repair_plan',
    defectClass: 'product',
    autoRetry: true,
    guidance: 'Product defect — Repair Plan then smallest coding fix.',
  }
}

/** Map pending input reasons through the router for auto-respond eligibility. */
export function routePendingInput(request = {}) {
  const reason = String(request.reason || '')
  const codingExhausted = reason === 'coding agent failed three times'
    || reason.startsWith('coding agent failed three times')
  const routed = routeRepair({
    inputReason: reason,
    codingExhausted,
    defectClass: inferDefectClass({}, reason),
  })
  return routed
}

export function isAutoRetryableInput(request) {
  if (!request || request.status !== 'pending') return false
  const reason = String(request.reason || '')
  const routed = routePendingInput(request)
  if (!routed.autoRetry) return false
  return isAutoRetryableReason(reason, {
    scope: request.scope || 'context',
    detail: request.detail || {},
  })
}

export function autoRetryGuidance(request) {
  const reason = String(request?.reason || '')
  const detail = request?.detail || {}
  const routed = routePendingInput(request)
  if (routed.defectClass && routed.defectClass !== 'product') {
    return enrichGuidanceWithEvidence(routed.guidance, detail)
  }
  if (routed.action === 'pause' || routed.action === 'recycle') {
    return enrichGuidanceWithEvidence(routed.guidance, detail)
  }
  let base = 'Auto-retry: supervisor default retry without human input.'
  if (reason.startsWith('Retry could not resume the Claim Lease')) {
    base = 'Auto-retry: resume Claim Lease with force after bounded retry exhaustion.'
  } else if (reason.startsWith('Worker exited with code')) {
    base = 'Auto-retry: worker process exited; resume context after confirming worktree is healthy.'
  } else if (reason.startsWith('Harness worker pane ended before run state completed')) {
    base = 'Auto-retry: herdr pane shell ended before orchestrator wrote terminal run state; resume context.'
  } else if (reason === 'integration could not complete') {
    base = 'Auto-retry: integration merge/checkpoint failure; retry merge and integrated verification.'
  } else if (reason === 'Harness worker is idle or waiting') {
    base = 'Auto-retry: worker appeared idle while merge lock or turn boundary; resume.'
  }
  return enrichGuidanceWithEvidence(base, detail)
}

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
        guidance: queuedGuidance || autoRetryGuidance(request),
        at: new Date().toISOString(),
        auto: true,
      },
    })
  }
  return planned
}

/** Stuck herdr workers with infra errors must not auto-resume via retryQueue. */
export function shouldEnqueueStuckWorkerRetry(health) {
  return health?.tailClass !== 'infra_error'
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
  prevTailClass,
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

  if (result?.retryGoalReview) {
    return {
      action: 'goal_review_retry',
      guidance: result.summary || 'Retry Goal Review (ledger integrated; ignore feature_list flag drift)',
      strippedFlagDrift: result.strippedFlagDrift === true,
      clearGoalBlock: true,
    }
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

  const infraError = isHarnessInfrastructureError(tail) || prevTailClass === 'infra_error'
  if (infraError) {
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
