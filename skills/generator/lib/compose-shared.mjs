/**
 * Host-wide shared Compose infra lease.
 *
 * Heavy stateful services (postgres/redis/hindsight/…) should be reused across
 * concurrent harness workers on the same machine instead of each WI bringing
 * up (and tearing down) a full stack — that pattern exhausts RAM on 14–16 GiB hosts.
 *
 * Registry: <git-common-dir>/harness-locks/compose-shared.json
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { hostname } from 'node:os'

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

function readRegistry(commonGit) {
  const file = composeSharedPath(commonGit)
  if (!existsSync(file)) return emptyRegistry()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return emptyRegistry()
    return {
      version: 1,
      projects: parsed.projects && typeof parsed.projects === 'object' ? parsed.projects : {},
      updatedAt: parsed.updatedAt || null,
    }
  } catch {
    return emptyRegistry()
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

function projectKey(projectId) {
  return String(projectId || 'root')
}

/**
 * Record that `context` is using the shared compose stack for `projectId`.
 * @returns {{ holders: string[], count: number }}
 */
export function acquireComposeShare(commonGit, projectId, context, { host = hostname() } = {}) {
  if (!commonGit || !context) return { holders: [], count: 0 }
  const key = projectKey(projectId)
  const registry = readRegistry(commonGit)
  const entry = registry.projects[key] || { holders: {}, host }
  entry.host = host
  entry.holders = entry.holders && typeof entry.holders === 'object' ? entry.holders : {}
  entry.holders[context] = { at: new Date().toISOString(), host }
  registry.projects[key] = entry
  writeRegistry(commonGit, registry)
  const holders = Object.keys(entry.holders)
  return { holders, count: holders.length }
}

/**
 * Drop `context` from the shared compose lease.
 * @returns {{ holders: string[], count: number, lastHolder: boolean }}
 */
export function releaseComposeShare(commonGit, projectId, context) {
  if (!commonGit || !context) return { holders: [], count: 0, lastHolder: true }
  const key = projectKey(projectId)
  const registry = readRegistry(commonGit)
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
}

export function composeShareHolders(commonGit, projectId) {
  const entry = readRegistry(commonGit).projects[projectKey(projectId)]
  return Object.keys(entry?.holders || {})
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
  const effective = Math.max(shareCount, others.length + (context && siblingHolders.includes(context) ? 1 : 0))
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
  // effective unused except for clarity in tests
  void effective
  return { mode: 'full_down', reason: 'last_holder', keepInfra: false }
}
