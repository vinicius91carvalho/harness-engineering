import { readdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseVerdict, VERDICT_BEGIN } from '../../generator/lib/worker-outcome.mjs'
import { inferDefectClass } from '../../generator/lib/failure-policy.mjs'
import { gitCommonDir } from '../../generator/lib/git-repo.mjs'

const EVIDENCE_DIR = 'harness-evidence'

/** @typedef {{ paths?: string[], repo?: string, commonGit?: string, projectId?: string, runId?: string, context?: string }} EvidenceScope */

/**
 * Resolve read-only roots for harness-evidence scanning.
 * @param {EvidenceScope} scope
 */
export function resolveEvidenceRoots(scope = {}) {
  const roots = []
  if (Array.isArray(scope.paths) && scope.paths.length) {
    for (const path of scope.paths) roots.push(resolve(path))
    return roots
  }

  let commonGit = scope.commonGit ? resolve(scope.commonGit) : null
  if (!commonGit && scope.repo) {
    const repoPath = resolve(scope.repo)
    try { commonGit = gitCommonDir(repoPath) } catch {
      const direct = join(repoPath, '.git')
      if (existsSync(direct)) commonGit = direct
    }
  }
  if (!commonGit) {
    try { commonGit = gitCommonDir(process.cwd()) } catch { /* ignore */ }
  }
  if (!commonGit) return roots

  let base = join(commonGit, EVIDENCE_DIR)
  if (scope.projectId) base = join(base, scope.projectId)
  if (scope.runId) base = join(base, scope.runId)
  if (scope.context) base = join(base, scope.context)
  if (existsSync(base)) roots.push(base)
  return roots
}

function parseEvidenceHeader(text) {
  const lines = text.split('\n')
  const meta = {}
  let bodyStart = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) { bodyStart = i + 1; break }
    const eq = line.indexOf('=')
    if (eq <= 0) { bodyStart = i; break }
    meta[line.slice(0, eq)] = line.slice(eq + 1)
  }
  const body = lines.slice(bodyStart).join('\n').trim()
  return { meta, body }
}

async function walkEvidenceFiles(root) {
  const files = []
  async function walk(dir) {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile() && entry.name.endsWith('.log')) files.push(full)
    }
  }
  await walk(root)
  return files
}

/**
 * List create-only evidence artifacts (read-only). Never writes.
 * @param {EvidenceScope} scope
 */
export async function scan(scope = {}) {
  const roots = resolveEvidenceRoots(scope)
  const entries = []
  const skipped = { partial: 0, nonJson: 0 }

  for (const root of roots) {
    const files = await walkEvidenceFiles(root)
    for (const path of files) {
      let text
      try {
        const info = await stat(path)
        if (!info.isFile()) continue
        text = await readFile(path, 'utf8')
      } catch {
        skipped.partial += 1
        continue
      }
      if (!text.trim()) {
        skipped.partial += 1
        continue
      }
      const { meta, body } = parseEvidenceHeader(text)
      const headerFields = ['project', 'run', 'context', 'id', 'kind'].filter((key) => meta[key])
      if (headerFields.length < 2) {
        skipped.partial += 1
        continue
      }
      const verdict = parseVerdict(body)
      const looksStructured = body.trim().startsWith('{') || body.includes(VERDICT_BEGIN)
      if (looksStructured && !verdict) {
        skipped.nonJson += 1
        continue
      }
      entries.push({
        path,
        project: meta.project || null,
        run: meta.run || null,
        context: meta.context || null,
        workItemId: meta.id || null,
        attempt: meta.attempt ? Number(meta.attempt) : null,
        kind: meta.kind || null,
        digest: meta.digest || null,
        at: meta.at || null,
        body,
        verdict,
      })
    }
  }

  return { roots, entries, skipped, count: entries.length }
}

function defectLines(verdict = {}) {
  const lines = []
  if (Array.isArray(verdict.defects)) lines.push(...verdict.defects.map(String))
  if (verdict.reason) lines.push(String(verdict.reason))
  if (verdict.notes) lines.push(String(verdict.notes))
  if (verdict.summary) lines.push(String(verdict.summary))
  return lines.filter(Boolean)
}

function normalizeSignature(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.Z+-]+/g, '<ts>')
    .replace(/\b[0-9a-f]{8,}\b/g, '<id>')
    .trim()
    .slice(0, 240)
}

/**
 * Pull structured verdict rows from a scan result.
 * @param {{ entries?: object[] }} scanResult
 */
export function extractVerdicts(scanResult = {}) {
  const rows = []
  for (const entry of scanResult.entries || []) {
    if (!entry.verdict || typeof entry.verdict !== 'object') continue
    const verdict = entry.verdict
    const defects = defectLines(verdict)
    const defectClass = inferDefectClass(verdict, defects.join('\n'))
    rows.push({
      path: entry.path,
      project: entry.project,
      run: entry.run,
      context: entry.context,
      workItemId: entry.workItemId,
      attempt: entry.attempt,
      kind: entry.kind,
      defectClass,
      implementation: verdict.implementation,
      qa: verdict.qa,
      goal: verdict.goal,
      blocked: verdict.blocked,
      defects,
      verdict,
    })
  }
  return rows
}

/**
 * Cluster defects by normalized signature and defect class.
 * @param {ReturnType<typeof extractVerdicts>} verdicts
 */
export function clusterDefects(verdicts = []) {
  const clusters = new Map()
  for (const row of verdicts) {
    const seeds = row.defects.length ? row.defects : [row.defectClass || 'unknown']
    for (const defect of seeds) {
      const signature = normalizeSignature(defect)
      const key = `${row.defectClass || 'product'}::${signature}`
      const existing = clusters.get(key) || {
        key,
        defectClass: row.defectClass || 'product',
        signature,
        sample: defect,
        count: 0,
        contexts: new Set(),
        workItems: new Set(),
        paths: [],
      }
      existing.count += 1
      if (row.context) existing.contexts.add(row.context)
      if (row.workItemId) existing.workItems.add(row.workItemId)
      existing.paths.push(row.path)
      clusters.set(key, existing)
    }
  }
  return [...clusters.values()].map((cluster) => ({
    ...cluster,
    contexts: [...cluster.contexts],
    workItems: [...cluster.workItems],
  })).sort((a, b) => b.count - a.count)
}

/**
 * Recurring defect clusters meeting the recurrence bar.
 * @param {ReturnType<typeof clusterDefects>} clusters
 * @param {number} minN
 */
export function recurrenceReport(clusters = [], minN = 2) {
  const threshold = Math.max(1, Number(minN) || 2)
  return clusters.filter((cluster) => cluster.count >= threshold)
}

const ROUTE_BY_CLASS = {
  observation_mismatch: 'skills/generator/SKILL.md',
  infra: 'skills/supervisor/SKILL.md',
  quota: 'skills/supervisor/SKILL.md',
  merge_conflict: 'skills/generator/SKILL.md',
  product: 'skills/generator/SKILL.md',
}

const ROUTE_BY_TOPIC = [
  { pattern: /\b(herdr|pane|supervisor|fleet|worker health|stuck)\b/i, route: 'skills/supervisor/SKILL.md' },
  { pattern: /\b(monorepo|sibling|cross-project|fleet-ops)\b/i, route: 'skills/monorepo-supervisor-ops/SKILL.md' },
  { pattern: /\b(install|backup|host config|cursor|codex|claude)\b/i, route: 'skills/update-project/SKILL.md' },
  { pattern: /\b(learning|retrospective|skill)\b/i, route: 'skills/learning-loop/SKILL.md' },
]

/**
 * Suggest workflow-skill patch targets only — never writes.
 * @param {ReturnType<typeof recurrenceReport>} recurring
 */
export function proposeRoutes(recurring = []) {
  const proposals = []
  const seen = new Set()
  for (const cluster of recurring) {
    let route = ROUTE_BY_CLASS[cluster.defectClass] || 'skills/generator/SKILL.md'
    for (const rule of ROUTE_BY_TOPIC) {
      if (rule.pattern.test(cluster.sample)) { route = rule.route; break }
    }
    const key = `${route}::${cluster.key}`
    if (seen.has(key)) continue
    seen.add(key)
    proposals.push({
      route,
      defectClass: cluster.defectClass,
      recurrence: cluster.count,
      evidence: cluster.sample,
      contexts: cluster.contexts,
      workItems: cluster.workItems,
      confidence: cluster.count >= 3 ? 'high' : 'med',
    })
  }
  return proposals
}
