/**
 * Defect-class repair routing: decide retry / switch host / block / recycle
 * without burning coding exhaustion or infra bugs as product retries.
 */

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
 * @param {object} input
 * @param {string} [input.defectClass]
 * @param {string} [input.phase]
 * @param {number} [input.attempt]
 * @param {number} [input.maxAttempts]
 * @param {string} [input.healthVerdict] from worker-health
 * @param {string} [input.tailClass]
 * @param {string} [input.inputReason] pending input_required reason
 * @param {boolean} [input.codingExhausted]
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

  if (healthVerdict === 'stuck' && (tailClass === 'verdict_hung' || tailClass === 'mcp_warmup')) {
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
