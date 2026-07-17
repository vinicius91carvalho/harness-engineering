/**
 * Merge lock acquire/do/release/holder helpers for Claim Lease.
 * Re-exported from claim-lease.mjs for backward compatibility.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hostname } from 'node:os'
import {
  git,
  gitRoot,
  processAlive,
} from './git-repo.mjs'
import { integrationBranchName, integrationBranchRef } from './integration-branch.mjs'
import { sanitizeKey } from './project-keys.mjs'
import { readClaims, repoPaths } from './claim-lease.mjs'

function currentHost() {
  try {
    return hostname()
  } catch {
    return 'unknown'
  }
}

export function stealDeadMergeLock(lockDir) {
  if (!existsSync(lockDir)) return false
  const ownerHost = readMergeLockFile(join(lockDir, 'host'))
  const ownerPid = readMergeLockFile(join(lockDir, 'owner'))
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

function mergeBusySignal() {
  process.stdout.write('BUSY\n')
}

function readMergeLockFile(path) {
  try {
    if (!existsSync(path)) return ''
    return readFileSync(path, 'utf8').trim()
  } catch (error) {
    // Race: lock dir/file can vanish between existsSync and read (ENOENT).
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return ''
    throw error
  }
}

function readMergeLockHolder(mergeLockDir) {
  return {
    owner: readMergeLockFile(join(mergeLockDir, 'owner')),
    host: readMergeLockFile(join(mergeLockDir, 'host')),
  }
}

/** Peek at the current merge-lock holder without trying to acquire. */
export function mergeLockHolder(repo) {
  const { mergeLockDir } = repoPaths(repo)
  if (!existsSync(mergeLockDir)) return { busy: false, owner: '', host: '' }
  const holder = readMergeLockHolder(mergeLockDir)
  return { busy: Boolean(holder.owner), ...holder }
}

export function mergeAcquire(repo, session) {
  const { mergeLockDir, repo: repoPath, prefix } = repoPaths(repo)
  mkdirSync(dirname(mergeLockDir), { recursive: true })
  const host = currentHost()
  try {
    mkdirSync(mergeLockDir)
  } catch {
    if (!stealDeadMergeLock(mergeLockDir)) {
      mergeBusySignal()
      return { busy: true, ...readMergeLockHolder(mergeLockDir) }
    }
    try {
      mkdirSync(mergeLockDir)
    } catch {
      mergeBusySignal()
      return { busy: true, ...readMergeLockHolder(mergeLockDir) }
    }
  }
  writeFileSync(join(mergeLockDir, 'owner'), `${session ?? process.pid}\n`)
  writeFileSync(join(mergeLockDir, 'host'), `${host}\n`)

  const integrationRef = integrationBranchRef(repoPath)
  const listResult = git(repoPath, ['worktree', 'list', '--porcelain'])
  let integ = null
  let current = null
  for (const line of listResult.stdout.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length)
    if (line === `branch ${integrationRef}` && current) {
      integ = current
      break
    }
  }

  if (!integ) {
    integ = `${gitRoot(repoPath).replace(/\/$/, '')}-wt-integration`
    if (!existsSync(integ)) {
      git(repoPath, ['worktree', 'add', integ, integrationBranchName(repoPath)])
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
  const owner = readMergeLockFile(join(mergeLockDir, 'owner'))
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
