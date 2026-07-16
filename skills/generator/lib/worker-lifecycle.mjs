import { spawn, spawnSync } from 'node:child_process'

/**
 * Shared supervisor worker runtime plans.
 * harness-control applies side effects from these pure builders.
 */

export function ownedResourcesForClaim(claim) {
  return {
    port: claim?.port ?? null,
    worktree: claim?.worktree ?? null,
    profileDir: claim?.profileDir ?? null,
    processGroup: null,
  }
}

export function buildOrchestratorArgv({
  orchestrator,
  repo,
  host,
  claim,
  guidance = '',
  mode = 'work-items',
}) {
  const args = [
    orchestrator,
    '--host', host,
    '--repo', repo,
    '--workdir', claim.worktree,
    '--context', claim.context,
    '--port', String(claim.port),
    '--features', (claim.featureIds || []).join(','),
  ]
  if (mode === 'goal-review') {
    args.push('--mode', 'goal-review')
  }
  if (guidance) args.push('--guidance', guidance)
  return args
}

export function buildWorkerBase({ claim, logFile, reservationId = null }) {
  return {
    governorReservationId: reservationId,
    context: claim.context,
    featureIds: claim.featureIds || [],
    worktree: claim.worktree,
    port: claim.port,
    startedAt: new Date().toISOString(),
    logFile,
    ownedResources: ownedResourcesForClaim(claim),
  }
}

export function workerLogFileName(context) {
  if (context === 'goal-review') return `goal-review-${Date.now()}.log`
  return `${String(context).replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}.log`
}

export function planWorkerStop(worker, { signal = 'SIGTERM' } = {}) {
  if (!worker) return { kind: 'noop' }
  const pid = worker.child?.pid || worker.childPid || worker.ownedResources?.processGroup || worker.pid || null
  if (pid) return { kind: 'terminate_tree', pid, signal }
  return { kind: 'noop' }
}

export function processGroupForWorker(worker = {}, runState = {}) {
  return worker?.pid || worker?.childPid || runState.ownerPid || runState.childPid || null
}

export function planWorkerCleanupTargets(worker) {
  const owned = worker?.ownedResources || {}
  return {
    port: owned.port ?? worker?.port ?? null,
    workdir: owned.worktree ?? worker?.worktree ?? null,
    profileDir: owned.profileDir ?? null,
    commonGit: owned.commonGit ?? worker?.commonGit ?? null,
    projectId: owned.projectId ?? worker?.projectId ?? null,
    context: owned.context ?? worker?.context ?? null,
  }
}

export function terminateProcessTree(pid, signal = 'SIGTERM') {
  if (!pid) return { terminated: false }
  const sig = signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM'
  const killArg = sig === 'SIGKILL' ? '-9' : '-15'
  if (process.platform !== 'win32') {
    try {
      spawnSync('pkill', [`-${sig === 'SIGKILL' ? '9' : '15'}`, '-P', String(pid)], { stdio: 'ignore' })
      try { process.kill(-pid, sig) } catch {}
    } catch {}
    spawnSync('kill', [killArg, String(pid)], { stdio: 'ignore' })
  }
  try { process.kill(pid, sig) } catch {}
  return { terminated: true, pid, signal: sig }
}

/** pgrep/pkill by regex; used by worktree and browser cleanup. */
export function killMatchingPatterns(patterns) {
  let killed = 0
  if (process.platform === 'win32') return killed
  for (const pattern of patterns || []) {
    if (!pattern) continue
    const probe = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' })
    if (probe.status !== 0 || !probe.stdout.trim()) continue
    const pkill = spawnSync('pkill', ['-f', pattern], { encoding: 'utf8' })
    if (pkill.status === 0) killed += 1
  }
  return killed
}

/** Kill a host agent child and its process group. */
export function terminateHostProcess(child, signal = 'SIGTERM') {
  if (!child?.pid) return
  terminateProcessTree(child.pid, signal)
  try { child.kill(signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM') } catch {}
}

/** Spawn a host CLI as a detached background child with piped stdout/stderr. */
export function spawnHostAgent(program, args, { cwd, env = {} } = {}) {
  return spawn(program, args, {
    cwd,
    detached: process.platform !== 'win32',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * Tear down browsers owned by this run only.
 * Requires port and/or workdir; never matches global headless chromium.
 */
export function cleanupBrowserOrphans({ port, workdir, profileDir } = {}) {
  if (process.platform === 'win32') return { killed: 0 }
  if (!port && !workdir && !profileDir) return { killed: 0 }
  const patterns = [
    port && `-remote-debugging-port=${port}`,
    port && `--remote-debugging-port=${port}`,
    port && `playwright.*${port}`,
    profileDir && `chrome.*--user-data-dir=${profileDir}`,
    profileDir && `chromium.*--user-data-dir=${profileDir}`,
    workdir && `chrome.*${workdir}`,
    workdir && `chromium.*${workdir}`,
    workdir && `playwright.*${workdir}`,
  ]
  return { killed: killMatchingPatterns(patterns) }
}

/**
 * Periodic Run State heartbeat with consecutive-failure escalation.
 * Clears the interval after maxConsecutiveFailures so a dead fence/IO path
 * cannot silently look like a live owner forever.
 */
export function startStateHeartbeat(writeState, {
  intervalMs = 15_000,
  maxConsecutiveFailures = 3,
  label = 'harness',
  onEscalated = null,
} = {}) {
  let failures = 0
  const timer = setInterval(() => {
    Promise.resolve()
      .then(() => writeState())
      .then(() => { failures = 0 })
      .catch((error) => {
        failures += 1
        const detail = error?.message || String(error)
        process.stderr.write(
          `${label} heartbeat write failed (${failures}/${maxConsecutiveFailures}): ${detail}\n`,
        )
        if (failures < maxConsecutiveFailures) return
        clearInterval(timer)
        try { onEscalated?.(error) } catch {}
      })
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return timer
}
