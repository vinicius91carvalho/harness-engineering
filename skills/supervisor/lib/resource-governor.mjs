import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { readJson } from '../../generator/lib/fs-json.mjs'
import { readHostResources } from './host-resources.mjs'
import { processAlive } from './orphan-claims.mjs'

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

/**
 * Host-wide, provider-aware Resource Governor (ADR-0012).
 * Reservations live under the shared Git common dir so sibling projects and
 * direct generator paths share one capacity ledger.
 */

export function governorPath(commonGit) {
  return join(commonGit, 'harness-governor', 'reservations.json')
}

function governorLockPath(commonGit) {
  return join(commonGit, 'harness-governor', 'governor.lock')
}

function emptyState() {
  return { version: 1, reservations: {}, providers: {}, updatedAt: null }
}

export function resourceCost(resourceClass = 'coding', explicit = null) {
  const direct = Number(explicit)
  if (Number.isFinite(direct) && direct > 0) return direct
  const cls = String(resourceClass || 'coding')
  if (cls === 'static') return 0.5
  if (cls === 'browser' || cls === 'goal-review') return 2
  if (cls === 'compose-build') return 3
  return 1
}

async function stealDeadGovernorLock(lockPath) {
  let pid = 0
  try {
    const token = String(await readFile(lockPath, 'utf8') || '').trim()
    pid = Number(token.split('.')[0])
  } catch (error) {
    if (error?.code === 'ENOENT') return false
  }
  if (Number.isFinite(pid) && pid > 0 && processAlive(pid)) return false
  const stale = `${lockPath}.stale.${randomUUID()}`
  try {
    await rename(lockPath, stale)
    await unlink(stale)
    return true
  } catch {
    return false
  }
}

async function withGovernorLock(commonGit, fn) {
  const lockPath = governorLockPath(commonGit)
  await mkdir(dirname(lockPath), { recursive: true })
  const token = `${process.pid}.${randomUUID()}`
  const started = Date.now()
  while (true) {
    try {
      const { open } = await import('node:fs/promises')
      const handle = await open(lockPath, 'wx')
      await handle.writeFile(token)
      await handle.close()
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (await stealDeadGovernorLock(lockPath)) continue
      if (Date.now() - started > 10_000) throw new Error('resource governor lock timeout')
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  try {
    return await fn()
  } finally {
    try { await unlink(lockPath) } catch {}
  }
}

async function readState(file) {
  if (!existsSync(file)) return emptyState()
  try {
    const value = JSON.parse(await readFile(file, 'utf8'))
    if (value?.version !== 1) throw new Error('unsupported governor version')
    return value
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState()
    throw new Error(`malformed Resource Governor state: ${error.message}`)
  }
}

async function writeState(file, state) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.tmp.${process.pid}.${randomUUID()}`
  const next = { ...state, updatedAt: new Date().toISOString() }
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`)
  await rename(temporary, file)
  return next
}

function pruneExpired(state) {
  const now = Date.now()
  for (const [key, row] of Object.entries(state.reservations || {})) {
    if (row.expiresAt && Date.parse(row.expiresAt) <= now) delete state.reservations[key]
    // Drop ghost slots left by crashed orchestrators / workers.
    else if (row.pid && !processAlive(row.pid)) delete state.reservations[key]
  }
  return state
}

export async function observeCapacity(commonGit, options = {}) {
  const file = governorPath(commonGit)
  const state = pruneExpired(await readState(file))
  const activeWorkers = Object.values(state.reservations || {}).length
  const activeCost = Object.values(state.reservations || {})
    .reduce((sum, row) => sum + resourceCost(row.resourceClass, row.cost), 0)
  const providerKey = options.provider || 'default'
  const providerCooldownUntil = state.providers?.[providerKey]?.cooldownUntil
  const quotaWorkers = providerCooldownUntil && Date.parse(providerCooldownUntil) > Date.now()
    ? 0
    : options.quotaWorkers
  const capacity = await computeCapacity({
    ...options,
    quotaWorkers: quotaWorkers ?? options.quotaWorkers,
  }, options.quotaFile, activeCost)
  return { ...capacity, activeWorkers, activeCost, file, state, slots: capacity.available }
}

/** Persist-prune dead/expired governor reservations (supervisor preflight). */
export async function pruneDeadReservations(commonGit) {
  return withGovernorLock(commonGit, async () => {
    const file = governorPath(commonGit)
    const before = await readState(file)
    const beforeIds = Object.keys(before.reservations || {})
    const state = pruneExpired({ ...before, reservations: { ...(before.reservations || {}) } })
    const afterIds = Object.keys(state.reservations || {})
    const removed = beforeIds.filter((id) => !afterIds.includes(id))
    await writeState(file, state)
    return { removed, remaining: afterIds.length }
  })
}

export async function requestAdmission(commonGit, {
  projectId,
  context,
  provider = 'default',
  resourceClass = 'coding',
  cost = null,
  ttlMs = 30 * 60 * 1000,
  quotaFile,
  ...capacityOptions
} = {}) {
  return withGovernorLock(commonGit, async () => {
    const file = governorPath(commonGit)
    const state = pruneExpired(await readState(file))
    // Persist prunes so dead-pid ghosts do not keep blocking siblings.
    await writeState(file, state)
    // Reuse an existing live reservation for the same project/context (supervisor
    // already admitted; orchestrator must not double-book a second slot).
    const existing = Object.values(state.reservations || {}).find((row) => (
      row.projectId === (projectId || 'root')
      && row.context === context
      && (!row.pid || processAlive(row.pid))
    ))
    if (existing) {
      const after = await observeCapacity(commonGit, { ...capacityOptions, provider, quotaFile })
      return { granted: true, reservation: existing, capacity: after, reused: true }
    }
    const observed = await observeCapacity(commonGit, { ...capacityOptions, provider, quotaFile })
    if (observed.slots < 1) {
      return { granted: false, reason: 'no-capacity', capacity: observed }
    }
    const id = randomUUID()
    const reservationCost = resourceCost(resourceClass, cost)
    const reservation = {
      id,
      projectId,
      context,
      provider,
      resourceClass,
      cost: reservationCost,
      host: hostname(),
      pid: process.pid,
      at: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    }
    state.reservations = state.reservations || {}
    state.reservations[id] = reservation
    await writeState(file, state)
    const after = await observeCapacity(commonGit, { ...capacityOptions, provider, quotaFile })
    return { granted: true, reservation, capacity: after }
  })
}

export async function releaseAdmission(commonGit, reservationId) {
  if (!reservationId) return
  return withGovernorLock(commonGit, async () => {
    const file = governorPath(commonGit)
    const state = await readState(file)
    if (state.reservations?.[reservationId]) {
      delete state.reservations[reservationId]
      await writeState(file, state)
    }
  })
}

export async function setProviderCooldown(commonGit, provider, untilIso) {
  return withGovernorLock(commonGit, async () => {
    const file = governorPath(commonGit)
    const state = await readState(file)
    state.providers = state.providers || {}
    state.providers[provider || 'default'] = { cooldownUntil: untilIso }
    await writeState(file, state)
  })
}

/**
 * Default capacity options aligned with harness-control baseConfig defaults.
 */
export function defaultGovernorOptions(env = process.env) {
  const num = (name, fallback) => {
    const value = Number(env[`HARNESS_${name.replaceAll('-', '_').toUpperCase()}`] ?? fallback)
    return Number.isFinite(value) ? value : fallback
  }
  return {
    maxWorkers: Math.max(1, Math.floor(num('max-workers', 4))),
    quotaWorkers: Math.max(0, Math.floor(num('quota-workers', 2))),
    cpuPerWorker: Math.max(0.25, num('cpu-per-worker', 2)),
    memoryPerWorkerMb: Math.max(1, num('memory-per-worker-mb', 1024)),
    reserveMemoryMb: Math.max(0, num('reserve-memory-mb', 1024)),
    maxLoadRatio: Math.max(0.1, num('max-load-ratio', 0.85)),
    maxSwapUsedRatio: Math.max(0.01, num('max-swap-used-ratio', 0.2)),
  }
}
