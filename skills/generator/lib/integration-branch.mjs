import { existsSync, readFileSync } from 'node:fs'
import { join, isAbsolute, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

export const DEFAULT_INTEGRATION_BRANCH = 'main'

function gitRoot(repo) {
  const result = spawnSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'git failed').trim())
  return result.stdout.trim()
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

export function integrationBranchSpec(repo, relativePath = 'feature_list.json') {
  const prefix = spawnSync('git', ['-C', repo, 'rev-parse', '--show-prefix'], { encoding: 'utf8' }).stdout.trim()
  const branch = integrationBranchName(repo)
  return prefix ? `${branch}:${prefix}${relativePath}` : `${branch}:${relativePath}`
}
