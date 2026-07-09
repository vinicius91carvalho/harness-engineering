import { availableParallelism, freemem, loadavg, totalmem } from 'node:os'
import { readJson } from './fs-json.mjs'

export async function computeCapacity(config, quotaFile, active = 0) {
  active = Math.max(0, Math.floor(active))
  const cores = availableParallelism()
  const cpuSlots = Math.max(0, Math.floor(cores / config.cpuPerWorker))
  const freeMb = Math.floor(freemem() / 1024 / 1024)
  const memorySlots = Math.max(0, Math.floor((freeMb - config.reserveMemoryMb) / config.memoryPerWorkerMb))
  const loadRatio = loadavg()[0] / Math.max(1, cores)
  const quota = await readJson(quotaFile, {})
  const now = Math.floor(Date.now() / 1000)
  const quotaPaused = Number(quota.pauseUntil || 0) > now
  const quotaSlots = quotaPaused ? 0 : Math.max(0, Math.floor(Number(quota.maxWorkers ?? config.quotaWorkers)))
  const limit = loadRatio >= config.maxLoadRatio ? 0 : Math.max(0, Math.min(config.maxWorkers, cpuSlots, memorySlots, quotaSlots))
  return {
    limit,
    available: Math.max(0, limit - active),
    active,
    cpu: { cores, loadRatio: Number(loadRatio.toFixed(2)), maxLoadRatio: config.maxLoadRatio, slots: cpuSlots },
    memory: { freeMb, totalMb: Math.floor(totalmem() / 1024 / 1024), reserveMb: config.reserveMemoryMb, perWorkerMb: config.memoryPerWorkerMb, slots: memorySlots },
    quota: { slots: quotaSlots, configuredSlots: config.quotaWorkers, pauseUntil: quota.pauseUntil || null },
    configuredMax: config.maxWorkers,
  }
}
