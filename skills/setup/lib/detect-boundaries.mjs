#!/usr/bin/env node
/**
 * Minimal monorepo project-boundary heuristics for setup/planner.
 * Looks for workspace manifests, Compose files, and an existing projects registry.
 * Does not invent product boundaries from dependency packages alone.
 * Default CLI mode is candidates-only; pass --confirm (or HARNESS_CONFIRM_BOUNDARIES=1)
 * to upsert detected projects into .harness/projects.json.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readProjectsRegistry, resolveGitRoot, upsertProject } from '../../generator/lib/project-topology.mjs'

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function readTextSafe(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

function addCandidate(map, { id, path, source, description }) {
  const key = path || '.'
  const prev = map.get(key)
  if (prev) {
    prev.sources = [...new Set([...(prev.sources || []), source])]
    if (description && !prev.description) prev.description = description
    return
  }
  map.set(path || '', {
    id,
    path: path || '',
    sources: [source],
    ...(description ? { description } : {}),
  })
}

function idFromPath(relPath) {
  if (!relPath) return 'root'
  return relPath.replace(/\\/g, '/').replace(/\/$/, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'root'
}

function hasProductBoundary(gitRoot, rel) {
  const dir = join(gitRoot, rel)
  return ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'project_specs.xml']
    .some((file) => existsSync(join(dir, file)))
}

function workspaceGlobs(pkg) {
  const workspaces = pkg?.workspaces
  if (Array.isArray(workspaces)) return workspaces
  if (workspaces && Array.isArray(workspaces.packages)) return workspaces.packages
  return []
}

function expandSimpleGlob(gitRoot, pattern) {
  // Support only `dir/*` and literal relative dirs — enough for common workspace layouts.
  const normalized = String(pattern || '').replace(/\/$/, '')
  if (!normalized || normalized.includes('**')) return []
  if (normalized.endsWith('/*')) {
    const parent = normalized.slice(0, -2)
    const abs = join(gitRoot, parent)
    return listDirs(abs).map((name) => join(parent, name).replace(/\\/g, '/'))
  }
  if (existsSync(join(gitRoot, normalized))) return [normalized]
  return []
}

function detectFromPackageWorkspaces(gitRoot, map) {
  const pkg = readJsonSafe(join(gitRoot, 'package.json'))
  for (const pattern of workspaceGlobs(pkg)) {
    for (const rel of expandSimpleGlob(gitRoot, pattern)) {
      if (!hasProductBoundary(gitRoot, rel)) continue
      addCandidate(map, { id: idFromPath(rel), path: rel, source: 'package.json#workspaces' })
    }
  }
}

function detectFromPnpmWorkspace(gitRoot, map) {
  const file = join(gitRoot, 'pnpm-workspace.yaml')
  if (!existsSync(file)) return
  const text = readTextSafe(file)
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*-\s*['"]?([^'"#]+)['"]?/)
    if (!match) continue
    const pattern = match[1].trim()
    for (const rel of expandSimpleGlob(gitRoot, pattern)) {
      if (!hasProductBoundary(gitRoot, rel)) continue
      addCandidate(map, { id: idFromPath(rel), path: rel, source: 'pnpm-workspace.yaml' })
    }
  }
}

function detectFromCompose(gitRoot, map) {
  for (const name of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    const file = join(gitRoot, name)
    if (!existsSync(file)) continue
    addCandidate(map, {
      id: 'root',
      path: '',
      source: name,
      description: `Compose stack (${name})`,
    })
    break
  }
}

function detectFromRegistry(gitRoot, map) {
  const registry = readProjectsRegistry(gitRoot)
  for (const project of registry?.projects || []) {
    if (!project?.id) continue
    addCandidate(map, {
      id: project.id,
      path: String(project.path || '').replace(/\/$/, ''),
      source: '.harness/projects.json',
      description: project.description,
    })
  }
}

function detectAppsDirs(gitRoot, map) {
  for (const top of ['apps', 'packages', 'services']) {
    const abs = join(gitRoot, top)
    if (!existsSync(abs)) continue
    for (const name of listDirs(abs)) {
      const rel = `${top}/${name}`
      if (!hasProductBoundary(gitRoot, rel)) continue
      addCandidate(map, { id: idFromPath(rel), path: rel, source: `${top}/` })
    }
  }
}

/**
 * @param {string} startDir
 * @returns {{ gitRoot: string, projects: Array<{ id: string, path: string, sources: string[], description?: string }> }}
 */
export function detectProjectBoundaries(startDir = process.cwd()) {
  const start = resolve(startDir)
  const gitRoot = resolveGitRoot(start)
  const map = new Map()
  detectFromRegistry(gitRoot, map)
  detectFromPackageWorkspaces(gitRoot, map)
  detectFromPnpmWorkspace(gitRoot, map)
  detectFromCompose(gitRoot, map)
  detectAppsDirs(gitRoot, map)
  const projects = [...map.values()].sort((a, b) => String(a.path).localeCompare(String(b.path)))
  return { gitRoot, projects }
}

/**
 * Upsert detected candidates into `.harness/projects.json`.
 * Requires an explicit confirm gate at the CLI/skill layer.
 *
 * @returns {Array<{ id: string, path: string, created: boolean, file: string }>}
 */
export function writeDetectedProjects(gitRoot, projects) {
  const written = []
  for (const project of projects) {
    const result = upsertProject(gitRoot, {
      id: project.id,
      path: project.path,
      description: project.description,
    })
    written.push({ ...result, created: result.created })
  }
  return written
}

function parseArgv(argv) {
  const args = [...argv]
  let confirm = false
  const positional = []
  for (const arg of args) {
    if (arg === '--confirm') {
      confirm = true
      continue
    }
    positional.push(arg)
  }
  if (!confirm && process.env.HARNESS_CONFIRM_BOUNDARIES === '1') confirm = true
  return { confirm, dir: positional[0] || process.cwd() }
}

function main() {
  const { confirm, dir } = parseArgv(process.argv.slice(2))
  const result = detectProjectBoundaries(dir)
  const output = {
    ...result,
    mutated: false,
    confirm_required: !confirm,
    note: confirm
      ? 'Wrote detected projects to .harness/projects.json'
      : 'Candidates only. Pass --confirm or set HARNESS_CONFIRM_BOUNDARIES=1 to write .harness/projects.json',
  }
  if (confirm) {
    output.written = writeDetectedProjects(result.gitRoot, result.projects)
    output.mutated = output.written.length > 0
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
