/** Failure classification and safe recovery decisions (not authorization). */

import { inferDefectClass } from './repair-router.mjs'

export const FAILURE_CLASSES = [
  'product',
  'observation_mismatch',
  'infra',
  'quota',
  'merge_conflict',
  'capacity',
  'operational',
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

// Values must stay aligned with routeRepair in repair-router.mjs (ADR: observation_mismatch→repair_plan, infra→block).
const SAFE_RECOVERY_BY_CLASS = {
  product: 'repair_plan',
  observation_mismatch: 'repair_plan',
  infra: 'block',
  quota: 'provider_cooldown',
  merge_conflict: 'repair_plan',
  capacity: 'defer',
  operational: 'retry_same',
}

/**
 * One classifier for agent exits, pending input reasons, and defect reports.
 * Delegates explicit defectClass and repair-router heuristics before exit-code fallbacks.
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
