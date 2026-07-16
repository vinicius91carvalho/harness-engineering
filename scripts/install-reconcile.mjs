#!/usr/bin/env node
/**
 * Catalog-driven install reconciliation: generate/validate marketplaces, project bundles, receipts.
 *
 * Usage:
 *   node scripts/install-reconcile.mjs validate
 *   node scripts/install-reconcile.mjs generate-marketplaces
 *   node scripts/install-reconcile.mjs sync-agent-docs
 *   node scripts/install-reconcile.mjs generate
 *   node scripts/install-reconcile.mjs optional-ids
 *   node scripts/install-reconcile.mjs hosts <moduleId>
 *   node scripts/install-reconcile.mjs scopes <moduleId>
 *   node scripts/install-reconcile.mjs skills-add-args <moduleId>
 *   node scripts/install-reconcile.mjs describe <moduleId>
 *   node scripts/install-reconcile.mjs resolve-install-bases <scope> [projectDir]
 *   node scripts/install-reconcile.mjs project-bundle <moduleId> <destDir> [--dry-run]
 *   node scripts/install-reconcile.mjs project-harness-opencode <repoDir> <opencodeBase> [--dry-run]
 *   node scripts/install-reconcile.mjs project-agent <moduleId> <repoDir> <destDir> [--dry-run]
 *   node scripts/install-reconcile.mjs record-receipt <receiptDir> <moduleId> <json>
 */
import { readFile, writeFile, mkdir, cp, readdir, rm, stat, symlink } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const catalogPath = join(root, 'config/installable-catalog.json')

/** Match CLI entry even when argv uses /var/... and import.meta.url uses /private/var/... on macOS. */
function canonicalPath(pathLike) {
  const abs = resolve(pathLike)
  if (!existsSync(abs)) return abs
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}

function isCliEntry(argvPath, modulePath) {
  if (!argvPath) return false
  return canonicalPath(argvPath) === canonicalPath(modulePath)
}

const MARKETPLACE_HOSTS = {
  claude: {
    file: '.claude-plugin/marketplace.json',
    plugins: ['harness'],
  },
  codex: { file: '.agents/plugins/marketplace.json', plugins: ['harness', 'skill-creator'] },
  cursor: { file: '.cursor-plugin/marketplace.json', plugins: ['harness', 'skill-creator'] },
}

const FORBIDDEN_MARKETPLACE = new Set([
  'codebase-memory-mcp', 'context7', 'playwright', 'crawl4ai',
  'lavish-axi', 'hallmark', 'no-mistakes', 'treehouse', 'firstmate', 'ponytail',
  'status-line', 'shared-config', 'mcp-servers',
])

export async function loadCatalog(repo = root) {
  const path = join(repo, 'config/installable-catalog.json')
  return JSON.parse(await readFile(path, 'utf8'))
}

export function moduleById(catalog, id) {
  const mod = catalog.modules.find((row) => row.id === id)
  if (!mod) throw new Error(`unknown module: ${id}`)
  return mod
}

export function optionalModuleIds(catalog) {
  return catalog.modules.filter((row) => row.optional && row.id !== 'harness').map((row) => row.id)
}

export function hostsForModule(catalog, id) {
  return moduleById(catalog, id).hosts || []
}

export function scopesForModule(catalog, id) {
  const scopes = moduleById(catalog, id).scopes
  return Array.isArray(scopes) && scopes.length ? scopes : ['user', 'project']
}

export function descriptionForModule(catalog, id) {
  return moduleById(catalog, id).description || ''
}

/** Resolve catalog acquisition.skills into argv fragments for `npx skills add`. */
export function skillsAddArgs(catalog, id) {
  const mod = moduleById(catalog, id)
  const skills = mod.acquisition?.skills
  if (!skills?.repo || !skills?.name) {
    throw new Error(`module ${id} has no acquisition.skills.{repo,name}`)
  }
  return {
    repo: skills.repo,
    skill: skills.name,
    globalWhenUserScope: skills.globalWhenUserScope !== false,
  }
}

function canonicalProjectDir(projectDir) {
  const abs = resolve(projectDir)
  if (!existsSync(abs)) return abs
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}

export function resolveInstallBases(scope, projectDir = '', home = process.env.HOME || '', xdgConfigHome = process.env.XDG_CONFIG_HOME || '') {
  if (scope !== 'user' && scope !== 'project' && scope !== 'local') {
    throw new Error(`invalid scope: ${scope}`)
  }
  const project = scope === 'project'
  if (project && !projectDir) throw new Error('project scope requires projectDir')
  const configHome = xdgConfigHome || join(home, '.config')
  const projectRoot = project ? canonicalProjectDir(projectDir) : ''
  return {
    scope,
    projectDir: projectRoot,
    opencode: project ? join(projectRoot, '.opencode') : join(configHome, 'opencode'),
    agentsSkills: project ? join(projectRoot, '.agents', 'skills') : join(home, '.agents', 'skills'),
    claudeSkills: project ? join(projectRoot, '.claude', 'skills') : join(home, '.claude', 'skills'),
    cursorSkills: project ? join(projectRoot, '.cursor', 'skills') : join(home, '.cursor', 'skills'),
    cursorPluginsLocal: project
      ? join(projectRoot, '.cursor', 'plugins', 'local')
      : join(home, '.cursor', 'plugins', 'local'),
    cursorMcp: project ? join(projectRoot, '.cursor', 'mcp.json') : join(home, '.cursor', 'mcp.json'),
  }
}

function expectedSource(mod, host) {
  if (mod.id === 'harness') {
    if (host === 'codex') {
      return { kind: 'local', path: './' }
    }
    return { kind: 'relative', path: './' }
  }
  if (mod.kind === 'optional-bundle') {
    return { kind: 'relative', path: `./${mod.sourceRoot}` }
  }
  if (mod.kind === 'external' && mod.acquisition?.github) {
    return { kind: 'github', repo: mod.acquisition.github }
  }
  return null
}

function pluginSourceMatches(entry, expected) {
  if (!expected) return false
  const source = entry.source
  if (expected.kind === 'relative') {
    if (typeof source === 'string') return source.replace(/\/$/, '') === expected.path.replace(/\/$/, '')
    if (source?.path) return source.path.replace(/\/$/, '') === expected.path.replace(/\/$/, '')
    return false
  }
  if (expected.kind === 'local') {
    return source?.source === 'local' && source.path.replace(/\/$/, '') === expected.path.replace(/\/$/, '')
  }
  if (expected.kind === 'github') {
    const repo = typeof source === 'object' ? source.repo : null
    return repo === expected.repo
  }
  return false
}

function withTrailingSlash(path) {
  return path.endsWith('/') ? path : `${path}/`
}

function marketplacePluginEntry(mod, host) {
  const expected = expectedSource(mod, host)
  if (!expected) {
    throw new Error(`cannot project marketplace source for ${mod.id} on ${host}`)
  }

  if (host === 'codex') {
    let source
    if (expected.kind === 'local') {
      source = { source: 'local', path: expected.path }
    } else if (expected.kind === 'relative') {
      source = { source: 'local', path: withTrailingSlash(expected.path) }
    } else if (expected.kind === 'github') {
      source = { source: 'github', repo: expected.repo }
    } else {
      throw new Error(`unsupported marketplace source kind ${expected.kind} for ${mod.id} on ${host}`)
    }
    return {
      name: mod.id,
      source,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Productivity',
    }
  }

  if (expected.kind === 'relative' || expected.kind === 'local') {
    return { name: mod.id, source: expected.path }
  }
  if (expected.kind === 'github') {
    return { name: mod.id, source: { source: 'github', repo: expected.repo } }
  }
  throw new Error(`unsupported marketplace source kind ${expected.kind} for ${mod.id} on ${host}`)
}

export function buildMarketplaceDocument(catalog, host) {
  const rule = MARKETPLACE_HOSTS[host]
  if (!rule) throw new Error(`unknown marketplace host: ${host}`)
  const byId = new Map(catalog.modules.map((row) => [row.id, row]))
  const plugins = rule.plugins.map((id) => {
    const mod = byId.get(id)
    if (!mod) throw new Error(`catalog missing module ${id} required by ${host} marketplace`)
    return marketplacePluginEntry(mod, host)
  })

  if (host === 'codex') {
    return {
      name: 'harness-engineering',
      interface: { displayName: 'Harness Engineering' },
      plugins,
    }
  }

  return {
    name: 'harness-engineering',
    owner: { name: 'Vinicius Carvalho' },
    plugins,
  }
}

function serializeMarketplace(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`
}

export async function generateMarketplaces(repo = root) {
  const catalog = await loadCatalog(repo)
  const written = []
  for (const host of Object.keys(MARKETPLACE_HOSTS)) {
    const rule = MARKETPLACE_HOSTS[host]
    const doc = buildMarketplaceDocument(catalog, host)
    const file = join(repo, rule.file)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, serializeMarketplace(doc))
    written.push(rule.file)
  }
  return written
}

const AGENTS_CANONICAL_NOTE =
  '> **Canonical agent guidance.** `AGENTS.md` is the source of truth. `CLAUDE.md` is generated by `node scripts/install-reconcile.mjs sync-agent-docs` - do not hand-edit `CLAUDE.md`.'

const CLAUDE_GENERATED_NOTE =
  '> **Generated from `AGENTS.md`.** Do not hand-edit. Regenerate with `node scripts/install-reconcile.mjs sync-agent-docs`.'

export function projectClaudeFromAgents(agentsText) {
  let text = agentsText
  if (text.startsWith('# AGENTS.md\n')) {
    text = `# CLAUDE.md\n${text.slice('# AGENTS.md\n'.length)}`
  } else {
    text = text.replace(/^# AGENTS\.md\s*$/m, '# CLAUDE.md')
  }
  if (text.includes(AGENTS_CANONICAL_NOTE)) {
    text = text.replace(AGENTS_CANONICAL_NOTE, CLAUDE_GENERATED_NOTE)
  } else if (text.includes(CLAUDE_GENERATED_NOTE)) {
    // already projected
  } else {
    // Insert generated note after the H1 when AGENTS lacks the canonical banner.
    text = text.replace(/^# CLAUDE\.md\n/, `# CLAUDE.md\n\n${CLAUDE_GENERATED_NOTE}\n`)
  }
  return text
}

export async function syncAgentDocs(repo = root) {
  const agentsPath = join(repo, 'AGENTS.md')
  const claudePath = join(repo, 'CLAUDE.md')
  if (!existsSync(agentsPath)) throw new Error('missing AGENTS.md')
  const agents = await readFile(agentsPath, 'utf8')
  const claude = projectClaudeFromAgents(agents)
  await writeFile(claudePath, claude)
  return { agents: 'AGENTS.md', claude: 'CLAUDE.md' }
}

export async function validateAgentDocs(repo = root) {
  const errors = []
  const agentsPath = join(repo, 'AGENTS.md')
  const claudePath = join(repo, 'CLAUDE.md')
  if (!existsSync(agentsPath)) {
    errors.push('missing AGENTS.md')
    return errors
  }
  if (!existsSync(claudePath)) {
    errors.push('missing CLAUDE.md')
    return errors
  }
  const agents = await readFile(agentsPath, 'utf8')
  const claude = await readFile(claudePath, 'utf8')
  const expected = projectClaudeFromAgents(agents)
  if (claude !== expected) {
    errors.push('CLAUDE.md does not match projection from AGENTS.md; run sync-agent-docs')
  }
  if (!agents.includes(AGENTS_CANONICAL_NOTE) && !agents.includes('Canonical agent guidance')) {
    errors.push('AGENTS.md must declare that it is canonical and CLAUDE.md is generated')
  }
  return errors
}

export async function validateMarketplaces(repo = root) {
  const catalog = await loadCatalog(repo)
  const byId = new Map(catalog.modules.map((row) => [row.id, row]))
  const errors = []

  for (const [host, rule] of Object.entries(MARKETPLACE_HOSTS)) {
    const file = join(repo, rule.file)
    if (!existsSync(file)) {
      errors.push(`missing marketplace file: ${rule.file}`)
      continue
    }
    const onDisk = await readFile(file, 'utf8')
    let expectedDoc
    try {
      expectedDoc = buildMarketplaceDocument(catalog, host)
    } catch (err) {
      errors.push(`${rule.file}: ${err.message || err}`)
      continue
    }
    const expectedText = serializeMarketplace(expectedDoc)
    if (onDisk !== expectedText) {
      errors.push(`${rule.file} does not match catalog generation; run generate-marketplaces`)
    }

    const marketplace = JSON.parse(onDisk)
    const plugins = marketplace.plugins || []
    const names = plugins.map((row) => row.name)

    for (const forbidden of FORBIDDEN_MARKETPLACE) {
      if (names.includes(forbidden)) {
        errors.push(`${rule.file} must not list forbidden module ${forbidden}`)
      }
    }

    for (const expectedName of rule.plugins) {
      if (!names.includes(expectedName)) {
        errors.push(`${rule.file} missing expected plugin ${expectedName}`)
        continue
      }
      const mod = byId.get(expectedName)
      if (!mod) {
        errors.push(`catalog missing module ${expectedName}`)
        continue
      }
      const entry = plugins.find((row) => row.name === expectedName)
      const expected = expectedSource(mod, host)
      if (!pluginSourceMatches(entry, expected)) {
        errors.push(`${rule.file} plugin ${expectedName} source does not match catalog`)
      }
    }

    for (const entry of plugins) {
      if (!rule.plugins.includes(entry.name)) {
        errors.push(`${rule.file} has unexpected plugin ${entry.name}`)
      }
    }
  }

  for (const mod of catalog.modules) {
    if (mod.kind === 'optional-bundle' && mod.sourceRoot) {
      const source = join(repo, mod.sourceRoot)
      if (!existsSync(source)) {
        errors.push(`missing optional bundle source root: ${mod.sourceRoot}`)
      }
    }
  }

  const optional = optionalModuleIds(catalog).sort().join(' ')
  const fallback = 'crawl4ai hallmark no-mistakes playwright shared-config skill-creator status-line treehouse'
  const expectedOptional = fallback.split(' ').sort().join(' ')
  if (optional !== expectedOptional) {
    errors.push(`optional module ids drifted from installer fallback (${optional} vs ${expectedOptional})`)
  }

  return errors
}

export async function validate(repo = root) {
  return [
    ...(await validateMarketplaces(repo)),
    ...(await validateAgentDocs(repo)),
  ]
}

async function listFiles(dir, base = dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await listFiles(full, base))
    else out.push(relative(base, full))
  }
  return out
}

async function readOwned(marker) {
  if (!existsSync(marker)) return []
  try {
    const data = JSON.parse(await readFile(marker, 'utf8'))
    return data.files || []
  } catch {
    return []
  }
}

async function writeOwned(marker, payload) {
  await writeFile(marker, `${JSON.stringify(payload, null, 2)}\n`)
}

async function syncOwnedFiles(source, dest, files, marker, meta) {
  const previous = await readOwned(marker)
  await mkdir(dest, { recursive: true })
  for (const file of files) {
    const to = join(dest, file)
    await mkdir(dirname(to), { recursive: true })
    await cp(join(source, file), to)
  }
  for (const stale of previous.filter((f) => !files.includes(f))) {
    try { await rm(join(dest, stale), { force: true }) } catch {}
  }
  await writeOwned(marker, { ...meta, files })
}

export async function projectBundle(repo, moduleId, dest, { dryRun = false } = {}) {
  const catalog = await loadCatalog(repo)
  const mod = moduleById(catalog, moduleId)
  if (!mod.sourceRoot || mod.sourceRoot === '.') {
    throw new Error(`module ${moduleId} is not a file bundle`)
  }
  const source = join(repo, mod.sourceRoot)
  if (!existsSync(source)) throw new Error(`missing source root: ${source}`)
  const files = await listFiles(source)
  const marker = join(dest, '.harness-owned.json')
  const previous = await readOwned(marker)

  if (dryRun) {
    return { moduleId, source, dest, files, remove: previous.filter((f) => !files.includes(f)) }
  }

  await syncOwnedFiles(source, dest, files, marker, { moduleId, files })
  return { projected: moduleId, files: files.length }
}

export async function projectHarnessOpenCode(repo, opencodeBase, { dryRun = false } = {}) {
  const prefix = 'harness'
  const planned = []
  const add = (kind, from, to) => planned.push({ kind, from, to })

  const skillsDir = join(repo, 'skills')
  if (existsSync(skillsDir)) {
    for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const from = join(skillsDir, entry.name)
      add('tree', from, join(opencodeBase, 'skills', `${prefix}-${entry.name}`))
      const skillMd = join(from, 'SKILL.md')
      if (existsSync(skillMd)) {
        add('file', skillMd, join(opencodeBase, 'commands', `${prefix}-${entry.name}.md`))
      }
    }
  }
  const agentsDir = join(repo, 'agents')
  if (existsSync(agentsDir)) {
    for (const entry of await readdir(agentsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      add('file', join(agentsDir, entry.name), join(opencodeBase, 'agents', `${prefix}-${entry.name}`))
    }
  }
  const commandsDir = join(repo, 'commands')
  if (existsSync(commandsDir)) {
    for (const entry of await readdir(commandsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      add('file', join(commandsDir, entry.name), join(opencodeBase, 'commands', `${prefix}-${entry.name}`))
    }
  }

  const marker = join(opencodeBase, '.harness-owned-harness.json')
  const previous = await readOwned(marker)
  const current = planned.map((row) => relative(opencodeBase, row.to))

  if (dryRun) {
    return { moduleId: 'harness', planned, remove: previous.filter((f) => !current.includes(f)) }
  }

  for (const row of planned) {
    await mkdir(dirname(row.to), { recursive: true })
    const info = await stat(row.from)
    if (info.isDirectory()) await cp(row.from, row.to, { recursive: true })
    else await cp(row.from, row.to)
  }
  for (const skill of ['generator', 'supervisor']) {
    const namespaced = join(opencodeBase, 'skills', `${prefix}-${skill}`)
    const alias = join(opencodeBase, 'skills', skill)
    if (existsSync(namespaced)) {
      try { await rm(alias, { force: true, recursive: true }) } catch {}
      await symlink(`${prefix}-${skill}`, alias)
    }
  }
  for (const stale of previous.filter((f) => !current.includes(f))) {
    try { await rm(join(opencodeBase, stale), { force: true, recursive: true }) } catch {}
  }
  await writeOwned(marker, { moduleId: 'harness', files: current })
  return { projected: 'harness', files: current.length }
}

const HARNESS_AGENT_TOP_LEVEL = [
  'agents',
  'commands',
  'assets',
  '.mcp.json',
  'AGENTS.md',
  '.harness-owned.json',
]

async function listHarnessSkillNames(repo) {
  const skillsDir = join(repo, 'skills')
  if (!existsSync(skillsDir)) return []
  const names = []
  for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
    if (entry.isDirectory()) names.push(entry.name)
  }
  return names
}

async function cleanOptionalBundleAgentDest(dest, moduleId, harnessSkillNames, { dryRun = false } = {}) {
  const remove = []
  for (const rel of HARNESS_AGENT_TOP_LEVEL) {
    remove.push(join(dest, rel))
  }

  const skillsDir = join(dest, 'skills')
  if (existsSync(skillsDir)) {
    for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name !== moduleId || harnessSkillNames.includes(entry.name)) {
        remove.push(join(skillsDir, entry.name))
      }
    }
  }

  const manifestPath = join(dest, '.cursor-plugin/plugin.json')
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (manifest.name !== moduleId) remove.push(join(dest, '.cursor-plugin'))
    } catch {
      remove.push(join(dest, '.cursor-plugin'))
    }
  }

  if (dryRun) return remove

  for (const path of remove) {
    try { await rm(path, { force: true, recursive: true }) } catch {}
  }
}

export async function projectAgent(repo, moduleId, dest, { dryRun = false } = {}) {
  const catalog = await loadCatalog(repo)
  const mod = moduleById(catalog, moduleId)

  if (moduleId === 'harness' && mod.id === 'harness') {
    return projectHarnessAgent(repo, dest, { dryRun })
  }

  if (mod.kind === 'optional-bundle') {
    const harnessSkillNames = await listHarnessSkillNames(repo)
    const remove = await cleanOptionalBundleAgentDest(dest, moduleId, harnessSkillNames, { dryRun: true })
    if (dryRun) {
      const bundle = await projectBundle(repo, moduleId, join(dest, 'skills', moduleId), { dryRun: true })
      return { moduleId, kind: 'optional-bundle', remove, bundle }
    }

    await cleanOptionalBundleAgentDest(dest, moduleId, harnessSkillNames, { dryRun: false })
    await mkdir(join(dest, '.cursor-plugin'), { recursive: true })
    const manifest = {
      name: moduleId,
      description: mod.description || moduleId,
      version: '0.0.0',
      skills: './skills/',
    }
    await writeFile(join(dest, '.cursor-plugin/plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    const skillDest = join(dest, 'skills', moduleId)
    const bundle = await projectBundle(repo, moduleId, skillDest, { dryRun: false })
    return { projected: moduleId, kind: 'optional-bundle', files: bundle.files }
  }

  throw new Error(`unsupported agent module ${moduleId} (${mod.kind}); harness install does not project this module for Cursor Agent`)
}

async function projectHarnessAgent(repo, dest, { dryRun = false } = {}) {

  const planned = []
  const add = (from, to) => planned.push({ from, to: join(dest, to) })
  add(join(repo, '.cursor-plugin/plugin.json'), '.cursor-plugin/plugin.json')
  if (existsSync(join(repo, 'assets/banner.svg'))) add(join(repo, 'assets/banner.svg'), 'assets/banner.svg')
  if (existsSync(join(repo, '.mcp.json'))) add(join(repo, '.mcp.json'), '.mcp.json')
  if (existsSync(join(repo, 'AGENTS.md'))) add(join(repo, 'AGENTS.md'), 'AGENTS.md')

  const skillsDir = join(repo, 'skills')
  if (existsSync(skillsDir)) {
    for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      add(join(skillsDir, entry.name), `skills/${entry.name}`)
      const skillMd = join(skillsDir, entry.name, 'SKILL.md')
      if (existsSync(skillMd)) add(skillMd, `commands/harness-${entry.name}.md`)
    }
  }
  const agentsDir = join(repo, 'agents')
  if (existsSync(agentsDir)) {
    for (const entry of await readdir(agentsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      add(join(agentsDir, entry.name), `agents/${entry.name}`)
    }
  }

  const marker = join(dest, '.harness-owned.json')
  const previous = await readOwned(marker)
  const current = planned.map((row) => row.to)

  if (dryRun) {
    return { moduleId: 'harness', kind: 'core', planned: current, remove: previous.filter((f) => !current.includes(f)) }
  }

  for (const row of planned) {
    await mkdir(dirname(row.to), { recursive: true })
    const info = await stat(row.from)
    if (info.isDirectory()) await cp(row.from, row.to, { recursive: true })
    else await cp(row.from, row.to)
  }
  for (const stale of previous.filter((f) => !current.includes(f))) {
    try { await rm(join(dest, stale), { force: true, recursive: true }) } catch {}
  }
  await writeOwned(marker, { moduleId: 'harness', files: current })
  return { projected: 'harness', kind: 'core', files: current.length }
}

export async function recordReceipt(receiptDir, moduleId, payload) {
  await mkdir(receiptDir, { recursive: true })
  const receiptPath = join(receiptDir, 'install-receipt.json')
  let receipt = { version: 1, installedAt: new Date().toISOString(), modules: {} }
  if (existsSync(receiptPath)) {
    try { receipt = JSON.parse(await readFile(receiptPath, 'utf8')) } catch {}
  }
  receipt.installedAt = new Date().toISOString()
  receipt.modules[moduleId] = payload
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  return receiptPath
}

async function readHarnessVersion(repo) {
  try {
    const manifest = JSON.parse(await readFile(join(repo, '.claude-plugin/plugin.json'), 'utf8'))
    return manifest.version || null
  } catch {
    return null
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const positional = args.filter((arg) => arg !== '--dry-run')

  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.error('usage: install-reconcile.mjs <validate|generate-marketplaces|sync-agent-docs|generate|optional-ids|hosts|scopes|skills-add-args|describe|resolve-install-bases|project-bundle|project-harness-opencode|project-agent|record-receipt> ...')
    process.exit(cmd ? 0 : 2)
  }

  const catalog = await loadCatalog()

  switch (cmd) {
    case 'validate': {
      const errors = await validate()
      if (errors.length) {
        for (const err of errors) console.error(`catalog validate: ${err}`)
        process.exit(1)
      }
      console.log('ok - install catalog, marketplaces, and agent docs are aligned')
      break
    }
    case 'generate-marketplaces': {
      const written = await generateMarketplaces()
      console.log(`ok - wrote ${written.join(' ')}`)
      break
    }
    case 'sync-agent-docs': {
      const result = await syncAgentDocs()
      console.log(`ok - wrote ${result.claude} from ${result.agents}`)
      break
    }
    case 'generate': {
      const written = await generateMarketplaces()
      const docs = await syncAgentDocs()
      console.log(`ok - wrote ${written.join(' ')} and ${docs.claude}`)
      break
    }
    case 'optional-ids': {
      console.log(optionalModuleIds(catalog).join(' '))
      break
    }
    case 'hosts': {
      const id = positional[0]
      if (!id) {
        console.error('usage: install-reconcile.mjs hosts <moduleId>')
        process.exit(2)
      }
      console.log(hostsForModule(catalog, id).join(' '))
      break
    }
    case 'scopes': {
      const id = positional[0]
      if (!id) {
        console.error('usage: install-reconcile.mjs scopes <moduleId>')
        process.exit(2)
      }
      console.log(scopesForModule(catalog, id).join(' '))
      break
    }
    case 'skills-add-args': {
      const id = positional[0]
      if (!id) {
        console.error('usage: install-reconcile.mjs skills-add-args <moduleId>')
        process.exit(2)
      }
      console.log(JSON.stringify(skillsAddArgs(catalog, id)))
      break
    }
    case 'resolve-install-bases': {
      const [scope, projectDir = ''] = positional
      if (!scope) {
        console.error('usage: install-reconcile.mjs resolve-install-bases <scope> [projectDir]')
        process.exit(2)
      }
      console.log(JSON.stringify(resolveInstallBases(scope, projectDir)))
      break
    }
    case 'describe': {
      const id = positional[0]
      if (!id) {
        console.error('usage: install-reconcile.mjs describe <moduleId>')
        process.exit(2)
      }
      console.log(descriptionForModule(catalog, id))
      break
    }
    case 'project-bundle': {
      const [moduleId, dest] = positional
      if (!moduleId || !dest) {
        console.error('usage: install-reconcile.mjs project-bundle <moduleId> <destDir> [--dry-run]')
        process.exit(2)
      }
      const result = await projectBundle(root, moduleId, dest, { dryRun })
      console.log(JSON.stringify(result))
      break
    }
    case 'project-harness-opencode': {
      const [repo, base] = positional
      if (!repo || !base) {
        console.error('usage: install-reconcile.mjs project-harness-opencode <repoDir> <opencodeBase> [--dry-run]')
        process.exit(2)
      }
      const result = await projectHarnessOpenCode(resolve(repo), resolve(base), { dryRun })
      console.log(JSON.stringify(result))
      break
    }
    case 'project-agent': {
      const [moduleId, repo, dest] = positional
      if (!moduleId || !repo || !dest) {
        console.error('usage: install-reconcile.mjs project-agent <moduleId> <repoDir> <destDir> [--dry-run]')
        process.exit(2)
      }
      const result = await projectAgent(resolve(repo), moduleId, resolve(dest), { dryRun })
      console.log(JSON.stringify(result))
      break
    }
    case 'record-receipt': {
      const [receiptDir, moduleId, jsonText] = positional
      if (!receiptDir || !moduleId || !jsonText) {
        console.error('usage: install-reconcile.mjs record-receipt <receiptDir> <moduleId> <json>')
        process.exit(2)
      }
      const payload = JSON.parse(jsonText)
      const version = await readHarnessVersion(root)
      if (version) payload.harnessVersion = version
      const path = await recordReceipt(resolve(receiptDir), moduleId, payload)
      console.log(path)
      break
    }
    default:
      console.error(`unknown command: ${cmd}`)
      process.exit(2)
  }
}

if (isCliEntry(process.argv[1], fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err.message || err)
    process.exit(1)
  })
}
