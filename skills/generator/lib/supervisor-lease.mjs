import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readJson, atomicJson } from './fs-json.mjs'
import { processAlive as sharedProcessAlive } from './orphan-claims.mjs'

/**
 * Fenced singleton Supervisor Lease (ADR-0015).
 * Only the holder matching token + fenceGeneration may mutate the control journal
 * and governor admissions for a control root.
 */

export function supervisorLeasePaths(controlRoot) {
  const lockDir = join(controlRoot, 'supervisor.lock')
  return { lockDir, ownerFile: join(lockDir, 'owner.json') }
}

export const processAlive = sharedProcessAlive

export function supervisorOwnerLive(owner, leaseSeconds = 30) {
  if (!owner?.token) return false
  const age = Math.floor(Date.now() / 1000) - Number(owner.heartbeatEpoch || 0)
  if (age >= leaseSeconds) return false
  if (owner.host === hostname()) {
    return processAlive(owner.pid) || owner.status === 'starting'
  }
  return Boolean(owner.pid || owner.status === 'starting')
}

function isOwnerLive(owner, leaseSeconds) {
  return supervisorOwnerLive(owner, leaseSeconds)
}

export async function readSupervisorOwner(controlRoot) {
  const { ownerFile } = supervisorLeasePaths(controlRoot)
  if (!existsSync(ownerFile)) return null
  return readJson(ownerFile, {})
}

export async function acquireSupervisorLease(controlRoot, {
  token,
  pid = process.pid,
  status = 'running',
  leaseSeconds = 30,
}) {
  const { lockDir, ownerFile } = supervisorLeasePaths(controlRoot)
  await mkdir(controlRoot, { recursive: true })
  for (;;) {
    try {
      await mkdir(lockDir)
      await atomicJson(ownerFile, {
        token,
        pid,
        host: hostname(),
        status,
        heartbeatEpoch: Math.floor(Date.now() / 1000),
        fenceGeneration: 1,
      })
      return { token, fenceGeneration: 1 }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    const owner = await readSupervisorOwner(controlRoot)
    if (!owner?.token) {
      const stale = `${lockDir}.stale.${randomUUID()}`
      try { await rename(lockDir, stale) } catch { continue }
      await rm(stale, { recursive: true, force: true })
      continue
    }
    if (owner.token === token) {
      const fenceGeneration = Number(owner.fenceGeneration || 1)
      await atomicJson(ownerFile, {
        ...owner,
        pid,
        host: hostname(),
        status,
        heartbeatEpoch: Math.floor(Date.now() / 1000),
        fenceGeneration,
      })
      return { token, fenceGeneration }
    }
    if (isOwnerLive(owner, leaseSeconds)) {
      const err = new Error(`supervisor lease is owned by ${owner.host || 'unknown'} pid ${owner.pid || 'unknown'}`)
      err.code = 'SUPERVISOR_LEASE_HELD'
      throw err
    }
    const nextGen = Number(owner.fenceGeneration || 0) + 1
    const stale = `${lockDir}.stale.${randomUUID()}`
    try { await rename(lockDir, stale) } catch { continue }
    await rm(stale, { recursive: true, force: true })
    try {
      await mkdir(lockDir)
      await atomicJson(ownerFile, {
        token,
        pid,
        host: hostname(),
        status,
        heartbeatEpoch: Math.floor(Date.now() / 1000),
        fenceGeneration: nextGen,
      })
      return { token, fenceGeneration: nextGen }
    } catch (retryError) {
      if (retryError.code !== 'EEXIST') throw retryError
    }
  }
}

export async function updateSupervisorLease(controlRoot, {
  token,
  fenceGeneration,
  pid = process.pid,
  status = 'running',
  leaseSeconds = 30,
}) {
  const owner = await readSupervisorOwner(controlRoot)
  if (!owner?.token) {
    if (status === 'stopping') return null
    return acquireSupervisorLease(controlRoot, { token, pid, status, leaseSeconds })
  }
  if (owner.token !== token) {
    if (status === 'stopping') return null
    const err = new Error('supervisor lease token mismatch; refusing stale writer')
    err.code = 'SUPERVISOR_LEASE_STALE'
    throw err
  }
  if (Number(owner.fenceGeneration || 0) !== Number(fenceGeneration || 0)) {
    const err = new Error(`supervisor lease fenced at generation ${owner.fenceGeneration}; refusing stale writer`)
    err.code = 'SUPERVISOR_LEASE_STALE'
    throw err
  }
  const { ownerFile } = supervisorLeasePaths(controlRoot)
  await atomicJson(ownerFile, {
    ...owner,
    pid,
    host: hostname(),
    status,
    heartbeatEpoch: Math.floor(Date.now() / 1000),
    fenceGeneration: Number(fenceGeneration || owner.fenceGeneration || 1),
  })
  return { token, fenceGeneration: Number(fenceGeneration || owner.fenceGeneration || 1) }
}

export async function assertSupervisorLease(controlRoot, { token, fenceGeneration }) {
  const owner = await readSupervisorOwner(controlRoot)
  if (!owner?.token || owner.token !== token) {
    const err = new Error('supervisor lease token mismatch; refusing write')
    err.code = 'SUPERVISOR_LEASE_STALE'
    throw err
  }
  if (Number(owner.fenceGeneration || 0) !== Number(fenceGeneration || 0)) {
    const err = new Error(`supervisor lease fenced at generation ${owner.fenceGeneration}; refusing stale writer`)
    err.code = 'SUPERVISOR_LEASE_STALE'
    throw err
  }
  return owner
}

export async function releaseSupervisorLease(controlRoot, token) {
  const owner = await readSupervisorOwner(controlRoot)
  if (!owner?.token || owner.token !== token) return
  const { lockDir } = supervisorLeasePaths(controlRoot)
  const released = `${lockDir}.released.${randomUUID()}`
  try { await rename(lockDir, released) } catch { return }
  await rm(released, { recursive: true, force: true })
}

/**
 * Authorize fleet recovery commands (kill supervisor, release locks, kill workers).
 * Refuses when a remote supervisor lease is live unless the caller holds the token.
 */
export async function authorizeFleetRecovery(controlRoot, {
  state = {},
  token = '',
  force = false,
  leaseSeconds = 30,
}) {
  const owner = await readSupervisorOwner(controlRoot)
  if (token && owner?.token === token) {
    return { authorized: true, mode: 'token', owner }
  }
  const localAlive = state.supervisorHost === hostname() && processAlive(state.supervisorPid)
  if (localAlive && !force) {
    const err = new Error('local supervisor is running; pass --force or HARNESS_SUPERVISOR_TOKEN')
    err.code = 'FLEET_SUPERVISOR_LIVE'
    throw err
  }
  if (owner?.token && supervisorOwnerLive(owner, leaseSeconds) && owner.host !== hostname()) {
    const err = new Error(`supervisor lease held by ${owner.host} pid ${owner.pid || 'unknown'}`)
    err.code = 'FLEET_REMOTE_LEASE'
    throw err
  }
  return { authorized: true, mode: localAlive ? 'force' : 'recovery', owner }
}

export async function clearStaleSupervisorLock(controlRoot, { leaseSeconds = 30 } = {}) {
  const owner = await readSupervisorOwner(controlRoot)
  if (owner?.token && supervisorOwnerLive(owner, leaseSeconds)) {
    const err = new Error('supervisor lease is still live')
    err.code = 'SUPERVISOR_LEASE_HELD'
    throw err
  }
  const { lockDir } = supervisorLeasePaths(controlRoot)
  if (!existsSync(lockDir)) return { cleared: false, reason: 'absent' }
  await rm(lockDir, { recursive: true, force: true })
  return { cleared: true, reason: 'stale' }
}
