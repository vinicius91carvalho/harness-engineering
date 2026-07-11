import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { terminateProcessTree } from './worker-lifecycle.mjs'

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

export function composeDown(workdir, { timeoutMs = 120_000 } = {}) {
  const dir = composeProjectDir(workdir)
  if (!dir) return { ran: false, dir: null }
  const result = spawnSync('docker', ['compose', 'down', '--remove-orphans'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: timeoutMs,
  })
  return {
    ran: true,
    dir,
    status: result.status,
    error: result.error?.message || null,
  }
}

/**
 * Tear down servers and compose stacks owned by one worktree/port.
 * Supervisor-side counterpart to RESOURCE_CLEANUP_RULE (agents often skip it).
 */
export function cleanupWorktreeRuntime({ workdir, port } = {}) {
  if (process.platform === 'win32') {
    return { appPid: { stopped: false }, killed: 0, compose: { ran: false, dir: null } }
  }
  if (!workdir && !port) {
    return { appPid: { stopped: false }, killed: 0, compose: { ran: false, dir: null } }
  }
  const appPid = stopAppPid(workdir)
  const killed = killPatterns(runtimeKillPatterns({ workdir, port }))
  const compose = composeDown(workdir)
  return { appPid, killed, compose }
}
