import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  sanitizeKey,
  projectIdFromPrefix,
  claimKey,
  runStateFile,
  resultFileFromRunState,
  scopeClaims,
} from './project-keys.mjs'
import { integrationBranchName, integrationBranchRef, DEFAULT_INTEGRATION_BRANCH } from './integration-branch.mjs'

export {
  sanitizeKey,
  projectIdFromPrefix,
  claimKey,
  runStateFile,
  resultFileFromRunState,
  scopeClaims,
  integrationBranchName,
  integrationBranchRef,
  DEFAULT_INTEGRATION_BRANCH,
}

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  if (result.status !== 0) return ''
  return (result.stdout || '').trim()
}

export function resolveGitRoot(repo) {
  return git(repo, ['rev-parse', '--show-toplevel']) || repo
}

export function resolveCommonGitDir(repo) {
  const common = git(repo, ['rev-parse', '--git-common-dir'])
  if (!common) return join(resolveGitRoot(repo), '.git')
  return common.startsWith('/') ? common : join(repo, common)
}

export function resolveProjectPrefix(repo) {
  return git(repo, ['rev-parse', '--show-prefix'])
}

/** Read `.harness/projects.json` at Git root when present. */
export function readProjectsRegistry(gitRoot) {
  const file = join(gitRoot, '.harness', 'projects.json')
  if (!existsSync(file)) return null
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (!data || typeof data !== 'object') return null
    return data
  } catch {
    throw new Error(`malformed projects registry: ${file}`)
  }
}

/**
 * Resolve project topology for a working directory.
 * @returns {{
 *   gitRoot: string,
 *   commonGit: string,
 *   projectPrefix: string,
 *   projectId: string,
 *   projectPath: string,
 *   integrationBranch: string,
 *   controlRoot: string,
 *   runsDir: string,
 *   registry: object|null,
 * }}
 */
export function resolveProjectTopology(repo, { env = process.env } = {}) {
  const gitRoot = resolveGitRoot(repo)
  const commonGit = resolveCommonGitDir(repo)
  const projectPrefix = resolveProjectPrefix(repo)
  const projectId = projectIdFromPrefix(projectPrefix)
  const projectPath = join(gitRoot, projectPrefix)
  const integrationBranch = integrationBranchName(repo, { env })
  const trimmedPrefix = String(projectPrefix || '').replace(/\/$/, '')
  const controlRoot = trimmedPrefix
    ? join(commonGit, 'harness-control', sanitizeKey(projectId))
    : join(commonGit, 'harness-control')
  const runsDir = join(commonGit, 'harness-runs')
  const registry = readProjectsRegistry(gitRoot)
  return {
    gitRoot,
    commonGit,
    projectPrefix,
    projectId,
    projectPath,
    integrationBranch,
    controlRoot,
    runsDir,
    registry,
  }
}

export function runStatePath(topology, context) {
  return runStateFile(topology.commonGit, topology.projectPrefix, context)
}

export function evidenceDir(topology, context) {
  return join(topology.commonGit, 'harness-evidence', sanitizeKey(topology.projectId), sanitizeKey(context))
}
