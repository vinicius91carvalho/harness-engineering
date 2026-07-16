/**
 * Worktree prepare + port allocation for Claim Lease.
 * Re-exported from claim-lease.mjs for backward compatibility.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  git,
  gitRoot,
  portInUse,
} from './git-repo.mjs'
import { integrationBranchName } from './integration-branch.mjs'
import { sanitizeKey } from './project-keys.mjs'

export const DEFAULT_BASE_PORT = Number(process.env.GEN_BASE_PORT || 5170)

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

function restoreFeatureListFromIntegration(repo) {
  const branch = integrationBranchName(repo)
  git(repo, ['restore', '-s', branch, '--', 'feature_list.json'], { allowFailure: true })
}

function worktreeRegistered(repo, checkout) {
  const result = git(repo, ['worktree', 'list', '--porcelain'], { allowFailure: true })
  if (result.status !== 0) return false
  return result.stdout.split('\n').some((line) => line === `worktree ${checkout}`)
}

export function removeWorktree(repo, checkout) {
  git(repo, ['worktree', 'remove', '--force', checkout], { allowFailure: true })
  git(repo, ['worktree', 'prune'], { allowFailure: true })
  // Unregistered leftover dirs (crash / partial remove) are not cleared by
  // `git worktree remove` and then block `worktree add` with "already exists".
  if (existsSync(checkout) && !worktreeRegistered(repo, checkout)) {
    rmSync(checkout, { recursive: true, force: true })
  }
}

function branchExists(repo, branch) {
  const result = git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true })
  return result.status === 0
}

function checkoutOnBranch(checkout, branch) {
  const result = git(checkout, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true })
  return result.status === 0 && result.stdout.trim() === branch
}

function addWorktree(repo, checkout, branch) {
  if (branchExists(repo, branch)) {
    git(repo, ['worktree', 'add', checkout, branch])
  } else {
    const result = git(repo, ['worktree', 'add', checkout, '-b', branch, integrationBranchName(repo)], { allowFailure: true })
    if (result.status !== 0) return 75
  }
  restoreFeatureListFromIntegration(repo)
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
      restoreFeatureListFromIntegration(repo)
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
