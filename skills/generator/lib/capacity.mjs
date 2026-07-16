import { readJson } from './fs-json.mjs'
import { readHostResources } from './host-resources.mjs'

export async function computeCapacity(config, quotaFile, active = 0) {
  active = Math.max(0, Number(active) || 0)
  const host = readHostResources()
  const cores = host.cpu.cores
  const cpuSlots = Math.max(0, Math.floor(cores / config.cpuPerWorker))
  const availableMb = host.memory.availableMb
  const memorySlots = Math.max(0, Math.floor((availableMb - config.reserveMemoryMb) / config.memoryPerWorkerMb))
  const loadRatio = host.cpu.loadRatio
  const quota = await readJson(quotaFile, {})
  const now = Math.floor(Date.now() / 1000)
  const quotaPaused = Number(quota.pauseUntil || 0) > now
  const quotaSlots = quotaPaused ? 0 : Math.max(0, Math.floor(Number(quota.maxWorkers ?? config.quotaWorkers)))
  const swapLimit = host.swap.usedMb > 256 && host.swap.usedRatio >= config.maxSwapUsedRatio ? 0 : Number.POSITIVE_INFINITY
  const pressureReason = loadRatio >= config.maxLoadRatio
    ? 'load'
    : swapLimit === 0
      ? 'swap'
      : memorySlots < 1
        ? 'memory'
        : quotaSlots < 1
          ? 'quota'
          : null
  const limit = loadRatio >= config.maxLoadRatio
    ? 0
    : Math.max(0, Math.min(config.maxWorkers, cpuSlots, memorySlots, quotaSlots, swapLimit))
  return {
    limit,
    available: Math.max(0, limit - active),
    active,
    activeCost: active,
    pressureReason,
    hostResources: host,
    cpu: { cores, loadRatio: Number(loadRatio.toFixed(2)), maxLoadRatio: config.maxLoadRatio, slots: cpuSlots },
    memory: { freeMb: availableMb, availableMb, totalMb: host.memory.totalMb, reserveMb: config.reserveMemoryMb, perWorkerMb: config.memoryPerWorkerMb, slots: memorySlots },
    swap: { ...host.swap, maxUsedRatio: config.maxSwapUsedRatio },
    quota: { slots: quotaSlots, configuredSlots: config.quotaWorkers, pauseUntil: quota.pauseUntil || null },
    configuredMax: config.maxWorkers,
  }
}
