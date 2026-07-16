/**
 * Map Acceptance Check category/description → observation method for host routing.
 * Methods: grep | cli | http | browser
 */

export const OBSERVATION_METHODS = ['grep', 'cli', 'http', 'browser']

/** Weak / no-MCP hosts unsuitable as first pick for http/browser validation. */
export const WEAK_VALIDATION_HARNESSES = new Set(['pi'])

/**
 * Infer observation method from AC category + description text.
 * Specs may later set observation="…" explicitly; until then, heuristic is enough.
 */
export function inferObservationMethod({ category = '', description = '', observation = '' } = {}) {
  const explicit = String(observation || '').trim().toLowerCase()
  if (OBSERVATION_METHODS.includes(explicit)) return explicit

  const cat = String(category || '').toLowerCase()
  const desc = String(description || '').toLowerCase()

  if (cat === 'static' || cat === 'audit' || /\b(grep|file audit|static audit|source contains)\b/.test(desc)) {
    return 'grep'
  }
  if (/\b(browser|playwright|puppeteer|spa at \/|clicking|dashboard renders)\b/.test(desc)) {
    return 'browser'
  }
  if (cat === 'functional' || /\b(http|api\/|\/api\/|sse|endpoint|jwt|status=)\b/.test(desc)) {
    return 'http'
  }
  if (/\b(cli|exit code|command line|npm test|cargo test)\b/.test(desc)) {
    return 'cli'
  }
  if (cat === 'functional') return 'http'
  return 'grep'
}

/** Aggregate observation methods for a Work Item from mapped ACs. */
export function workItemObservationMethods(item = {}, checksById = new Map()) {
  const methods = new Set()
  for (const id of item.acceptance_checks || []) {
    const check = checksById.get(id) || {}
    methods.add(inferObservationMethod({
      category: item.category || check.category,
      description: check.description || item.description,
      observation: check.observation || item.observation,
    }))
  }
  if (!methods.size) {
    methods.add(inferObservationMethod({
      category: item.category,
      description: item.description,
      observation: item.observation,
    }))
  }
  return [...methods]
}

/** True when validation/integration needs a real HTTP or browser boundary. */
export function needsStrongValidationHost(methods = []) {
  return methods.includes('http') || methods.includes('browser')
}

const VALIDATION_KINDS = new Set(['QA', 'INTEGRATION_QA', 'GOAL_REVIEW'])

/**
 * Filter role candidates for QA / INTEGRATION_QA / GOAL_REVIEW (Observation Hard Gate).
 * When http/browser is required, return only strong hosts — never admit weak as fallback.
 * CODING and other kinds pass candidates through unchanged (soft-align only).
 */
export function filterCandidatesForObservation(candidates = [], methods = [], kind = '') {
  if (!VALIDATION_KINDS.has(kind) || !needsStrongValidationHost(methods)) {
    return candidates
  }
  return candidates.filter((c) => !WEAK_VALIDATION_HARNESSES.has(c.harness))
}

/**
 * Fail-closed gate check after filtering validation hosts.
 * Returns { ok, reason } when the pool is empty but the Work Item needs http/browser.
 */
export function observationGateFailure(methods = [], kind = '', candidates = [], filtered = []) {
  if (!VALIDATION_KINDS.has(kind) || !needsStrongValidationHost(methods)) {
    return { ok: true, reason: null }
  }
  if (filtered.length > 0) {
    return { ok: true, reason: null }
  }
  const methodLabel = methods.filter((m) => m === 'http' || m === 'browser').join('/') || 'http/browser'
  if (!candidates.length) {
    return {
      ok: false,
      reason: `Observation Hard Gate: no validation hosts configured for ${kind} (${methodLabel} Work Item)`,
    }
  }
  const weakOnly = candidates.map((c) => c.harness).filter((h) => WEAK_VALIDATION_HARNESSES.has(h))
  return {
    ok: false,
    reason: `Observation Hard Gate: no eligible strong validation host for ${methodLabel} Work Item (configured: ${weakOnly.join(', ') || 'none'}; weak hosts excluded per ADR-0018)`,
  }
}

const ROLE_BY_KIND = {
  QA: 'validation',
  INTEGRATION_QA: 'validation',
  GOAL_REVIEW: 'goalReview',
}

/** Map supervisor admission mode / orchestrator phase to a validation routing kind. */
export function validationKindFromAdmission({ mode = '', phase = '' } = {}) {
  if (mode === 'goal-review') return 'GOAL_REVIEW'
  const normalized = String(phase || '').toLowerCase()
  if (normalized === 'integration-qa') return 'INTEGRATION_QA'
  if (normalized === 'qa' || normalized === 'qa-defect') return 'QA'
  return null
}

/**
 * Fail-closed Observation Hard Gate for supervisor admission (ADR-0018).
 * CODING and other phases pass through with ok: true.
 */
export function observationAdmissionCheck({
  kind = null,
  roles = null,
  observationMethods = [],
  host = 'default',
} = {}) {
  if (!kind || !VALIDATION_KINDS.has(kind)) {
    return { ok: true, reason: null }
  }
  const roleName = ROLE_BY_KIND[kind]
  const rawPool = roles?.[roleName]?.length
    ? roles[roleName]
    : [{ harness: host }]
  const filtered = filterCandidatesForObservation(rawPool, observationMethods, kind)
  return observationGateFailure(observationMethods, kind, rawPool, filtered)
}

/** Aggregate observation methods across a Work Item queue (Goal Review admission). */
export function observationMethodsForQueue(queue = []) {
  const methods = new Set()
  for (const item of queue) {
    for (const method of workItemObservationMethods(item)) methods.add(method)
  }
  if (!methods.size) methods.add('grep')
  return [...methods]
}
