import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { computeCapacity } from './capacity.mjs'

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

function processAlive(pid) {
  if (!Number(pid)) return false
  try { process.kill(Number(pid), 0); return true } catch { return false }
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
  const providerKey = options.provider || 'default'
  const providerCooldownUntil = state.providers?.[providerKey]?.cooldownUntil
  const quotaWorkers = providerCooldownUntil && Date.parse(providerCooldownUntil) > Date.now()
    ? 0
    : options.quotaWorkers
  const capacity = await computeCapacity({
    ...options,
    quotaWorkers: quotaWorkers ?? options.quotaWorkers,
  }, options.quotaFile, activeWorkers)
  return { ...capacity, activeWorkers, file, state, slots: capacity.available }
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
    const reservation = {
      id,
      projectId,
      context,
      provider,
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
  }
}
