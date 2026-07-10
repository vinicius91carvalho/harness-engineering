import { stat } from 'node:fs/promises'
import { assessWorkerHealth } from './worker-health.mjs'

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
  // Prefer last real agent output over orchestrator heartbeat when present.
  if (runState?.lastAgentOutputAt) {
    const ts = Date.parse(runState.lastAgentOutputAt)
    if (Number.isFinite(ts)) ages.push(now - ts)
  }
  if (!ages.length) return 0
  return Math.min(...ages)
}

/**
 * Heartbeat/log age fallback. Prefer assessWorkerHealthViaSignals when pane
 * signals are available (herdr workers).
 */
export async function isWorkerStuck({ logFile, runState, thresholdMs = stuckThresholdMs() }) {
  const age = await workerActivityAgeMs({ logFile, runState })
  return age >= thresholdMs
}

/** Health-plane stuck check used by the supervisor for herdr workers. */
export function isWorkerStuckByHealth(health) {
  return health?.verdict === 'stuck' && health?.recycle === true
}

export { assessWorkerHealth }

export function isHarnessInfrastructureError(text = '') {
  return /(?:^|\n)(?:orchestrator:|claim\.sh:|reconcile:|harness-control:)/.test(text)
    || /\b(ENOENT|EACCES|syntax error|timed out waiting for merge lock|timed out waiting for state lock)\b/.test(text)
}
