import { resultFileFromRunState } from './project-keys.mjs'
import { atomicJson, readJson } from './fs-json.mjs'

export { resultFileFromRunState }

/** Executable verdict shapes the supervisor accepts from worker-result.json. */
export const WORKER_VERDICT_SCHEMAS = {
  goalReview: {
    detect: (value) => value && typeof value === 'object' && 'goal' in value,
    required: ['goal'],
    optional: ['summary', 'defects', 'reopened', 'blocked', 'exhausted', 'reviewedHead'],
    types: { goal: 'boolean' },
  },
  workItems: {
    detect: (value) => value && typeof value === 'object' && ('total' in value || 'passed' in value || Array.isArray(value.stuck)),
    required: [],
    anyOf: [['total', 'passed'], ['stuck']],
    optional: ['results', 'blocked', 'summary'],
    types: { total: 'number', passed: 'number', blocked: 'boolean' },
  },
  blocked: {
    detect: (value) => value?.blocked === true || (Array.isArray(value?.stuck) && value.stuck.length > 0),
    required: [],
    anyOf: [['blocked'], ['stuck']],
    optional: ['summary', 'reason', 'defects'],
    types: { blocked: 'boolean' },
  },
}

function hasFields(value, fields) {
  return fields.every((field) => field in value)
}

function typeOk(value, field, expected) {
  if (!(field in value)) return true
  return typeof value[field] === expected
}

/**
 * Validate a worker verdict payload before the supervisor acts on it.
 * Returns { valid, mode, errors, value }.
 */
export function validateWorkerVerdict(value, { mode = null } = {}) {
  if (!value || typeof value !== 'object') {
    return { valid: false, mode: mode || 'unknown', errors: ['not-an-object'], value: null }
  }

  const resolvedMode = mode || Object.entries(WORKER_VERDICT_SCHEMAS).find(([, schema]) => schema.detect(value))?.[0] || 'unknown'
  const schema = WORKER_VERDICT_SCHEMAS[resolvedMode]
  if (!schema) {
    return { valid: false, mode: resolvedMode, errors: ['unknown-verdict-mode'], value }
  }

  const errors = []
  if (schema.required?.length && !hasFields(value, schema.required)) {
    errors.push(`missing required: ${schema.required.filter((field) => !(field in value)).join(', ')}`)
  }
  if (schema.anyOf?.length && !schema.anyOf.some((group) => hasFields(value, group))) {
    errors.push(`needs one of: ${schema.anyOf.map((group) => group.join('+')).join(' | ')}`)
  }
  for (const [field, expected] of Object.entries(schema.types || {})) {
    if (!typeOk(value, field, expected)) errors.push(`${field} must be ${expected}`)
  }
  if (resolvedMode === 'goalReview' && 'goal' in value && typeof value.goal !== 'boolean') {
    errors.push('goal must be boolean')
  }

  return { valid: errors.length === 0, mode: resolvedMode, errors, value }
}

export async function writeWorkerResult(runStateFilePath, result) {
  const file = resultFileFromRunState(runStateFilePath)
  const payload = {
    at: new Date().toISOString(),
    exitCode: result.exitCode ?? 0,
    invocationId: result.invocationId || result.payload?.invocationId || null,
    leaseToken: result.leaseToken || result.payload?.leaseToken || null,
    reviewedHead: result.reviewedHead || result.payload?.reviewedHead || null,
    ...result.payload,
  }
  const verdict = validateWorkerVerdict(payload)
  if (!verdict.valid && verdict.mode !== 'unknown') {
    payload._validationErrors = verdict.errors
  }
  await atomicJson(file, payload)
  return file
}

export async function readWorkerResult(runStateFilePath, { expectedInvocationId = null, expectedLeaseToken = null, expectedReviewedHead = null } = {}) {
  const file = resultFileFromRunState(runStateFilePath)
  const value = await readJson(file, null)
  if (!value || typeof value !== 'object') return null
  if (expectedInvocationId && value.invocationId && value.invocationId !== expectedInvocationId) return null
  if (expectedLeaseToken && value.leaseToken && value.leaseToken !== expectedLeaseToken) return null
  if (expectedReviewedHead && value.reviewedHead && value.reviewedHead !== expectedReviewedHead) return null
  // Stale unscoped results (no invocation identity) are rejected when a current invocation is required.
  if (expectedInvocationId && !value.invocationId) return null
  if (expectedLeaseToken && !value.leaseToken) return null
  return value
}

export async function clearWorkerResult(runStateFilePath) {
  const file = resultFileFromRunState(runStateFilePath)
  try { await import('node:fs/promises').then(({ unlink }) => unlink(file)) } catch {}
}
