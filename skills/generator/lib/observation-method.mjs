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

/**
 * Filter / reorder role candidates for QA / INTEGRATION_QA / GOAL_REVIEW.
 * Excludes weak harnesses (pi) as first picks when http/browser is required.
 */
export function filterCandidatesForObservation(candidates = [], methods = [], kind = '') {
  const validationKinds = new Set(['QA', 'INTEGRATION_QA', 'GOAL_REVIEW'])
  if (!validationKinds.has(kind) || !needsStrongValidationHost(methods)) {
    return candidates
  }
  const strong = candidates.filter((c) => !WEAK_VALIDATION_HARNESSES.has(c.harness))
  const weak = candidates.filter((c) => WEAK_VALIDATION_HARNESSES.has(c.harness))
  // Prefer strong hosts; keep weak only as last resort
  return strong.length ? [...strong, ...weak] : candidates
}
