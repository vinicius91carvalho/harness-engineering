/**
 * Shared Runtime Lease (ADR-0021): host-wide shared Compose infra lease.
 *
 * Heavy stateful services (postgres/redis/hindsight/…) should be reused across
 * concurrent harness workers on the same machine instead of each WI bringing
 * up (and tearing down) a full stack - that pattern exhausts RAM on 14-16 GiB hosts.
 *
 * Module interface:
 *   acquireComposeShare / releaseComposeShare  - holder registry
 *   composeShareSnapshot                       - Fleet Snapshot read model
 *   planSharedRuntimeTeardown                  - release + teardown planning
 *   planComposeTeardown                        - pure mode decision from counts
 *
 * Registry: <git-common-dir>/harness-locks/compose-shared.json
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { processAlive } from '../../supervisor/lib/runtime-view.mjs'

/** Service name tokens treated as shared infra (matched as substrings). */
export const SHARED_INFRA_SERVICE_HINTS = [
  'postgres',
  'postgresql',
  'redis',
  'hindsight',
  'mongo',
  'mongodb',
  'rabbitmq',
  'nats',
  'minio',
  'localstack',
  'opensearch',
  'elasticsearch',
  'clickhouse',
]

/** App / under-test services — safe to stop/rm per worker without dropping infra. */
export const APP_SERVICE_HINTS = [
  'causeflow-api',
  'causeflow-worker',
  'causeflow-test-app',
  'causeflow-website',
  'causeflow-dashboard',
  'causeflow-docs',
  'api',
  'worker',
  'website',
  'dashboard',
  'relay',
  'test-app',
  'app',
]

function emptyRegistry() {
  return { version: 1, projects: {}, updatedAt: null }
}

export function composeSharedPath(commonGit) {
  return join(commonGit, 'harness-locks', 'compose-shared.json')
}

function composeSharedLockDir(commonGit) {
  return join(commonGit, 'harness-locks', 'compose-shared.lock')
}

function withRegistryLock(commonGit, fn) {
  if (!commonGit) return fn()
  const lockDir = composeSharedLockDir(commonGit)
  mkdirSync(dirname(lockDir), { recursive: true })
  const token = `${process.pid}.${randomUUID()}`
  const started = Date.now()
  for (;;) {
    try {
      mkdirSync(lockDir)
      writeFileSync(join(lockDir, 'owner'), token)
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let pid = 0
      try { pid = Number(String(readFileSync(join(lockDir, 'owner'), 'utf8')).split('.')[0]) } catch {}
      if (!pid || !processAlive(pid)) {
        try { rmSync(lockDir, { recursive: true, force: true }); continue } catch {}
      }
      if (Date.now() - started > 5000) throw new Error('compose shared registry lock timeout')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
  try {
    return fn()
  } finally {
    try { rmSync(lockDir, { recursive: true, force: true }) } catch {}
  }
}

function readRegistry(commonGit) {
  const file = composeSharedPath(commonGit)
  if (!existsSync(file)) return emptyRegistry()
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    // Fail closed: a corrupt registry must not be rewritten as empty (that
    // drops live holders and allows premature full compose down).
    throw new Error(`compose shared registry unreadable: ${file}: ${error.message || error}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`compose shared registry invalid: ${file}`)
  }
  return {
    version: 1,
    projects: parsed.projects && typeof parsed.projects === 'object' && !Array.isArray(parsed.projects)
      ? parsed.projects
      : {},
    updatedAt: parsed.updatedAt || null,
  }
}

function writeRegistry(commonGit, registry) {
  const file = composeSharedPath(commonGit)
  mkdirSync(dirname(file), { recursive: true })
  const next = {
    version: 1,
    projects: registry.projects || {},
    updatedAt: new Date().toISOString(),
  }
  const tmp = `${file}.tmp.${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`)
  renameSync(tmp, file)
  return next
}

function pruneDeadHolders(registry) {
  let pruned = 0
  for (const [project, entry] of Object.entries(registry.projects || {})) {
    const holders = entry?.holders && typeof entry.holders === 'object' ? entry.holders : {}
    for (const [context, holder] of Object.entries(holders)) {
      if (holder?.pid && !processAlive(holder.pid)) {
        delete holders[context]
        pruned += 1
      }
    }
    if (Object.keys(holders).length === 0) delete registry.projects[project]
    else entry.holders = holders
  }
  return { registry, pruned }
}

function projectKey(projectId) {
  return String(projectId || 'root')
}

/**
 * Record that `context` is using the shared compose stack for `projectId`.
 * @returns {{ holders: string[], count: number }}
 */
export function acquireComposeShare(commonGit, projectId, context, {
  host = hostname(),
  pid = process.pid,
  worktree = null,
  services = [],
  ports = [],
  fingerprint = null,
  ttlMs = 60 * 60 * 1000,
} = {}) {
  if (!commonGit || !context) return { holders: [], count: 0 }
  return withRegistryLock(commonGit, () => {
    const key = projectKey(projectId)
    const { registry } = pruneDeadHolders(readRegistry(commonGit))
    const entry = registry.projects[key] || { holders: {}, host, fingerprint }
    entry.host = host
    entry.fingerprint = fingerprint || entry.fingerprint || null
    entry.holders = entry.holders && typeof entry.holders === 'object' ? entry.holders : {}
    entry.holders[context] = {
      at: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      host,
      pid,
      worktree,
      services,
      ports,
    }
    registry.projects[key] = entry
    writeRegistry(commonGit, registry)
    const holders = Object.keys(entry.holders)
    return { holders, count: holders.length, entry }
  })
}

/**
 * Drop `context` from the shared compose lease.
 * @returns {{ holders: string[], count: number, lastHolder: boolean }}
 */
export function releaseComposeShare(commonGit, projectId, context) {
  if (!commonGit || !context) return { holders: [], count: 0, lastHolder: true }
  return withRegistryLock(commonGit, () => {
    const key = projectKey(projectId)
    const { registry } = pruneDeadHolders(readRegistry(commonGit))
    const entry = registry.projects[key]
    if (!entry?.holders) {
      return { holders: [], count: 0, lastHolder: true }
    }
    delete entry.holders[context]
    if (Object.keys(entry.holders).length === 0) {
      delete registry.projects[key]
    } else {
      registry.projects[key] = entry
    }
    writeRegistry(commonGit, registry)
    const holders = Object.keys(entry.holders || {})
    return { holders, count: holders.length, lastHolder: holders.length === 0 }
  })
}

export function composeShareHolders(commonGit, projectId) {
  const entry = pruneDeadHolders(readRegistry(commonGit)).registry.projects[projectKey(projectId)]
  return Object.keys(entry?.holders || {})
}

export function composeShareSnapshot(commonGit) {
  if (!commonGit) return { projects: {}, pruned: 0 }
  const { registry, pruned } = pruneDeadHolders(readRegistry(commonGit))
  return { projects: registry.projects || {}, pruned }
}

export function composeShareCount(commonGit, projectId) {
  return composeShareHolders(commonGit, projectId).length
}

export function isSharedInfraService(name) {
  const n = String(name || '').toLowerCase()
  return SHARED_INFRA_SERVICE_HINTS.some((hint) => n.includes(hint))
}

export function isAppService(name) {
  const n = String(name || '').toLowerCase()
  if (isSharedInfraService(n)) return false
  return APP_SERVICE_HINTS.some((hint) => n === hint || n.includes(hint))
}

/**
 * Decide whether teardown should fully `compose down` or only stop app services.
 * @param {{ shareCount?: number, force?: boolean, siblingHolders?: string[], context?: string }} opts
 */
export function planComposeTeardown({
  shareCount = 0,
  force = false,
  siblingHolders = [],
  context = null,
} = {}) {
  if (force) {
    return { mode: 'full_down', reason: 'force', keepInfra: false }
  }
  const others = siblingHolders.filter((h) => h && h !== context)
  // After release, shareCount is remaining holders. If any remain, keep infra.
  if (shareCount > 0 || others.length > 0) {
    return {
      mode: 'app_services_only',
      reason: shareCount > 0
        ? `shared infra held by ${shareCount} other context(s)`
        : `sibling holders: ${others.join(',')}`,
      keepInfra: true,
    }
  }
  return { mode: 'full_down', reason: 'last_holder', keepInfra: false }
}

/**
 * Acquire/release/snapshot planning for Shared Runtime Lease teardown.
 * Callers that tear down a worktree should use this instead of re-deriving
 * share-count heuristics. Docker compose execution stays in worktree-teardown.
 *
 * @returns {{
 *   mode: 'full_down'|'app_services_only'|'refused',
 *   reason: string,
 *   keepInfra: boolean,
 *   remaining: number|null,
 *   released: { holders: string[], count: number, lastHolder: boolean }|null,
 *   skippedFullDown?: boolean,
 *   error?: string|null,
 * }}
 */
export function planSharedRuntimeTeardown({
  commonGit = null,
  projectId = null,
  context = null,
  shareCount = null,
  force = false,
  release = true,
  siblingHolders = [],
} = {}) {
  let remaining = shareCount
  let released = null

  if (remaining == null && commonGit && context) {
    if (release) {
      released = releaseComposeShare(commonGit, projectId, context)
      remaining = released.count
    } else {
      remaining = composeShareCount(commonGit, projectId)
    }
  } else if (remaining == null && commonGit) {
    remaining = composeShareCount(commonGit, projectId)
  } else if (remaining == null) {
    // Fail closed: unknown share state must not drop shared infra.
    if (!force) {
      return {
        mode: 'refused',
        reason: 'unknown_share_state',
        keepInfra: true,
        remaining: null,
        released: null,
        skippedFullDown: true,
        error: 'planSharedRuntimeTeardown requires commonGit+context, shareCount, or force',
      }
    }
    remaining = 0
  }

  const plan = planComposeTeardown({
    shareCount: remaining,
    force,
    siblingHolders,
    context,
  })
  return {
    ...plan,
    remaining,
    released,
    skippedFullDown: plan.mode === 'app_services_only',
    error: null,
  }
}
