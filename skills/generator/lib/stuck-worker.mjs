import { stat } from 'node:fs/promises'

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
  if (!ages.length) return 0
  return Math.min(...ages)
}

export async function isWorkerStuck({ logFile, runState, thresholdMs = stuckThresholdMs() }) {
  const age = await workerActivityAgeMs({ logFile, runState })
  return age >= thresholdMs
}

export function isHarnessInfrastructureError(text = '') {
  return /(?:^|\n)(?:orchestrator:|claim\.sh:|reconcile:|harness-control:)/.test(text)
    || /\b(ENOENT|EACCES|syntax error|timed out waiting for merge lock|timed out waiting for state lock)\b/.test(text)
}
