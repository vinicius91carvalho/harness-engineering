/**
 * Pure Worker Health plane: classify pane tails and decide healthy | waiting_expected | stuck | done.
 * Supervisor ticks use this instead of heartbeat-only stuck detection.
 */

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

const DEFAULTS = {
  /** Max silence after agent output before stuck (ms). */
  agentOutputStuckMs: Number(process.env.HARNESS_AGENT_OUTPUT_STUCK_MS || 600_000),
  /** MCP warmup budget before stuck (ms). */
  mcpWarmupBudgetMs: Number(process.env.HARNESS_MCP_WARMUP_BUDGET_MS || 90_000),
  /** Post-verdict hang budget (ms). */
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

  // Classify from content after the last verdict marker so earlier tool/thinking
  // lines in the same 12-line window do not mask a post-verdict hang.
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
 * @param {object} input
 * @param {number} [input.runStateAgeMs] age of run-state heartbeat
 * @param {boolean} [input.childAlive]
 * @param {string} [input.paneStatus] herdr agent_status
 * @param {number} [input.scrollDelta] change in scroll.max_offset_from_bottom since last sample
 * @param {string} [input.tailText]
 * @param {number|null} [input.lastAgentOutputAgeMs] age since last thinking/tool output (null = unknown)
 * @param {string} [input.runStatus] complete|blocked|failed|running|…
 * @param {boolean} [input.mergeHolderAlive] when tail is merge_lock
 * @param {object} [input.thresholds]
 */
export function assessWorkerHealth(input = {}) {
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
  } = input
  const cfg = { ...DEFAULTS, ...thresholds }
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

  // Heartbeat-only / unknown: stuck if agent output (or heartbeat) is stale
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

/** Prefer visible pane source when scrollback is empty. */
export function paneReadSource(scrollMaxOffset = 0) {
  return Number(scrollMaxOffset) > 0 ? 'recent' : 'visible'
}
