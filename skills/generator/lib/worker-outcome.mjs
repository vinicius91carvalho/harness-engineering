import { parseObject } from './verdict.mjs'

/**
 * Infer a durable worker outcome when the orchestrator did not write worker-result.json.
 * Used by the supervisor after a worker process exits.
 */
export function interpretWorkerOutcome({ key, tail, persisted, runState, featureIds, queue }) {
  let result = persisted ? { ...persisted, durable: true } : null
  if (!result) result = parseObject(tail)
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
  return result
}
