import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { terminateProcessTree } from './worker-lifecycle.mjs'
import {
  composeShareCount,
  isAppService,
  planComposeTeardown,
  releaseComposeShare,
} from './compose-shared.mjs'

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

function killPatterns(patterns) {
  let killed = 0
  for (const pattern of patterns) {
    if (!pattern) continue
    const probe = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' })
    if (probe.status !== 0 || !probe.stdout.trim()) continue
    const pkill = spawnSync('pkill', ['-f', pattern], { encoding: 'utf8' })
    if (pkill.status === 0) killed += 1
  }
  return killed
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

  let remaining = shareCount
  if (remaining == null && commonGit && context) {
    // Release this context first so last-holder can full-down.
    const released = releaseComposeShare(commonGit, projectId, context)
    remaining = released.count
  } else if (remaining == null && commonGit) {
    remaining = composeShareCount(commonGit, projectId)
  } else if (remaining == null) {
    remaining = 0
  }

  const plan = planComposeTeardown({ shareCount: remaining, force, context })
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
    return { appPid: { stopped: false }, killed: 0, compose: { ran: false, dir: null } }
  }
  if (!workdir && !port) {
    return { appPid: { stopped: false }, killed: 0, compose: { ran: false, dir: null } }
  }
  const appPid = stopAppPid(workdir)
  const killed = killPatterns(runtimeKillPatterns({ workdir, port }))
  const compose = composeDown(workdir, {
    force: forceComposeDown,
    commonGit,
    projectId,
    context,
  })
  return { appPid, killed, compose }
}
