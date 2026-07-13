/** Control-host beacon: fail-closed soft stop policy (ADR-0019). */

import { isLiveRunOwner, processAlive as defaultProcessAlive } from './orphan-claims.mjs'

export const DEFAULT_REQUIRED_CONSUMERS = ['herdr-notify']

/** Bounded soft-stop wait before surfacing Input Request (policy note only). */
export const SOFT_STOP_WAIT_MS = 60_000

/**
 * Pure turn-end drain plan emitted before lease release.
 */
export function turnEndDrain() {
  return { waitForFinalizers: true }
}

/**
 * Pure live check for a persisted worker row plus optional cross-check inputs.
 * Herdr rows without a live pid or Run State owner/child are not live.
 *
 * @param {object} worker
 * @param {object} [options]
 * @param {(pid: number) => boolean} [options.processAlive]
 * @param {object|null} [options.runState]
 * @param {boolean|null} [options.paneExists] - false when herdr pane is gone
 */
export function resolveWorkerLive(worker = {}, {
  processAlive = defaultProcessAlive,
  runState = null,
  paneExists = null,
} = {}) {
  // Never trust a persisted live flag alone - recompute from pid / Run State / pane.
  if (worker.status === 'done' || worker.health === 'done' || worker.terminal === true) return false
  if (worker.live === false) return false

  const isHerdr = worker.type === 'herdr' || worker.display === 'herdr'
  const pid = worker.childPid || worker.pid

  if (pid && processAlive(pid)) {
    if (isHerdr && worker.paneId && paneExists === false) return false
    return true
  }

  const runStateInput = runState ?? worker.runState ?? null
  if (runStateInput && isLiveRunOwner(runStateInput, processAlive)) {
    if (isHerdr && worker.paneId && paneExists === false) return false
    return true
  }

  return false
}

function pendingInputRows(pendingInputs = {}) {
  return Object.values(pendingInputs).filter((row) => {
    if (!row || typeof row !== 'object') return false
    if (row.status === 'pending') return true
    if (row.kind === 'input_required' && row.status !== 'responded') return true
    return false
  })
}

function consumersBehindTip(journalTip, consumerCursors = {}, requiredConsumers = DEFAULT_REQUIRED_CONSUMERS) {
  const tip = Number(journalTip) || 0
  return requiredConsumers.filter((name) => {
    const cursor = consumerCursors[name]
    const eventId = Number(cursor?.eventId ?? cursor ?? 0)
    return eventId < tip
  })
}

/**
 * @param {object} input
 * @param {Array|Record} [input.workers]
 * @param {number} [input.journalTip]
 * @param {Record<string, { eventId?: number }|number>} [input.consumerCursors]
 * @param {Record<string, object>} [input.pendingInputs]
 * @param {string[]} [input.requiredConsumers]
 * @param {(pid: number) => boolean} [input.processAlive]
 */
export function beaconSnapshot({
  workers = [],
  journalTip = 0,
  consumerCursors = {},
  pendingInputs = {},
  requiredConsumers = DEFAULT_REQUIRED_CONSUMERS,
  processAlive = defaultProcessAlive,
} = {}) {
  const workerList = Array.isArray(workers)
    ? workers
    : Object.entries(workers).map(([context, worker]) => ({ context, ...worker }))
  const liveWorkers = workerList.filter((worker) => resolveWorkerLive(worker, {
    processAlive,
    runState: worker.runState ?? null,
    paneExists: worker.paneExists ?? null,
  }))
  const unackedInputs = pendingInputRows(pendingInputs)
  const behindConsumers = consumersBehindTip(journalTip, consumerCursors, requiredConsumers)

  return {
    journalTip: Number(journalTip) || 0,
    liveWorkerCount: liveWorkers.length,
    liveWorkers,
    consumerCursors,
    behindConsumers,
    unackedInputs,
    pendingInputCount: unackedInputs.length,
  }
}

/**
 * @param {'soft'|'force'|'operator_stop'} intent
 * @param {ReturnType<typeof beaconSnapshot>} snapshot
 * @param {{ authorized?: boolean }} [options]
 */
export function stopAllowed(intent, snapshot, { authorized = false } = {}) {
  if (intent === 'force') {
    if (!authorized) {
      return { allowed: false, reason: 'force stop requires authorized:true (ADR-0016)' }
    }
    return { allowed: true, reason: null }
  }

  if ((snapshot?.liveWorkerCount || 0) > 0) {
    return { allowed: false, reason: 'live workers still running' }
  }
  if ((snapshot?.behindConsumers || []).length > 0) {
    return {
      allowed: false,
      reason: `required consumers behind journal tip: ${snapshot.behindConsumers.join(', ')}`,
    }
  }
  if ((snapshot?.pendingInputCount || 0) > 0) {
    return { allowed: false, reason: 'unacked input_required pending' }
  }

  return { allowed: true, reason: null }
}
