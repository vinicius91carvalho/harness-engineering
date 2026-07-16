import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

export const DEFAULT_INTEGRATION_BRANCH = 'main'

function git(repo, args) {
  return spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
}

function gitRoot(repo) {
  const result = git(repo, ['rev-parse', '--show-toplevel'])
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'git failed').trim())
  return result.stdout.trim()
}

function gitOutput(repo, args) {
  const result = git(repo, args)
  if (result.status !== 0) return null
  return (result.stdout || '').trim()
}

/** Integration target for merges, Goal Review, and queue sync. Override per repo or run. */
export function integrationBranchName(repo, { env = process.env } = {}) {
  const fromEnv = env.HARNESS_INTEGRATION_BRANCH?.trim()
  if (fromEnv) return fromEnv
  try {
    const root = gitRoot(repo)
    const file = join(root, '.harness', 'integration-branch')
    if (existsSync(file)) {
      const line = readFileSync(file, 'utf8').split('\n').map((part) => part.trim()).find(Boolean)
      if (line) return line
    }
  } catch {}
  return DEFAULT_INTEGRATION_BRANCH
}

export function integrationBranchRef(repo, options) {
  return `refs/heads/${integrationBranchName(repo, options)}`
}

export function planBranchSlug(projectName) {
  return String(projectName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'project'
}

/**
 * Pin `.harness/integration-branch` to `plan/<slug>` when absent.
 * Never overwrites an existing pin. Creates the branch at HEAD when missing.
 * No-op when HEAD is not available (empty repo / not a git checkout).
 *
 * @returns {{ pinned: boolean, branch?: string, file?: string } | null}
 */
export function pinIntegrationBranchIfAbsent(repo, projectName) {
  if (gitOutput(repo, ['rev-parse', '--verify', '--quiet', 'HEAD']) == null) return null
  const root = gitRoot(repo)
  const pinFile = join(root, '.harness', 'integration-branch')
  if (existsSync(pinFile)) return { pinned: false, file: pinFile }
  const branch = `plan/${planBranchSlug(projectName)}`
  if (gitOutput(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) == null) {
    git(repo, ['branch', branch])
  }
  mkdirSync(dirname(pinFile), { recursive: true })
  writeFileSync(pinFile, `${branch}\n`, 'utf8')
  return { pinned: true, branch, file: pinFile }
}

/**
 * Resolve the on-disk checkout for the integration branch without taking the merge lock.
 * Prefers an existing worktree on that branch; otherwise the primary Git root when HEAD
 * matches; otherwise `${gitRoot}-wt-integration` (created if missing).
 * Nested projects return the prefix path inside that checkout.
 */
export function resolveIntegrationCheckout(repo) {
  const root = gitRoot(repo)
  const prefix = (gitOutput(repo, ['rev-parse', '--show-prefix']) || '').replace(/\/$/, '')
  const branch = integrationBranchName(repo)
  const ref = `refs/heads/${branch}`
  const list = git(repo, ['worktree', 'list', '--porcelain'])
  let integ = null
  let current = null
  if (list.status === 0) {
    for (const line of (list.stdout || '').split('\n')) {
      if (line.startsWith('worktree ')) current = line.slice('worktree '.length)
      if (line === `branch ${ref}` && current) {
        integ = current
        break
      }
    }
  }
  if (!integ) {
    const head = gitOutput(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (head === branch) integ = root
  }
  if (!integ) {
    integ = `${root.replace(/\/$/, '')}-wt-integration`
    if (!existsSync(integ)) {
      const add = git(repo, ['worktree', 'add', integ, branch])
      if (add.status !== 0) {
        throw new Error((add.stderr || add.stdout || `failed to add integration worktree for ${branch}`).trim())
      }
    }
  }
  return prefix ? join(integ.replace(/\/$/, ''), prefix) : integ
}
