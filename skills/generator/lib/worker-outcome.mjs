import { stat } from 'node:fs/promises'
import { resultFileFromRunState } from './project-keys.mjs'
import { atomicJson, readJson } from './fs-json.mjs'

export { resultFileFromRunState }

// --- Verdict parsing (agent text → typed object) ---

export const VERDICT_BEGIN = '===HARNESS-VERDICT-BEGIN==='
export const VERDICT_END = '===HARNESS-VERDICT-END==='

export const VERDICT_HINT = `Emit that JSON as the very last thing you print, on its own lines, wrapped exactly:\n${VERDICT_BEGIN}\n{...}\n${VERDICT_END}`

/** True when a full BEGIN…END verdict block is present (agent may hang after printing it). */
export function hasCompleteVerdict(text) {
  const open = String(text || '').lastIndexOf(VERDICT_BEGIN)
  if (open < 0) return false
  const rest = text.slice(open + VERDICT_BEGIN.length)
  const close = rest.indexOf(VERDICT_END)
  if (close < 0) return false
  const body = rest.slice(0, close).trim()
  try {
    const v = JSON.parse(body)
    return Boolean(v && typeof v === 'object')
  } catch {
    return false
  }
}

export function parseVerdict(text) {
  const trimmed = text.trim()
  const open = trimmed.lastIndexOf(VERDICT_BEGIN)
  if (open >= 0) {
    const rest = trimmed.slice(open + VERDICT_BEGIN.length)
    const close = rest.indexOf(VERDICT_END)
    const body = (close >= 0 ? rest.slice(0, close) : rest).trim()
    try { const v = JSON.parse(body); if (v && typeof v === 'object') return v } catch {}
  }
  const candidates = [trimmed, ...trimmed.split('\n').reverse()]
  const start = trimmed.indexOf('{'), end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1))
  for (const candidate of candidates) {
    try { const parsed = JSON.parse(candidate); if (parsed && typeof parsed === 'object') return parsed } catch {}
  }
  return null
}

/** @deprecated use parseVerdict */
export const parseObject = parseVerdict

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

/** @deprecated use validateOutcome */
export const validateWorkerVerdict = validateOutcome

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

/** @deprecated use writeDurable */
export const writeWorkerResult = writeDurable

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

/** @deprecated use readDurable */
export const readWorkerResult = readDurable

export async function clearWorkerResult(runStateFilePath) {
  const file = resultFileFromRunState(runStateFilePath)
  try { await import('node:fs/promises').then(({ unlink }) => unlink(file)) } catch {}
}

// --- Closed outcome interpretation (pane tail + durable + run state) ---

/**
 * Infer a durable worker outcome when the orchestrator did not write worker-result.json.
 * Used by the supervisor after a worker process exits.
 */
export function interpretClosed({ key, tail, persisted, runState, featureIds, queue }) {
  let result = persisted ? { ...persisted, durable: true } : null
  if (!result) result = parseVerdict(tail)
  if (!result) {
    if (key === 'goal-review' && runState.status === 'complete' && runState.phase === 'complete') {
      result = { goal: true, summary: runState.lastResult, durable: true }
    } else if (key === 'goal-review' && runState.status === 'complete' && runState.phase === 'defects-found') {
      result = {
        goal: false,
        reopened: queue.filter((item) => item.integration !== true).map((item) => item.id),
        summary: runState.lastResult,
        durable: true,
      }
    } else if (runState.status === 'blocked') {
      result = { blocked: true, summary: runState.lastResult, durable: true }
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

/** @deprecated use interpretClosed */
export const interpretWorkerOutcome = interpretClosed

// --- Live health (pane signals → verdict / recycle) ---

export const TAIL_CLASSES = [
  'thinking',
  'tooling',
  'verdict_hung',
  'merge_lock',
  'mcp_warmup',
  'prompt',
  'idle_shell',
  'infra_error',
  'unknown',
]

export const HEALTH_VERDICTS = ['healthy', 'waiting_expected', 'stuck', 'done']

const HEALTH_DEFAULTS = {
  agentOutputStuckMs: Number(process.env.HARNESS_AGENT_OUTPUT_STUCK_MS || 600_000),
  mcpWarmupBudgetMs: Number(process.env.HARNESS_MCP_WARMUP_BUDGET_MS || 90_000),
  verdictHangMs: Number(process.env.HARNESS_VERDICT_HANG_MS || 60_000),
}

/** True if line is orchestrator pane heartbeat, not real agent progress. */
export function isPaneHeartbeatLine(line = '') {
  return /^agent:\s+(still working|still waiting for first token|waiting for first token|started |harness verdict received|working…)/i.test(line.trim())
    || /^agent:\s+.*\(.*s since last log\)/i.test(line.trim())
}

export function classifyPaneTail(tail = '') {
  const text = String(tail || '')
  if (!text.trim()) return 'unknown'
  const lower = text.toLowerCase()
  const lines = text.trim().split('\n').filter(Boolean)
  const recent = lines.slice(-12).join('\n')
  const recentLower = recent.toLowerCase()

  if (/waiting for merge lock/i.test(recent)) return 'merge_lock'
  if (/\b(ENOENT|EACCES|syntax error|timed out waiting for merge lock|timed out waiting for state lock)\b/i.test(recent)
    || /(?:^|\n)(?:orchestrator:|claim\.sh:|reconcile:|harness-control:).*(?:error|fatal|failed)/i.test(recent)) {
    return 'infra_error'
  }
  if (/\b(input required|press enter|choose an option|y\/n)\b/i.test(recentLower)) return 'prompt'

  const verdictSplit = text.split(/===HARNESS-VERDICT-(?:BEGIN|END)===/)
  const postVerdict = verdictSplit.length > 1 ? verdictSplit[verdictSplit.length - 1] : ''
  const hasVerdict = verdictSplit.length > 1
    || /agent:\s+harness verdict received/i.test(text)
  const postWindow = hasVerdict ? (postVerdict || recent) : recent
  const afterVerdict = hasVerdict && (
    /agent:\s+(still working|verdict received)/i.test(postWindow)
    || /agent:\s+(still working|verdict received)/i.test(recent)
    || lines.slice(-5).every((line) => isPaneHeartbeatLine(line) || !line.trim())
  )
  const postTailLines = postWindow.trim().split('\n').filter(Boolean).slice(-3).join('\n')
  if (afterVerdict
    && !/\btool\s*(?:→|->)/.test(postWindow)
    && !/^thinking:/im.test(postTailLines)) {
    return 'verdict_hung'
  }

  if (/still waiting for first token|waiting for first token.*MCP/i.test(recent)
    || (/agent:\s+started/i.test(recent) && !/^thinking:/im.test(recent) && !/\btool\s*(?:→|->)/.test(recent))) {
    if (!/^thinking:/im.test(recent) && !/\btool\s*(?:→|->)/.test(recent)) return 'mcp_warmup'
  }

  if (/\btool\s*(?:→|->)/.test(recent) || /\btool\s*[✓✔]/.test(recent)) return 'tooling'
  if (/^thinking:/im.test(recent) || /\bthinking:/i.test(recent)) return 'thinking'

  const last = lines[lines.length - 1] || ''
  if (!/\borchestrator:/i.test(last)
    && !/\bscript -q -e -c\b/.test(last)
    && !/\bHARNESS-VERDICT-(BEGIN|END)\b/.test(last)
    && /[❯›]\s*$/.test(last)) {
    return 'idle_shell'
  }

  return 'unknown'
}

/**
 * @param {object} signals
 * @param {number} [signals.runStateAgeMs] age of run-state heartbeat
 * @param {boolean} [signals.childAlive]
 * @param {string} [signals.paneStatus] herdr agent_status
 * @param {number} [signals.scrollDelta] change in scroll.max_offset_from_bottom since last sample
 * @param {string} [signals.tailText]
 * @param {number|null} [signals.lastAgentOutputAgeMs] age since last thinking/tool output (null = unknown)
 * @param {string} [signals.runStatus] complete|blocked|failed|running|…
 * @param {boolean} [signals.mergeHolderAlive] when tail is merge_lock
 * @param {object} [signals.thresholds]
 */
export function assessLive(signals = {}) {
  const {
    runStateAgeMs = 0,
    childAlive = false,
    paneStatus = 'unknown',
    scrollDelta = 0,
    tailText = '',
    lastAgentOutputAgeMs = null,
    runStatus = '',
    mergeHolderAlive = true,
    thresholds = {},
  } = signals
  const cfg = { ...HEALTH_DEFAULTS, ...thresholds }
  const tailClass = classifyPaneTail(tailText)
  const terminal = ['complete', 'blocked', 'failed'].includes(runStatus)

  if (terminal || (tailClass === 'idle_shell' && !childAlive)) {
    return {
      verdict: 'done',
      tailClass,
      reason: terminal ? `run status ${runStatus}` : 'idle shell without child',
      recycle: false,
    }
  }

  if (tailClass === 'merge_lock') {
    if (mergeHolderAlive === false) {
      return {
        verdict: 'stuck',
        tailClass,
        reason: 'merge lock holder process is dead',
        recycle: true,
      }
    }
    return {
      verdict: 'waiting_expected',
      tailClass,
      reason: 'waiting for merge lock (holder alive)',
      recycle: false,
    }
  }

  if (tailClass === 'prompt' || paneStatus === 'blocked') {
    return {
      verdict: 'waiting_expected',
      tailClass: tailClass === 'unknown' ? 'prompt' : tailClass,
      reason: 'agent waiting for input or approval',
      recycle: false,
    }
  }

  if (tailClass === 'verdict_hung') {
    const age = lastAgentOutputAgeMs ?? runStateAgeMs
    if (age >= cfg.verdictHangMs) {
      return {
        verdict: 'stuck',
        tailClass,
        reason: 'hung after harness verdict',
        recycle: true,
      }
    }
    return {
      verdict: 'waiting_expected',
      tailClass,
      reason: 'verdict seen; waiting for agent exit',
      recycle: false,
    }
  }

  if (tailClass === 'mcp_warmup') {
    const age = lastAgentOutputAgeMs ?? runStateAgeMs
    if (age >= cfg.mcpWarmupBudgetMs && scrollDelta <= 0) {
      return {
        verdict: 'stuck',
        tailClass,
        reason: `MCP warmup exceeded ${cfg.mcpWarmupBudgetMs}ms with no agent tokens`,
        recycle: true,
      }
    }
    return {
      verdict: 'waiting_expected',
      tailClass,
      reason: 'MCP/plugin warmup before first token',
      recycle: false,
    }
  }

  if (tailClass === 'infra_error') {
    return {
      verdict: 'stuck',
      tailClass,
      reason: 'harness infrastructure error in pane',
      recycle: true,
    }
  }

  if (scrollDelta > 0 || tailClass === 'thinking' || tailClass === 'tooling') {
    if (lastAgentOutputAgeMs != null && lastAgentOutputAgeMs >= cfg.agentOutputStuckMs && scrollDelta <= 0) {
      return {
        verdict: 'stuck',
        tailClass,
        reason: 'no agent output within stuck threshold',
        recycle: true,
      }
    }
    return {
      verdict: 'healthy',
      tailClass,
      reason: scrollDelta > 0 ? 'pane scroll advancing' : `agent ${tailClass}`,
      recycle: false,
    }
  }

  const silence = lastAgentOutputAgeMs != null ? lastAgentOutputAgeMs : runStateAgeMs
  if (silence >= cfg.agentOutputStuckMs) {
    return {
      verdict: 'stuck',
      tailClass,
      reason: 'no recent agent output or scroll progress',
      recycle: true,
    }
  }

  if (childAlive || paneStatus === 'working') {
    return {
      verdict: 'healthy',
      tailClass,
      reason: 'child alive within silence budget',
      recycle: false,
    }
  }

  return {
    verdict: 'stuck',
    tailClass,
    reason: 'no child and no recent progress',
    recycle: true,
  }
}

/** @deprecated use assessLive */
export const assessWorkerHealth = assessLive

/** Prefer visible pane source when scrollback is empty. */
export function paneReadSource(scrollMaxOffset = 0) {
  return Number(scrollMaxOffset) > 0 ? 'recent' : 'visible'
}

// --- Stuck detection helpers + infra noise ---

export function stuckThresholdMs() {
  return Number(process.env.HARNESS_STUCK_TIMEOUT_MS || 600_000)
}

export async function workerActivityAgeMs({ logFile, runState, now = Date.now() }) {
  const ages = []
  if (logFile) {
    try {
      const info = await stat(logFile)
      ages.push(now - info.mtimeMs)
    } catch {}
  }
  const heartbeatEpoch = Number(runState?.heartbeatEpoch || 0)
  if (heartbeatEpoch > 0) ages.push(now - heartbeatEpoch * 1000)
  if (runState?.lastAgentOutputAt) {
    const ts = Date.parse(runState.lastAgentOutputAt)
    if (Number.isFinite(ts)) ages.push(now - ts)
  }
  if (!ages.length) return 0
  return Math.min(...ages)
}

export async function isWorkerStuck({ logFile, runState, thresholdMs = stuckThresholdMs() }) {
  const age = await workerActivityAgeMs({ logFile, runState })
  return age >= thresholdMs
}

export function isWorkerStuckByHealth(health) {
  return health?.verdict === 'stuck' && health?.recycle === true
}

export function isInfraNoise(text = '') {
  return /(?:^|\n)(?:orchestrator:|claim\.sh:|reconcile:|harness-control:)/.test(text)
    || /\b(ENOENT|EACCES|syntax error|timed out waiting for merge lock|timed out waiting for state lock)\b/.test(text)
}

/** @deprecated use isInfraNoise */
export const isHarnessInfrastructureError = isInfraNoise
