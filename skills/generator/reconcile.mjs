#!/usr/bin/env node
import { readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

function fail(message) {
  process.stderr.write(`reconcile: ${message}\n`)
  process.exit(2)
}

const args = process.argv.slice(2)
const repo = resolve(args.find((arg) => !arg.startsWith('--')) || '.')
const checkOnly = args.includes('--check')
const specFile = resolve(repo, 'project_specs.xml')
const queueFile = resolve(repo, 'feature_list.json')

function attribute(text, name) {
  const match = text.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`))
  return match?.[2]?.trim() || ''
}

function body(text, tag) {
  return text.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`))?.[1]
    ?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || ''
}

function parseChecks(xml) {
  const checks = [...xml.matchAll(/<acceptance_check\b([^>]*)>([\s\S]*?)<\/acceptance_check>/g)]
    .map((match) => {
      const id = attribute(match[1], 'id')
      const context = attribute(match[1], 'context')
      const dependencies = attribute(match[1], 'depends_on').split(',').map((v) => v.trim()).filter(Boolean)
      return {
        id,
        context,
        category: attribute(match[1], 'category') || 'functional',
        description: body(match[2], 'description'),
        dependencies,
      }
    })
  if (!checks.length) fail('project_specs.xml has no <acceptance_check> entries; run the planner first')
  const ids = new Set()
  for (const check of checks) {
    if (!check.id || !check.context || !check.description) fail('every acceptance_check needs id, context, and description')
    if (ids.has(check.id)) fail(`duplicate acceptance check id: ${check.id}`)
    ids.add(check.id)
  }
  for (const check of checks) {
    for (const dependency of check.dependencies) {
      if (!ids.has(dependency)) fail(`${check.id} depends on unknown acceptance check ${dependency}`)
    }
  }
  const visiting = new Set(), visited = new Set()
  const byId = new Map(checks.map((check) => [check.id, check]))
  function visit(id) {
    if (visiting.has(id)) fail(`acceptance check dependency cycle includes ${id}`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of byId.get(id).dependencies) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const check of checks) visit(check.id)
  return checks
}

let xml, parsed
try {
  xml = await readFile(specFile, 'utf8')
  parsed = JSON.parse(await readFile(queueFile, 'utf8'))
} catch (error) {
  fail(error.message)
}

const checks = parseChecks(xml)
const queue = parsed
if (!Array.isArray(queue)) fail('feature_list.json must be an array')
const validIds = new Set(checks.map((check) => check.id))
const workIds = new Set()
for (const item of queue) {
  if (!item.id || workIds.has(String(item.id))) fail(`missing or duplicate Work Item id: ${item.id || ''}`)
  workIds.add(String(item.id))
  if (!Array.isArray(item.acceptance_checks) || !item.acceptance_checks.length) fail(`work item ${item.id} has no Acceptance Check mapping`)
  for (const id of item.acceptance_checks) {
    if (!validIds.has(id)) fail(`work item ${item.id} maps unknown acceptance check ${id}`)
  }
}

const mapped = new Set(queue.flatMap((item) => item.acceptance_checks || []))
const missing = checks.filter((check) => !mapped.has(check.id))
if (checkOnly && missing.length) fail(`unmapped acceptance checks: ${missing.map((check) => check.id).join(', ')}`)

for (const check of missing) {
  queue.push({
    id: `WI-${check.id}`,
    context: check.context,
    category: check.category,
    description: check.description,
    steps: [`Verify ${check.id}: ${check.description}`],
    acceptance_checks: [check.id],
    depends_on: check.dependencies,
    // Appended after the baseline => new work: build/implement, not verify-first audit.
    verify_first: false,
    implementation: false,
    qa: false,
    integration: false,
    retries: 0,
  })
}

const byCheck = new Map(checks.map((check) => [check.id, check]))
const filled = []
for (const item of queue) {
  const internal = new Set(item.acceptance_checks)
  const expected = new Set(item.acceptance_checks.flatMap((id) => byCheck.get(id)?.dependencies || []).filter((id) => !internal.has(id)))
  const actual = new Set(item.depends_on || [])
  const omitted = [...expected].filter((id) => !actual.has(id))
  if (!omitted.length) continue
  if (checkOnly) fail(`work item ${item.id} omits dependencies: ${omitted.join(', ')}; run reconcile.mjs without --check to auto-fill`)
  item.depends_on = [...(item.depends_on || []), ...omitted]
  filled.push(item.id)
}

if (!checkOnly && (missing.length || filled.length)) {
  const temporary = `${queueFile}.tmp.${process.pid}`
  await writeFile(temporary, `${JSON.stringify(queue, null, 2)}\n`)
  await rename(temporary, queueFile)
}

process.stdout.write(`${JSON.stringify({ acceptanceChecks: checks.length, addedWorkItems: missing.length, addedIds: missing.map((check) => check.id), filledDependsOn: filled })}\n`)
