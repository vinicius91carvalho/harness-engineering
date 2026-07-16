/**
 * Supervisor first-invocation preflight (fail-closed).
 * Clears ghost Run States, dead Claim Leases, dead governor reservations,
 * stale capacity/workerHealth snapshots, and unregistered leftover worktrees.
 * Reconcile --check gates start; capacity=0 is reported but does not block.
 */
import {
  existsSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { hostname } from 'node:os'

import { isLiveRunOwner, abandonGhostRun, listGhostClaims, processAlive } from '../../generator/lib/orphan-claims.mjs'
import { readJsonFile, writeJsonAtomic } from '../../generator/lib/git-repo.mjs'
import { journalLockHolderAlive, journalPaths } from '../../generator/lib/control-journal.mjs'

const GENERIC_RETRY = /^Auto-retry:/i

function keyFromRunFile(name) {
  return String(name || '').replace(/\.json$/, '')
}

function git(repo, args) {
  return spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
}

function listWorktrees(repo) {
  const result = git(repo, ['worktree', 'list', '--porcelain'])
  if (result.status !== 0) return []
  const paths = []
  for (const line of String(result.stdout || '').split('\n')) {
    if (line.startsWith('worktree ')) paths.push(line.slice('worktree '.length))
  }
  return paths
}

function findLatestEvidenceLog(evidenceRoot, context) {
  if (!existsSync(evidenceRoot)) return null
  const candidates = []
  const walk = (dir, depth = 0) => {
    if (depth > 6) return
    let entries = []
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      const full = join(dir, name)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) walk(full, depth + 1)
      else if (name.endsWith('.log') && (
        name.includes('-integration_qa-') || name.includes('-qa-') || name.includes('-coding-')
      )) {
        if (context && !full.includes(`/${context}/`) && !full.includes(`\\${context}\\`)) continue
        candidates.push({ full, mtime: st.mtimeMs })
      }
    }
  }
  walk(evidenceRoot)
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0]?.full || null
}

/**
 * @param {object} args
 * @param {string} args.repo
 * @param {string} args.commonGit
 * @param {string} args.projectId
 * @param {string} args.projectPrefix  e.g. "core--" or ""
 * @param {string} args.stateFile
 * @param {string} args.reconciler path to reconcile.mjs
 * @param {object} args.deps injected claim/governor helpers
 * @param {boolean} [args.repair=true] apply fixes (false = report only)
 * @param {object} [args.capacityOptions]
 */
export async function runSupervisorPreflight({
  repo,
  commonGit,
  projectId,
  projectPrefix = '',
  stateFile,
  reconciler,
  deps,
  repair = true,
  capacityOptions = {},
  nodeExecPath = process.execPath,
} = {}) {
  const actions = []
  const warnings = []
  const blockers = []

  // 1) Reconcile gate
  const validation = spawnSync(nodeExecPath, [reconciler, repo, '--check'], {
    cwd: repo,
    encoding: 'utf8',
  })
  const reconcileOk = validation.status === 0
  if (!reconcileOk) {
    blockers.push({
      kind: 'reconcile',
      message: (validation.stderr || validation.stdout || 'reconcile --check failed').trim().slice(0, 800),
    })
  } else {
    actions.push({ kind: 'reconcile', ok: true })
  }

  // 2) Prune dead governor reservations (persist)
  if (deps?.pruneDeadReservations) {
    const pruned = await deps.pruneDeadReservations(commonGit)
    if (pruned?.removed?.length) {
      actions.push({ kind: 'governor_pruned', removed: pruned.removed })
    } else {
      actions.push({ kind: 'governor_ok' })
    }
  }

  // 3) Ghost Run States (running + dead owner/child) - before claim release
  const claimsFile = join(commonGit, 'generator-claims.json')
  const runsDir = join(commonGit, 'harness-runs')
  const ghostRuns = []
  const allClaims = readJsonFile(claimsFile, {})
  const scopedClaims = {}
  for (const [key, claim] of Object.entries(allClaims)) {
    if (claim?.project && projectId && claim.project !== projectId && projectId !== 'root') continue
    if (projectPrefix) {
      const pid = String(projectPrefix).replace(/\/$/, '')
      if (!key.startsWith(pid) && claim?.project !== projectId) continue
    }
    scopedClaims[key] = claim
  }

  const runStatesByContext = {}
  const runStateFiles = {}
  if (existsSync(runsDir)) {
    for (const name of readdirSync(runsDir)) {
      if (!name.endsWith('.json') || name.endsWith('.result.json')) continue
      const pid = String(projectPrefix || '').replace(/\/$/, '')
      if (pid && !name.startsWith(`${pid}--`) && name !== `${pid}.json`) continue
      if (!pid && name.includes('--') && projectId && projectId !== 'root') continue
      const file = join(runsDir, name)
      const run = readJsonFile(file, {})
      const ctx = run.context || keyFromRunFile(name)
      runStatesByContext[ctx] = run
      runStateFiles[ctx] = { file, name }
    }
  }

  const ghosts = listGhostClaims({
    claims: scopedClaims,
    runStatesByContext,
    processAlive,
  })
  for (const ghost of ghosts) {
    const meta = runStateFiles[ghost.context]
    if (!meta) continue
    ghostRuns.push({
      file: meta.file,
      name: meta.name,
      context: ghost.context,
      ownerPid: ghost.runState?.ownerPid,
      childPid: ghost.runState?.childPid,
    })
    if (repair) {
      writeJsonAtomic(meta.file, abandonGhostRun(ghost.runState, {
        reason: 'preflight: owner/child PID dead',
      }))
      actions.push({ kind: 'run_abandoned', name: meta.name, context: ghost.context })
    }
  }
  if (!ghostRuns.length) actions.push({ kind: 'runs_ok' })
  else if (!repair) warnings.push({ kind: 'ghost_runs', items: ghostRuns })

  // 4) Dead claim leases — drop only abandoned building sessions (session PID was set
  //    and is now dead). Never clear blocked/held claims that have no session — those
  //    are intentional Claim Lease holds for blocked Work Items.
  const claims = readJsonFile(claimsFile, {})
  const deadClaims = []
  let claimsDirty = false
  const nextClaims = { ...claims }
  for (const [key, claim] of Object.entries(claims)) {
    if (claim?.project && projectId && claim.project !== projectId && projectId !== 'root') continue
    if (projectPrefix) {
      const pid = String(projectPrefix).replace(/\/$/, '')
      if (!key.startsWith(pid) && claim?.project !== projectId) continue
    }
    const session = claim?.session
    if (!session) continue
    if (processAlive(session)) continue
    const runFile = join(runsDir, `${key}.json`)
    const run = readJsonFile(runFile, {})
    if (isLiveRunOwner(run, processAlive)) continue
    deadClaims.push({ key, context: claim.context, session })
    if (repair) {
      delete nextClaims[key]
      claimsDirty = true
      actions.push({ kind: 'lease_cleared', context: claim.context, session, key })
    }
  }
  if (claimsDirty) writeJsonAtomic(claimsFile, nextClaims)
  else if (deadClaims.length && !repair) warnings.push({ kind: 'dead_claims', items: deadClaims })
  else if (!deadClaims.length) actions.push({ kind: 'claims_ok' })

  // 5) Stale state.json capacity / workerHealth / workers for dead PIDs
  const state = readJsonFile(stateFile, {})
  let stateDirty = false
  const nextState = { ...state }

  // 5a) Dead Control Journal lock — crashed supervisors leave journal.lock behind.
  //     Without this, initialize() emit() dies with "control journal lock timeout".
  const journalLockPath = journalPaths(dirname(stateFile)).lock
  if (existsSync(journalLockPath)) {
    const holderAlive = journalLockHolderAlive(journalLockPath)
    if (!holderAlive) {
      if (repair) {
        try {
          rmSync(journalLockPath, { force: true })
          actions.push({ kind: 'journal_lock_cleared', path: journalLockPath })
        } catch (error) {
          warnings.push({ kind: 'journal_lock_clear_failed', path: journalLockPath, error: error.message })
        }
      } else {
        warnings.push({ kind: 'stale_journal_lock', path: journalLockPath })
      }
    } else {
      actions.push({ kind: 'journal_lock_ok' })
    }
  }

  // 5b) Ghost mergeLock snapshot when the lock dir is gone or the owner PID is dead
  if (nextState.mergeLock?.owner) {
    const mergeDir = join(commonGit, 'harness-locks', 'generator-merge')
    const lockPresent = existsSync(mergeDir)
    const owner = nextState.mergeLock.owner
    const ownerAlive = processAlive(owner)
    if (!lockPresent || !ownerAlive) {
      if (repair) {
        nextState.mergeLock = null
        stateDirty = true
        actions.push({
          kind: 'cleared_ghost_mergeLock',
          owner: String(owner),
          lockPresent,
          ownerAlive,
        })
      } else {
        warnings.push({ kind: 'ghost_mergeLock', mergeLock: nextState.mergeLock })
      }
    }
  }

  if (nextState.capacity) {
    delete nextState.capacity
    stateDirty = true
    actions.push({ kind: repair ? 'cleared_stale_capacity_snapshot' : 'stale_capacity_detected' })
  }
  if (nextState.workerHealth && typeof nextState.workerHealth === 'object') {
    const kept = {}
    for (const [ctx, health] of Object.entries(nextState.workerHealth)) {
      const childPid = health?.childPid
      if (childPid && processAlive(childPid)) kept[ctx] = health
      else stateDirty = true
    }
    if (Object.keys(kept).length !== Object.keys(nextState.workerHealth).length) {
      nextState.workerHealth = kept
      actions.push({ kind: repair ? 'cleared_stale_workerHealth' : 'stale_workerHealth_detected' })
    }
  }
  if (nextState.workers && typeof nextState.workers === 'object') {
    const keptWorkers = {}
    for (const [ctx, worker] of Object.entries(nextState.workers)) {
      const pid = worker?.pid || worker?.childPid
      if (pid && processAlive(pid)) keptWorkers[ctx] = worker
      else if (!pid && worker?.type === 'herdr' && worker?.paneId) keptWorkers[ctx] = worker
      else stateDirty = true
    }
    if (Object.keys(keptWorkers).length !== Object.keys(nextState.workers).length) {
      nextState.workers = keptWorkers
      actions.push({ kind: repair ? 'cleared_dead_workers_map' : 'dead_workers_map_detected' })
    }
  }
  // Seed evidence-backed retry guidance when queue is empty/generic and ghosts existed
  if (repair && deps?.evidenceGuidanceExcerpt) {
    const evidenceRoot = join(commonGit, 'harness-evidence', projectId || 'root')
    nextState.retryQueue = nextState.retryQueue || {}
    const contexts = new Set([
      ...ghostRuns.map((g) => g.context).filter(Boolean),
      ...deadClaims.map((c) => c.context).filter(Boolean),
      ...Object.keys(nextState.retryQueue),
    ])
    for (const context of contexts) {
      if (!context || context === 'goal-review') continue
      const existing = nextState.retryQueue[context]?.guidance || ''
      if (existing && !GENERIC_RETRY.test(existing)) continue
      const logPath = findLatestEvidenceLog(evidenceRoot, context)
      if (!logPath) continue
      const excerpt = deps.evidenceGuidanceExcerpt(logPath)
      if (!excerpt) continue
      nextState.retryQueue[context] = {
        guidance: `VERIFY-FIRST. ${excerpt}`,
        seededAt: new Date().toISOString(),
        seededBy: 'supervisor-preflight',
      }
      stateDirty = true
      actions.push({ kind: 'retry_guidance_seeded', context, from: logPath })
    }
  }
  if (stateDirty && repair) {
    nextState.supervisorPid = nextState.supervisorPid && processAlive(nextState.supervisorPid)
      ? nextState.supervisorPid
      : null
    writeJsonAtomic(stateFile, nextState)
  }

  // 6) Unregistered leftover worktree dirs (sibling *-wt-* ) — never remove a path
  //    still referenced by a live owner/child Run State.
  const toplevel = git(repo, ['rev-parse', '--show-toplevel']).stdout?.trim() || repo
  const registered = new Set(listWorktrees(toplevel))
  const liveWorktrees = new Set()
  if (existsSync(runsDir)) {
    for (const name of readdirSync(runsDir)) {
      if (!name.endsWith('.json') || name.endsWith('.result.json')) continue
      const run = readJsonFile(join(runsDir, name), {})
      if (isLiveRunOwner(run, processAlive)) {
        if (run.worktree) liveWorktrees.add(run.worktree)
        // worktree field is often .../core; also protect the checkout root
        if (run.worktree) liveWorktrees.add(dirname(run.worktree))
      }
    }
  }
  const parent = dirname(toplevel)
  const leftovers = []
  const prefix = basename(toplevel)
  try {
    for (const name of readdirSync(parent)) {
      if (!name.startsWith(`${prefix}-wt-`) && !name.startsWith(`${prefix}-wt`)) continue
      const full = join(parent, name)
      if (registered.has(full)) continue
      if ([...liveWorktrees].some((wt) => wt === full || wt.startsWith(`${full}/`))) continue
      leftovers.push(full)
      if (repair) {
        try {
          rmSync(full, { recursive: true, force: true })
          actions.push({ kind: 'orphan_worktree_removed', path: full })
        } catch (error) {
          warnings.push({ kind: 'orphan_worktree_remove_failed', path: full, error: error.message })
        }
      }
    }
  } catch { /* ignore */ }
  // prune git worktree metadata
  if (repair) git(toplevel, ['worktree', 'prune'])
  if (!leftovers.length) actions.push({ kind: 'worktrees_ok' })

  // 7) Capacity probe (warn only)
  let capacity = null
  if (deps?.observeCapacity) {
    capacity = await deps.observeCapacity(commonGit, capacityOptions)
    if ((capacity?.memory?.slots ?? capacity?.slots ?? 0) < 1) {
      warnings.push({
        kind: 'memory_slots_zero',
        freeMb: capacity?.memory?.freeMb,
        reserveMb: capacity?.memory?.reserveMb,
        perWorkerMb: capacity?.memory?.perWorkerMb,
        message: 'Admission may stall until RAM frees or reserve/per-worker is lowered',
      })
    } else {
      actions.push({ kind: 'capacity_ok', available: capacity.available ?? capacity.slots })
    }
  }

  // Dead merge/state locks are intentionally left for the supervisor tick so
  // empty-fleet recovery can reset crash-bound counts when it clears them.

  const ok = blockers.length === 0
  return {
    ok,
    host: hostname(),
    projectId,
    reconcileOk,
    blockers,
    warnings,
    actions,
    capacity,
    repaired: repair,
  }
}
