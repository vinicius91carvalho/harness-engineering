import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomInt } from 'node:crypto'
import { hostname } from 'node:os'
import {
  git,
  gitRoot,
  gitCommonDir,
  projectPrefix,
  readFeatureListFromMain,
  portInUse,
  processAlive,
  readJsonFile,
  writeJsonAtomic,
} from './git-repo.mjs'
import { claimKey, projectIdFromPrefix, sanitizeKey } from './project-keys.mjs'
import { readyWorkItems } from './ready-work-items.mjs'

export const DEFAULT_BASE_PORT = Number(process.env.GEN_BASE_PORT || 5170)
export const LEASE_TIMEOUT_SECONDS = Number(process.env.HARNESS_LEASE_TIMEOUT_SECONDS || 60)

let stateLockToken = null

function currentHost() {
  try {
    return hostname()
  } catch {
    return 'unknown'
  }
}

function sleepMs(ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    /* spin */
  }
}

function stealDeadStateLock(lockDir) {
  if (!existsSync(lockDir)) return false
  const ownerHost = existsSync(join(lockDir, 'host'))
    ? readFileSync(join(lockDir, 'host'), 'utf8').trim()
    : ''
  const ownerRaw = existsSync(join(lockDir, 'owner'))
    ? readFileSync(join(lockDir, 'owner'), 'utf8').trim()
    : ''
  const ownerPid = Number(ownerRaw.split('.')[0])
  if (ownerHost !== currentHost()) return false
  if (!ownerPid || processAlive(ownerPid)) return false
  rmSync(join(lockDir, 'owner'), { force: true })
  rmSync(join(lockDir, 'host'), { force: true })
  try {
    rmSync(lockDir, { recursive: true })
  } catch {
    /* ignore */
  }
  return true
}

export function repoPaths(repo) {
  const commonGit = gitCommonDir(repo)
  const prefix = projectPrefix(repo)
  const projectId = projectIdFromPrefix(prefix)
  return {
    repo,
    commonGit,
    prefix,
    projectId,
    claimsFile: join(commonGit, 'generator-claims.json'),
    stateLockDir: join(commonGit, 'harness-locks', 'generator-state'),
    mergeLockDir: join(commonGit, 'harness-locks', 'generator-merge'),
    runDir: join(commonGit, 'harness-runs'),
    strikeFile: join(commonGit, 'harness-runs', `strikes--${projectId}.json`),
    runStateFile: (key) => join(commonGit, 'harness-runs', `${sanitizeKey(key)}.json`),
    claimKey: (context) => claimKey(projectId, context),
  }
}

export function readClaims(repo) {
  const { claimsFile } = repoPaths(repo)
  return readJsonFile(claimsFile, {})
}

export function writeClaims(repo, claims) {
  writeJsonAtomic(repoPaths(repo).claimsFile, claims)
}

export function readStrikes(repo) {
  const { strikeFile } = repoPaths(repo)
  return readJsonFile(strikeFile, {})
}

export function writeStrikes(repo, strikes) {
  writeJsonAtomic(repoPaths(repo).strikeFile, strikes)
}

export function writeRunState(repo, key, state) {
  const file = repoPaths(repo).runStateFile(key)
  mkdirSync(dirname(file), { recursive: true })
  writeJsonAtomic(file, state)
}

export function acquireStateLock(repo) {
  const { stateLockDir } = repoPaths(repo)
  mkdirSync(dirname(stateLockDir), { recursive: true })
  const pid = process.pid
  const token = `${pid}.${randomInt(1_000_000)}.${Math.floor(Date.now() / 1000)}`
  const host = currentHost()
  for (let tries = 0; tries < 300; tries += 1) {
    try {
      mkdirSync(stateLockDir)
      writeFileSync(join(stateLockDir, 'owner'), `${token}\n`)
      writeFileSync(join(stateLockDir, 'host'), `${host}\n`)
      sleepMs(20)
      const owner = readFileSync(join(stateLockDir, 'owner'), 'utf8').trim()
      if (owner === token) {
        stateLockToken = token
        return
      }
    } catch {
      if (stealDeadStateLock(stateLockDir)) continue
    }
    sleepMs(100)
  }
  throw new Error(`timed out waiting for state lock: ${stateLockDir}`)
}

export function releaseStateLock(repo) {
  const { stateLockDir } = repoPaths(repo)
  if (!stateLockToken) return
  const owner = existsSync(join(stateLockDir, 'owner'))
    ? readFileSync(join(stateLockDir, 'owner'), 'utf8').trim()
    : ''
  if (owner !== stateLockToken) return
  rmSync(join(stateLockDir, 'owner'), { force: true })
  rmSync(join(stateLockDir, 'host'), { force: true })
  try {
    rmSync(stateLockDir, { recursive: true })
  } catch {
    /* ignore */
  }
  stateLockToken = null
}

function readyModeForClaim(mode) {
  if (mode === 'qa') return 'qa'
  return 'all'
}

export function pickClaimCandidate(repo, mode, selector, claims) {
  const paths = repoPaths(repo)
  const queue = readFeatureListFromMain(repo)
  if (!queue) return null

  const ready = readyWorkItems(queue, {
    mode: readyModeForClaim(mode),
    taskId: mode === 'task' && selector ? selector : null,
  })

  let context = null
  if (mode === 'feature') {
    context = selector || null
  } else if (mode === 'task') {
    const match = ready.find((item) => String(item.id) === String(selector))
    context = match?.context ?? null
  } else {
    const seen = new Set()
    for (const item of ready) {
      if (seen.has(item.context)) continue
      seen.add(item.context)
      const key = paths.claimKey(item.context)
      if (!claims[key]) {
        context = item.context
        break
      }
    }
  }

  if (!context) return null
  const key = paths.claimKey(context)
  if (claims[key]) return null

  let featureIds
  if (mode === 'task') {
    featureIds = selector ? [selector] : []
  } else {
    featureIds = ready.filter((item) => item.context === context).map((item) => item.id)
  }
  if (featureIds.length === 0) return null

  return { context, key, featureIds }
}

function featureListValid(worktreePath) {
  const file = join(worktreePath, 'feature_list.json')
  if (!existsSync(file)) return false
  try {
    JSON.parse(readFileSync(file, 'utf8'))
    return true
  } catch {
    return false
  }
}

function restoreFeatureListFromMain(repo) {
  git(repo, ['restore', '-s', 'main', '--', 'feature_list.json'], { allowFailure: true })
}

function removeWorktree(repo, checkout) {
  git(repo, ['worktree', 'remove', '--force', checkout], { allowFailure: true })
  git(repo, ['worktree', 'prune'], { allowFailure: true })
}

function branchExists(repo, branch) {
  const result = git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true })
  return result.status === 0
}

function worktreeRegistered(repo, checkout) {
  const result = git(repo, ['worktree', 'list', '--porcelain'], { allowFailure: true })
  if (result.status !== 0) return false
  return result.stdout.split('\n').some((line) => line === `worktree ${checkout}`)
}

function checkoutOnBranch(checkout, branch) {
  const result = git(checkout, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true })
  return result.status === 0 && result.stdout.trim() === branch
}

function addWorktree(repo, checkout, branch) {
  if (branchExists(repo, branch)) {
    git(repo, ['worktree', 'add', checkout, branch])
  } else {
    const result = git(repo, ['worktree', 'add', checkout, '-b', branch, 'main'], { allowFailure: true })
    if (result.status !== 0) return 75
  }
  restoreFeatureListFromMain(repo)
  return 0
}

export function prepareWorktree(repo, context, paths) {
  const root = gitRoot(repo)
  const sctx = sanitizeKey(context)
  const branch = `gen/${paths.projectId}-${sctx}`
  const checkout = `${root.replace(/\/$/, '')}-wt-${paths.projectId}-${sctx}`
  let wt = paths.prefix ? join(checkout, paths.prefix.replace(/\/$/, '')) : checkout

  if (
    existsSync(checkout)
    && checkoutOnBranch(checkout, branch)
    && worktreeRegistered(repo, checkout)
  ) {
    if (!featureListValid(wt)) {
      restoreFeatureListFromMain(repo)
    }
    if (featureListValid(wt)) {
      return { branch, checkout, worktree: wt }
    }
    if (existsSync(checkout)) {
      removeWorktree(repo, checkout)
    }
    const status = addWorktree(repo, checkout, branch)
    if (status === 75) return { retry: true }
    return { branch, checkout, worktree: wt }
  }

  if (existsSync(checkout)) {
    removeWorktree(repo, checkout)
  }
  const status = addWorktree(repo, checkout, branch)
  if (status === 75) return { retry: true }
  if (!paths.prefix) wt = checkout
  return { branch, checkout, worktree: wt }
}

export function pickPort(claims, basePort = DEFAULT_BASE_PORT) {
  const used = new Set(
    Object.values(claims)
      .map((entry) => entry.port)
      .filter((port) => port != null),
  )
  let slot = 0
  while (used.has(basePort + slot) || portInUse(basePort + slot)) slot += 1
  return basePort + slot
}

export function recordClaim(paths, {
  context,
  key,
  branch,
  worktree,
  port,
  session,
  featureIds,
}) {
  const claims = readClaims(paths.repo)
  const started = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  claims[key] = {
    branch,
    worktree,
    project: paths.projectId,
    context,
    port,
    session: String(session),
    status: 'building',
    started,
    featureIds,
  }
  writeClaims(paths.repo, claims)

  const epoch = Math.floor(Date.now() / 1000)
  writeRunState(paths.repo, key, {
    context,
    status: 'claimed',
    phase: 'claimed',
    ownerHost: currentHost(),
    ownerPid: null,
    childPid: null,
    worktree,
    port,
    featureIds,
    attempt: 1,
    nextAction: 'start-orchestrator',
    heartbeatEpoch: epoch,
  })
}

export function selectClaim(repo, mode, selector, session) {
  const paths = repoPaths(repo)
  for (let attempts = 0; attempts < 10; attempts += 1) {
    acquireStateLock(repo)
    try {
      const claims = readClaims(repo)
      const candidate = pickClaimCandidate(repo, mode, selector, claims)
      if (!candidate) return null

      const port = pickPort(claims)
      const wtResult = prepareWorktree(repo, candidate.context, paths)
      if (wtResult.retry) {
        releaseStateLock(repo)
        sleepMs(50)
        continue
      }

      recordClaim(paths, {
        context: candidate.context,
        key: candidate.key,
        branch: wtResult.branch,
        worktree: wtResult.worktree,
        port,
        session: session ?? process.pid,
        featureIds: candidate.featureIds,
      })

      return {
        context: candidate.context,
        worktree: wtResult.worktree,
        port,
        featureIds: candidate.featureIds,
      }
    } finally {
      releaseStateLock(repo)
    }
  }
  process.exitCode = 75
  return null
}

function stealDeadMergeLock(lockDir) {
  if (!existsSync(lockDir)) return false
  const ownerHost = existsSync(join(lockDir, 'host'))
    ? readFileSync(join(lockDir, 'host'), 'utf8').trim()
    : ''
  const ownerPid = existsSync(join(lockDir, 'owner'))
    ? readFileSync(join(lockDir, 'owner'), 'utf8').trim()
    : ''
  if (ownerHost !== currentHost()) return false
  if (ownerPid && processAlive(Number(ownerPid))) return false
  rmSync(join(lockDir, 'owner'), { force: true })
  rmSync(join(lockDir, 'host'), { force: true })
  try {
    rmSync(lockDir, { recursive: true })
  } catch {
    /* ignore */
  }
  return true
}

export function mergeAcquire(repo, session) {
  const { mergeLockDir, repo: repoPath, prefix } = repoPaths(repo)
  mkdirSync(dirname(mergeLockDir), { recursive: true })
  const host = currentHost()
  try {
    mkdirSync(mergeLockDir)
  } catch {
    if (!stealDeadMergeLock(mergeLockDir)) {
      process.stdout.write('BUSY\n')
      return { busy: true }
    }
    try {
      mkdirSync(mergeLockDir)
    } catch {
      process.stdout.write('BUSY\n')
      return { busy: true }
    }
  }
  writeFileSync(join(mergeLockDir, 'owner'), `${session ?? process.pid}\n`)
  writeFileSync(join(mergeLockDir, 'host'), `${host}\n`)

  const listResult = git(repoPath, ['worktree', 'list', '--porcelain'])
  let integ = null
  let current = null
  for (const line of listResult.stdout.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length)
    if (line === 'branch refs/heads/main' && current) {
      integ = current
      break
    }
  }

  if (!integ) {
    integ = `${repoPath.replace(/\/$/, '')}-wt-integration`
    if (!existsSync(integ)) {
      git(repoPath, ['worktree', 'add', integ, 'main'])
    }
  }

  const integDir = prefix ? join(integ.replace(/\/$/, ''), prefix.replace(/\/$/, '')) : integ
  return { integDir }
}

export function restoreDirtyRuntimeLogs(integ) {
  const diff = git(integ, ['diff', '--name-only', '--', '*.log', 'logs/'], { allowFailure: true })
  if (diff.status !== 0) return
  for (const logpath of diff.stdout.split('\n')) {
    if (!logpath) continue
    git(integ, ['checkout', '--', logpath], { allowFailure: true })
  }
}

export function mergeDo(repo, context, integ) {
  const paths = repoPaths(repo)
  const key = paths.claimKey(context)
  const claims = readClaims(repo)
  let branch = claims[key]?.branch
  if (!branch) branch = `gen/${paths.projectId}-${sanitizeKey(context)}`

  restoreDirtyRuntimeLogs(integ)

  const mergeResult = git(integ, ['merge', '--no-edit', branch], { allowFailure: true })
  if (mergeResult.status === 0) {
    return { status: 'clean' }
  }

  const unmerged = git(integ, ['diff', '--name-only', '--diff-filter=U'], { allowFailure: true }).stdout.trim()
  if (!unmerged) {
    return { status: 'error', message: (mergeResult.stderr || mergeResult.stdout || 'merge failed').trim() }
  }

  return { status: 'conflict', integ, paths: unmerged.split('\n').filter(Boolean) }
}

export function mergeRelease(repo, session) {
  const { mergeLockDir } = repoPaths(repo)
  const owner = existsSync(join(mergeLockDir, 'owner'))
    ? readFileSync(join(mergeLockDir, 'owner'), 'utf8').trim()
    : ''
  if (session && owner !== String(session)) {
    throw new Error(`merge lock is owned by ${owner}`)
  }
  rmSync(join(mergeLockDir, 'owner'), { force: true })
  rmSync(join(mergeLockDir, 'host'), { force: true })
  try {
    rmSync(mergeLockDir, { recursive: true })
  } catch {
    /* ignore */
  }
  return 'merge-lock released'
}

export function releaseClaim(repo, context) {
  const paths = repoPaths(repo)
  acquireStateLock(repo)
  try {
    const key = paths.claimKey(context)
    const claims = readClaims(repo)
    const wt = claims[key]?.worktree ?? ''
    const branch = claims[key]?.branch ?? ''
    let checkout = ''
    if (wt) {
      const result = git(wt, ['rev-parse', '--show-toplevel'], { allowFailure: true })
      if (result.status === 0) checkout = result.stdout.trim()
    }
    if (checkout) removeWorktree(repo, checkout)
    if (branch) git(repo, ['branch', '-D', branch], { allowFailure: true })

    delete claims[key]
    writeClaims(repo, claims)

    rmSync(paths.runStateFile(key), { force: true })

    const remaining = Object.values(claims).filter(
      (entry) => entry.project === paths.projectId,
    ).length
    if (remaining === 0) rmSync(paths.strikeFile, { force: true })

    return `released ${context}`
  } finally {
    releaseStateLock(repo)
  }
}

export function blockClaim(repo, context) {
  const paths = repoPaths(repo)
  acquireStateLock(repo)
  try {
    const key = paths.claimKey(context)
    const claims = readClaims(repo)
    if (!claims[key]) throw new Error(`unknown claim: ${context}`)
    claims[key].status = 'blocked'
    claims[key].session = ''
    writeClaims(repo, claims)

    const stateFile = paths.runStateFile(key)
    const state = readJsonFile(stateFile)
    if (state) {
      state.status = 'blocked'
      state.phase = 'blocked'
      state.ownerPid = null
      state.childPid = null
      state.nextAction = 'user-guidance'
      writeRunState(repo, key, state)
    }
    return `blocked ${context}`
  } finally {
    releaseStateLock(repo)
  }
}

export function resumeClaim(repo, selector, session, force = 'auto') {
  const paths = repoPaths(repo)
  acquireStateLock(repo)
  try {
    const claims = readClaims(repo)
    let key
    let context
    if (selector) {
      context = selector
      key = paths.claimKey(context)
    } else {
      key = Object.entries(claims).find(
        ([, value]) => value.project === paths.projectId && value.status === 'building',
      )?.[0]
      context = key ? claims[key].context : null
    }
    if (!context || !claims[key]) return null

    const status = claims[key].status
    if (status === 'blocked' && force !== 'force') {
      process.stderr.write(`BLOCKED ${context} requires explicit resume\n`)
      return null
    }

    const stateFile = paths.runStateFile(key)
    const state = readJsonFile(stateFile)
    const host = currentHost()

    if (!state) {
      if (force !== 'force') {
        process.stderr.write(`STALE ${context} has no Run State and requires explicit takeover\n`)
        return null
      }
    } else {
      const ownerHost = state.ownerHost ?? ''
      const ownerPid = state.ownerPid
      const childPid = state.childPid
      const heartbeat = Number(state.heartbeatEpoch ?? 0)
      const phase = state.phase ?? ''
      const now = Math.floor(Date.now() / 1000)

      if (ownerHost === host) {
        let live = false
        if (ownerPid && processAlive(ownerPid)) live = true
        if (childPid && processAlive(childPid)) live = true
        if (live) {
          process.stderr.write(`LIVE ${context} owner=${ownerPid} child=${childPid}\n`)
          return null
        }
        if (phase === 'claimed' && now - heartbeat < LEASE_TIMEOUT_SECONDS && force !== 'force') {
          process.stderr.write(`LIVE ${context} is waiting for its orchestrator to start\n`)
          return null
        }
      } else if (ownerHost) {
        if (now - heartbeat < LEASE_TIMEOUT_SECONDS) {
          process.stderr.write(`LIVE ${context} heartbeat is fresh on ${ownerHost}\n`)
          return null
        }
        if (force !== 'force') {
          process.stderr.write(`STALE ${context} on ${ownerHost} requires explicit takeover\n`)
          return null
        }
      }
    }

    claims[key].status = 'building'
    claims[key].session = String(session ?? process.pid)
    writeClaims(repo, claims)

    if (status !== 'blocked' && state) {
      state.previousPhase = state.phase
      state.status = 'resuming'
      state.resumedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
      state.ownerPid = null
      state.childPid = null
      writeRunState(repo, key, state)
    }

    const entry = readClaims(repo)[key]
    return {
      context: entry.context,
      worktree: entry.worktree,
      port: entry.port,
      featureIds: entry.featureIds,
      resumed: true,
    }
  } finally {
    releaseStateLock(repo)
  }
}

export function listClaims(repo) {
  const paths = repoPaths(repo)
  const claims = readClaims(repo)
  const filtered = Object.fromEntries(
    Object.entries(claims).filter(([, value]) =>
      value.project === paths.projectId || (value.project == null && paths.projectId === 'root')),
  )
  if (Object.keys(filtered).length === 0) return ['no active claims']

  const lines = []
  for (const [key, value] of Object.entries(filtered)) {
    const ctx = value.context ?? key
    const state = readJsonFile(paths.runStateFile(key), {})
    const phase = state.phase ?? '-'
    const attempt = state.attempt ?? '-'
    const next = state.nextAction ?? '-'
    const heartbeat = state.heartbeat ?? '-'
    const child = state.childPid ?? '-'
    const app = state.appPid ?? '-'
    const tasks = (value.featureIds ?? []).join(',')
    const line = `tasks=${tasks}\tport=${value.port}\t${value.status}\t${value.worktree}`
    lines.push(`${ctx}\t${line}\tphase=${phase}\tattempt=${attempt}\tnext=${next}\tchild=${child}\tapp=${app}\theartbeat=${heartbeat}`)
  }
  return lines
}

export function strike(repo, key, delta) {
  acquireStateLock(repo)
  try {
    const strikes = readStrikes(repo)
    const current = strikes[key] ?? 0
    strikes[key] = Math.max(current + Number(delta), 0)
    writeStrikes(repo, strikes)
  } finally {
    releaseStateLock(repo)
  }
}
