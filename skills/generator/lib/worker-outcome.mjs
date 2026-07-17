import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { resultFileFromRunState } from './project-keys.mjs'
import { atomicJson, readJson } from './fs-json.mjs'

export { resultFileFromRunState }

// --- Verdict parsing (agent text → typed object) ---

export const VERDICT_BEGIN = '===HARNESS-VERDICT-BEGIN==='
export const VERDICT_END = '===HARNESS-VERDICT-END==='

export const VERDICT_HINT = `Emit that JSON as the very last thing you print, on its own lines, wrapped exactly:\n${VERDICT_BEGIN}\n{...}\n${VERDICT_END}`

function parseJsonObject(candidate) {
  try {
    const parsed = JSON.parse(candidate)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function delimitedVerdictBody(text, { requireEnd = false } = {}) {
  const source = String(text || '')
  const open = source.lastIndexOf(VERDICT_BEGIN)
  if (open < 0) return null
  const rest = source.slice(open + VERDICT_BEGIN.length)
  const close = rest.indexOf(VERDICT_END)
  if (requireEnd && close < 0) return null
  return (close >= 0 ? rest.slice(0, close) : rest).trim()
}

/** True when a full BEGIN…END verdict block is present (agent may hang after printing it). */
export function hasCompleteVerdict(text) {
  const body = delimitedVerdictBody(text, { requireEnd: true })
  return Boolean(body && parseJsonObject(body))
}

/**
 * Last parseable `{…}` in text. Evidence artifacts prepend `route={…}` metadata;
 * slicing from the first `{` to the last `}` then fails JSON.parse and used to
 * leave Goal Review recovery stuck on dirt-only result.json (CauseFlow root
 * 2026-07-17: AC-025/AC-026 product defects in goal_review log unread).
 */
function lastParseableJsonObject(text) {
  const source = String(text || '')
  const end = source.lastIndexOf('}')
  if (end < 0) return null
  for (let i = source.lastIndexOf('{', end); i >= 0; i = source.lastIndexOf('{', i - 1)) {
    const parsed = parseJsonObject(source.slice(i, end + 1))
    if (parsed) return parsed
  }
  return null
}

export function parseVerdict(text) {
  const trimmed = String(text || '').trim()
  const body = delimitedVerdictBody(trimmed)
  if (body != null) {
    const parsed = parseJsonObject(body)
    if (parsed) return parsed
  }
  const candidates = [trimmed, ...trimmed.split('\n').reverse()]
  const start = trimmed.indexOf('{'), end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1))
  for (const candidate of candidates) {
    const parsed = parseJsonObject(candidate)
    if (parsed) return parsed
  }
  // Prefer the rightmost parseable object after a first-brace slice fails
  // (route={…} preamble + trailing verdict JSON).
  return lastParseableJsonObject(trimmed)
}

/** True when Goal Review markers wrap empty/invalid JSON or prose pass lacks harness JSON. */
export function isMalformedGoalReviewVerdict(text = '') {
  const trimmed = String(text || '').trim()
  if (!trimmed) return false
  const parsed = parseVerdict(trimmed)
  if (parsed && typeof parsed.goal === 'boolean') return false

  const body = delimitedVerdictBody(trimmed)
  if (body != null) {
    if (!body) return true
    const value = parseJsonObject(body)
    if (!value || !('goal' in value)) return true
    return false
  }

  if (/\b(goal review )?(passed|passes)\b/i.test(trimmed)
    || /\bproject goal complete\b/i.test(trimmed)
    || /\b"?goal"?\s*:\s*true\b/i.test(trimmed)) {
    return true
  }
  return false
}

export function isProviderQuotaLimited(detail) {
  return /\b429\b|rate.?limit|usage limit|try again at|quota exceeded|too many requests/i.test(detail || '')
}

export function fallbackReason(result) {
  const detail = result.timedOut ? 'timeout' : result.detail || ''
  if (isProviderQuotaLimited(detail)) return 'rate-limited'
  if (/auth|credential|unauthorized|forbidden|login/i.test(detail)) return 'authentication-failure'
  if (/model.{0,40}(unavailable|not available|not found|unknown)|unavailable.{0,20}model/i.test(detail)) return 'model-unavailable'
  if (/\b402\b|insufficient credits|payment required|quota exceeded|billing/i.test(detail)) return 'no-credits'
  return result.timedOut ? 'launch-timeout' : 'launch-failure'
}

// --- Durable worker results (worker-result.json) ---

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
export function validateOutcome(value, { mode = null } = {}) {
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

export async function writeDurable(runStateFilePath, result) {
  const file = resultFileFromRunState(runStateFilePath)
  const payload = {
    at: new Date().toISOString(),
    exitCode: result.exitCode ?? 0,
    invocationId: result.invocationId || result.payload?.invocationId || null,
    leaseToken: result.leaseToken || result.payload?.leaseToken || null,
    reviewedHead: result.reviewedHead || result.payload?.reviewedHead || null,
    ...result.payload,
  }
  const verdict = validateOutcome(payload)
  if (!verdict.valid && verdict.mode !== 'unknown') {
    payload._validationErrors = verdict.errors
  }
  await atomicJson(file, payload)
  return file
}

export async function readDurable(runStateFilePath, { expectedInvocationId = null, expectedLeaseToken = null, expectedReviewedHead = null } = {}) {
  const file = resultFileFromRunState(runStateFilePath)
  const value = await readJson(file, null)
  if (!value || typeof value !== 'object') return null
  if (expectedInvocationId && value.invocationId && value.invocationId !== expectedInvocationId) return null
  if (expectedLeaseToken && value.leaseToken && value.leaseToken !== expectedLeaseToken) return null
  if (expectedReviewedHead && value.reviewedHead && value.reviewedHead !== expectedReviewedHead) return null
  if (expectedInvocationId && !value.invocationId) return null
  if (expectedLeaseToken && !value.leaseToken) return null
  return value
}

export async function clearWorkerResult(runStateFilePath) {
  const file = resultFileFromRunState(runStateFilePath)
  try { await import('node:fs/promises').then(({ unlink }) => unlink(file)) } catch {}
}

// --- Closed outcome interpretation (log tail + durable + run state) ---

/**
 * Infer a durable worker outcome when the orchestrator did not write worker-result.json.
 * Used by the supervisor after a worker process exits.
 */
export function interpretClosed({
  key,
  tail,
  persisted,
  runState,
  featureIds,
  queue,
  integrationHead = null,
} = {}) {
  let result = persisted ? { ...persisted, durable: true } : null
  if (!result) result = parseVerdict(tail)
  if (!result && key === 'goal-review' && isMalformedGoalReviewVerdict(tail)) {
    result = {
      goal: false,
      retryGoalReview: true,
      summary: 'Goal Review returned empty or malformed verdict; retry',
      malformedVerdict: true,
    }
  }
  if (!result) {
    // Never infer goal:true from a stale Run State alone — reviewedHead must
    // match the current integration HEAD (jobs-done detection).
    const reviewedHead = runState.reviewedHead || persisted?.reviewedHead || null
    if (
      key === 'goal-review'
      && runState.status === 'complete'
      && runState.phase === 'complete'
      && reviewedHead
      && integrationHead
      && reviewedHead === integrationHead
    ) {
      result = { goal: true, summary: runState.lastResult, durable: true, reviewedHead }
    } else if (key === 'goal-review' && runState.status === 'complete' && runState.phase === 'defects-found') {
      result = {
        goal: false,
        reopened: queue.filter((item) => item.integration !== true).map((item) => item.id),
        summary: runState.lastResult,
        durable: true,
      }
    } else if (runState.status === 'blocked') {
      // Prefer durable result.json fields (defects / acceptanceCheckIds) when the
      // orchestrator blocked after writing them — lastResult alone often loses ACs.
      result = {
        blocked: true,
        summary: persisted?.summary || runState.lastResult,
        defects: Array.isArray(persisted?.defects) ? persisted.defects : undefined,
        acceptanceCheckIds: Array.isArray(persisted?.acceptanceCheckIds)
          ? persisted.acceptanceCheckIds
          : undefined,
        goal: typeof persisted?.goal === 'boolean' ? persisted.goal : false,
        durable: true,
      }
    } else if (key !== 'goal-review' && runState.status === 'complete') {
      const selected = queue.filter((item) => featureIds.includes(item.id))
      if (selected.length === featureIds.length && selected.every((item) => item.integration === true)) {
        result = { total: selected.length, passed: selected.length, stuck: [], durable: true }
      }
    }
  }
  if (result) {
    const verdict = validateOutcome(result)
    if (!verdict.valid && verdict.mode !== 'unknown') {
      result = { ...result, _validationErrors: verdict.errors }
    }
  }
  return result
}

// --- Stuck detection helpers + infra noise ---

export function stuckThresholdMs() {
  return Number(process.env.HARNESS_STUCK_TIMEOUT_MS || 600_000)
}

/**
 * Worktree `.harness/` files that prove agent progress without harness-control
 * worker-log bytes (Cursor `agent` often leaves those logs empty).
 * Includes WI verify/probe artifacts and Goal Review compose/HTTP side channels.
 */
export function isWorkerSideChannelArtifact(name = '') {
  const n = String(name || '')
  if (/^wi[-_]ac[-_]/i.test(n) && /\.(json|log|txt)$/i.test(n)) return true
  if (/^goal-review/i.test(n) && /\.(json|log|txt)$/i.test(n)) return true
  if (n === 'runtime-owned.jsonl') return true
  if (/^gr[-_]/i.test(n) && /\.(json|log|txt|pid)$/i.test(n)) return true
  return false
}

/**
 * Side-channel activity for Cursor `agent` (and similar) hosts: harness-control
 * worker logs often stay empty because agent stdout is captured inside
 * `runHostAgentSession` and never reaches the orchestrator pipe, while shell
 * tools (browser probes, verify-first JSON, Goal Review compose/runtime
 * manifests) still advance files under the worktree / evidence dir without
 * calling `onAgentOutput`.
 *
 * `worktree` may be supplied explicitly when Run State omits it (common for
 * claim-less Goal Review — supervisor `state.workers[].worktree` is authoritative).
 */
export async function workerSideChannelActivityAgeMs({
  runState,
  worktree = null,
  now = Date.now(),
} = {}) {
  const ages = []
  const evidence = runState?.evidence
  if (evidence) {
    try {
      const info = await stat(evidence)
      ages.push(Math.max(0, now - info.mtimeMs))
    } catch { /* missing */ }
  }
  const wt = worktree || runState?.worktree || null
  if (wt) {
    try {
      const harnessDir = join(wt, '.harness')
      const names = await readdir(harnessDir)
      let newest = 0
      for (const name of names) {
        if (!isWorkerSideChannelArtifact(name)) continue
        try {
          const info = await stat(join(harnessDir, name))
          if (info.mtimeMs > newest) newest = info.mtimeMs
        } catch { /* skip */ }
      }
      if (newest > 0) ages.push(Math.max(0, now - newest))
    } catch { /* no .harness */ }
  }
  if (!ages.length) return null
  return Math.min(...ages)
}

/** True when a PID exists (or is alive but unsignalable — treat as live). */
export function workerPidAlive(pid) {
  const n = Number(pid)
  if (!Number.isFinite(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (error) {
    if (error?.code === 'EPERM') return true
    return false
  }
}

/**
 * Age since last *agent* progress. Orchestrator heartbeats alone must not keep a
 * silent coding/QA agent "healthy" — empty logs with null lastAgentOutputAt are
 * stuck once past the threshold from start, unless worktree/evidence side
 * channels show recent probe/verify progress (common with Cursor agent).
 *
 * A live Run State `childPid` (host agent) also counts as progress: long
 * browser/investigation polls (e.g. AC-025) can freeze `.harness/wi-ac-*`
 * mtimes for > stuck-threshold while the agent + probe are still working
 * (CauseFlow root oss-golden-path 2026-07-17: false stuck → exit 130 mid-QA).
 */
export async function workerActivityAgeMs({
  logFile,
  runState,
  worktree = null,
  now = Date.now(),
} = {}) {
  const started = Date.parse(String(
    runState?.startedAt || runState?.codingStartedAt || runState?.createdAt || '',
  ))
  const startedAge = Number.isFinite(started) ? Math.max(0, now - started) : null
  const childAlive = workerPidAlive(runState?.childPid)

  if (runState?.lastAgentOutputAt) {
    const ts = Date.parse(runState.lastAgentOutputAt)
    if (Number.isFinite(ts)) return Math.max(0, now - ts)
  }

  const sideAge = await workerSideChannelActivityAgeMs({ runState, worktree, now })
  const threshold = stuckThresholdMs()
  // Live host-agent child: trust fresh side-channels; otherwise grace through
  // long browser investigation polls that freeze wi-ac JSON mtimes (and ignore
  // stale leftover artifacts from prior attempts). Fail closed after 3× threshold.
  if (childAlive) {
    if (sideAge != null && sideAge < threshold) return sideAge
    const grace = threshold * 3
    if (startedAge == null || startedAge < grace) return 0
  }
  if (logFile) {
    try {
      const info = await stat(logFile)
      if (info.size > 0) {
        const logAge = Math.max(0, now - info.mtimeMs)
        return sideAge == null ? logAge : Math.min(logAge, sideAge)
      }
      // Empty log ≠ silent when verify/evidence artifacts are advancing.
      if (sideAge != null) return sideAge
      // Empty log = no agent output. Prefer run start age (file may be freshly touched).
      if (startedAge != null) return startedAge
      const born = Number(info.birthtimeMs) || Number(info.mtimeMs) || now
      return Math.max(0, now - born)
    } catch { /* missing log */ }
  }

  if (sideAge != null) return sideAge
  if (startedAge != null) return startedAge

  // No agent signal and no start time — fail-closed as maximally stale.
  return Number.POSITIVE_INFINITY
}

export async function isWorkerStuck({
  logFile,
  runState,
  worktree = null,
  thresholdMs = stuckThresholdMs(),
} = {}) {
  const age = await workerActivityAgeMs({ logFile, runState, worktree })
  return age >= thresholdMs
}

export function isWorkerStuckByHealth(health) {
  return health?.verdict === 'stuck' && health?.recycle === true
}

export function isInfraNoise(text = '') {
  const blob = String(text || '')
  return /(?:^|\n)(?:orchestrator:|claim\.sh:|reconcile:|harness-control:)/.test(blob)
    || /\b(ENOENT|EACCES|syntax error|timed out waiting for merge lock|timed out waiting for state lock)\b/.test(blob)
    || /\bSession terminated, killing shell\b/i.test(blob)
    || /\bsession limit\b/i.test(blob)
    || /\borphanShell\b/i.test(blob)
    || /\bhost (?:kill|death|terminated)\b/i.test(blob)
    || /\bkilling shell\b/i.test(blob)
    || /\bpane ended before run state completed\b/i.test(blob)
}
