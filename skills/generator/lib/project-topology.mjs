import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
 * Resolve the project root (the directory owning project_specs.xml) for a
 * working directory: nearest spec on the walk up to the Git root wins, then
 * the projects registry disambiguates.
 */
export function resolveProjectRoot(startDir) {
  const start = realpathSync(resolve(startDir))
  const gitRoot = resolveGitRoot(start)
  let dir = start
  for (;;) {
    if (existsSync(join(dir, 'project_specs.xml'))) return dir
    if (dir === gitRoot || dirname(dir) === dir) break
    dir = dirname(dir)
  }
  const registry = readProjectsRegistry(gitRoot)
  const candidates = (registry?.projects || []).filter(
    (project) => project?.path && existsSync(join(gitRoot, project.path, 'project_specs.xml')),
  )
  if (candidates.length === 1) return resolve(gitRoot, candidates[0].path)
  if (candidates.length > 1) {
    const listed = candidates.map((project) => `${project.id} (${project.path})`).join(', ')
    throw new Error(`multiple registered projects contain project_specs.xml: ${listed}; pass the project directory explicitly`)
  }
  throw new Error(`no project_specs.xml found from ${start} up to ${gitRoot}; run /planner or /harness:setup first, or pass the project directory explicitly`)
}

function fileMtimeMs(file) {
  try { return statSync(file).mtimeMs } catch { return 0 }
}

function topologyCacheStamp(gitRoot, envBranch) {
  return [
    envBranch || '',
    fileMtimeMs(join(gitRoot, '.harness', 'projects.json')),
    fileMtimeMs(join(gitRoot, '.harness', 'integration-branch')),
  ].join(':')
}

const topologyCache = new Map()

/**
 * Resolve project topology for a working directory.
 * Cached per realpath + registry/branch stamp for the process lifetime.
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
export function resolveProjectTopology(repo, { env = process.env, bustCache = false } = {}) {
  let abs
  try { abs = realpathSync(resolve(repo)) } catch { abs = resolve(repo) }
  const envBranch = env.HARNESS_INTEGRATION_BRANCH?.trim() || ''
  const cacheKey = abs
  if (!bustCache) {
    const hit = topologyCache.get(cacheKey)
    if (hit) {
      const stamp = topologyCacheStamp(hit.gitRoot, envBranch)
      if (hit.stamp === stamp && hit.envBranch === envBranch) return hit.value
    }
  }
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
  const value = {
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
  topologyCache.set(cacheKey, {
    value,
    gitRoot,
    envBranch,
    stamp: topologyCacheStamp(gitRoot, envBranch),
  })
  return value
}

export function runStatePath(topology, context) {
  return runStateFile(topology.commonGit, topology.projectPrefix, context)
}

export function evidenceDir(topology, context) {
  return join(topology.commonGit, 'harness-evidence', sanitizeKey(topology.projectId), sanitizeKey(context))
}
