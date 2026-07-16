import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { killMatchingPatterns, terminateProcessTree } from './worker-lifecycle.mjs'
import {
  isAppService,
  planSharedRuntimeTeardown,
} from './compose-shared.mjs'

export function runtimeManifestPath(workdir) {
  return workdir ? join(workdir, '.harness', 'runtime-owned.jsonl') : null
}

export function appendOwnedRuntime(workdir, row = {}) {
  const file = runtimeManifestPath(workdir)
  if (!file) return false
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`)
  return true
}

export function readOwnedRuntime(workdir) {
  const file = runtimeManifestPath(workdir)
  if (!file || !existsSync(file)) return []
  const rows = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object') rows.push(parsed)
    } catch {}
  }
  return rows
}

const COMPOSE_FILES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yml',
  'docker-compose.yaml',
]

/** Pure patterns for worktree-scoped runtime processes (never bare `node`). */
export function runtimeKillPatterns({ workdir, port } = {}) {
  if (!workdir && !port) return []
  const patterns = []
  if (workdir) {
    patterns.push(
      `${workdir}.*node_modules/.bin/next`,
      `${workdir}.*\\.bin/next`,
      `${workdir}.*tsx`,
      `tsx.*${workdir}`,
      `${workdir}.*esbuild`,
      `${workdir}.*src/main\\.ts`,
      `${workdir}.*--env-file=\\.env`,
    )
  }
  if (port) {
    patterns.push(
      `next.*-p[ =]${port}\\b`,
      `next.*--port[ =]${port}\\b`,
      `node.*-p[ =]${port}\\b`,
    )
  }
  return patterns.filter(Boolean)
}

export function composeProjectDir(workdir) {
  if (!workdir) return null
  let dir = workdir
  for (let i = 0; i < 4; i += 1) {
    if (COMPOSE_FILES.some((name) => existsSync(join(dir, name)))) return dir
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}

function stopAppPid(workdir) {
  if (!workdir) return { stopped: false }
  const pidFile = join(workdir, '.harness', 'app.pid')
  if (!existsSync(pidFile)) return { stopped: false }
  let pid = 0
  try {
    pid = Number(readFileSync(pidFile, 'utf8').trim())
  } catch {
    return { stopped: false }
  }
  if (!Number.isInteger(pid) || pid <= 0) return { stopped: false }
  terminateProcessTree(pid, 'SIGTERM')
  try { process.kill(pid, 0); terminateProcessTree(pid, 'SIGKILL') } catch {}
  try { unlinkSync(pidFile) } catch {}
  return { stopped: true, pid }
}

/** Prefer `./init.sh stop` when present; fall back to `.harness/app.pid`. */
export function stopWorktreeApp(workdir) {
  if (!workdir) return { stopped: false, via: null }
  const initSh = join(workdir, 'init.sh')
  if (existsSync(initSh)) {
    const result = spawnSync('bash', [initSh, 'stop'], {
      cwd: workdir,
      encoding: 'utf8',
      timeout: 30_000,
    })
    if (result.status === 0) {
      return { stopped: true, via: 'init.sh', status: result.status }
    }
  }
  const fallback = stopAppPid(workdir)
  return { ...fallback, via: fallback.stopped ? 'app.pid' : null }
}

function listComposeServices(dir) {
  const result = spawnSync('docker', ['compose', 'config', '--services'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (result.status !== 0) return []
  return String(result.stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Tear down compose for a worktree.
 * When other harness contexts still hold the shared infra lease, only stop/rm
 * app services (api/worker/dashboard/…) and leave postgres/redis/hindsight up.
 */
export function composeDown(workdir, {
  timeoutMs = 120_000,
  force = false,
  commonGit = null,
  projectId = null,
  context = null,
  shareCount = null,
} = {}) {
  const dir = composeProjectDir(workdir)
  if (!dir) return { ran: false, dir: null }

  // Shared Runtime Lease decisions live in compose-shared (ADR-0021).
  const plan = planSharedRuntimeTeardown({
    commonGit,
    projectId,
    context,
    shareCount,
    force,
  })
  if (plan.mode === 'refused') {
    return {
      ran: false,
      dir,
      mode: 'refused',
      reason: plan.reason,
      status: 0,
      skippedFullDown: true,
      error: plan.error || 'composeDown requires commonGit+context, shareCount, or force',
    }
  }
  if (plan.mode === 'app_services_only') {
    const services = listComposeServices(dir).filter((name) => isAppService(name))
    if (!services.length) {
      return {
        ran: true,
        dir,
        mode: plan.mode,
        reason: plan.reason,
        status: 0,
        skippedFullDown: true,
        services: [],
        error: null,
      }
    }
    const result = spawnSync(
      'docker',
      ['compose', 'rm', '-sf', '--', ...services],
      { cwd: dir, encoding: 'utf8', timeout: timeoutMs },
    )
    return {
      ran: true,
      dir,
      mode: plan.mode,
      reason: plan.reason,
      status: result.status,
      skippedFullDown: true,
      services,
      error: result.error?.message || null,
    }
  }

  const result = spawnSync('docker', ['compose', 'down', '--remove-orphans'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: timeoutMs,
  })
  return {
    ran: true,
    dir,
    mode: plan.mode,
    reason: plan.reason,
    status: result.status,
    skippedFullDown: false,
    error: result.error?.message || null,
  }
}

/**
 * Tear down servers and compose stacks owned by one worktree/port.
 * Supervisor-side counterpart to RESOURCE_CLEANUP_RULE (agents often skip it).
 */
export function cleanupWorktreeRuntime({
  workdir,
  port,
  commonGit = null,
  projectId = null,
  context = null,
  forceComposeDown = false,
} = {}) {
  if (process.platform === 'win32') {
    return { appPid: { stopped: false }, killed: 0, manifestKilled: 0, containersRemoved: 0, compose: { ran: false, dir: null } }
  }
  if (!workdir && !port) {
    return { appPid: { stopped: false }, killed: 0, manifestKilled: 0, containersRemoved: 0, compose: { ran: false, dir: null } }
  }
  const manifest = readOwnedRuntime(workdir)
  let manifestKilled = 0
  let containersRemoved = 0
  for (const row of manifest) {
    for (const pid of row.pids || []) {
      if (pid) {
        terminateProcessTree(pid, 'SIGTERM')
        manifestKilled += 1
      }
    }
    for (const name of row.containers || []) {
      const result = spawnSync('docker', ['rm', '-f', String(name)], { stdio: 'ignore' })
      if (result.status === 0) containersRemoved += 1
    }
  }
  const appPid = stopWorktreeApp(workdir)
  // Safety net if init.sh stop left a live PID file behind.
  if (appPid.via === 'init.sh') stopAppPid(workdir)
  const killed = killMatchingPatterns(runtimeKillPatterns({ workdir, port }))
  const compose = composeDown(workdir, {
    force: forceComposeDown,
    commonGit,
    projectId,
    context,
  })
  return { appPid, killed, manifestKilled, containersRemoved, compose }
}
