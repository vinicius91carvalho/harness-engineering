import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'

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
