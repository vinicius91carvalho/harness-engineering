#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { atomicJson } from './lib/fs-json.mjs'
import { integrationBranchName } from './lib/integration-branch.mjs'
import { inferObservationMethod, workItemObservationMethods } from './lib/observation-method.mjs'

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

function gitOutput(args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : ''
}

function integrationQueueFallback() {
  const prefix = gitOutput(['rev-parse', '--show-prefix'])
  const branch = integrationBranchName(repo)
  const source = gitOutput(['show', `${branch}:${prefix}feature_list.json`])
  if (!source) return null
  try { return JSON.parse(source) } catch { return null }
}

async function readQueue() {
  try {
    return JSON.parse(await readFile(queueFile, 'utf8'))
  } catch (error) {
    const fallback = integrationQueueFallback()
    if (!fallback) throw error
    await atomicJson(queueFile, fallback)
    return fallback
  }
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
        observation: attribute(match[1], 'observation') || '',
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
  parsed = await readQueue()
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
  const observation_method = inferObservationMethod({
    category: check.category,
    description: check.description,
    observation: check.observation,
  })
  queue.push({
    id: `WI-${check.id}`,
    context: check.context,
    category: check.category,
    observation_method,
    observation_methods: [observation_method],
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
let observationFilled = 0
for (const item of queue) {
  const methods = workItemObservationMethods(item, byCheck)
  if (!item.observation_method || item.observation_method !== methods[0]) {
    item.observation_method = methods[0]
    item.observation_methods = methods
    observationFilled += 1
  } else if (!Array.isArray(item.observation_methods)) {
    item.observation_methods = methods
    observationFilled += 1
  }
  const internal = new Set(item.acceptance_checks)
  const expected = new Set(item.acceptance_checks.flatMap((id) => byCheck.get(id)?.dependencies || []).filter((id) => !internal.has(id)))
  const actual = new Set(item.depends_on || [])
  const omitted = [...expected].filter((id) => !actual.has(id))
  if (!omitted.length) continue
  if (checkOnly) fail(`work item ${item.id} omits dependencies: ${omitted.join(', ')}; run reconcile.mjs without --check to auto-fill`)
  item.depends_on = [...(item.depends_on || []), ...omitted]
  filled.push(item.id)
}

if (!checkOnly && (missing.length || filled.length || observationFilled)) {
  await atomicJson(queueFile, queue)
}

process.stdout.write(`${JSON.stringify({ acceptanceChecks: checks.length, addedWorkItems: missing.length, addedIds: missing.map((check) => check.id), filledDependsOn: filled })}\n`)
