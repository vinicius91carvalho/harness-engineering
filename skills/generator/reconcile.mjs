#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { atomicJson } from './lib/fs-json.mjs'
import { readFeatureListFromIntegration } from './lib/git-repo.mjs'
import { resolveProjectRoot } from './lib/project-topology.mjs'
import { inferObservationMethod, workItemObservationMethods } from './lib/observation-method.mjs'
import {
  parseProjectSpecification,
} from './lib/project-specification.mjs'
import { validateDependencyGraph } from './lib/ready-work-items.mjs'

function fail(message) {
  process.stderr.write(`reconcile: ${message}\n`)
  process.exit(2)
}

const args = process.argv.slice(2)
let repo
try {
  repo = resolveProjectRoot(args.find((arg) => !arg.startsWith('--')) || process.cwd())
} catch (error) {
  fail(error.message)
}
const checkOnly = args.includes('--check')
if (args.includes('--print-root')) {
  process.stdout.write(`${repo}\n`)
  process.exit(0)
}
const specFile = resolve(repo, 'project_specs.xml')
const queueFile = resolve(repo, 'feature_list.json')

async function readQueue() {
  try {
    return JSON.parse(await readFile(queueFile, 'utf8'))
  } catch (error) {
    let fallback = null
    try { fallback = readFeatureListFromIntegration(repo) } catch { /* fall through to the read error */ }
    if (!fallback) throw error
    await atomicJson(queueFile, fallback)
    return fallback
  }
}

let xml, parsed, spec
try {
  xml = await readFile(specFile, 'utf8')
  spec = parseProjectSpecification(xml)
  parsed = await readQueue()
} catch (error) {
  fail(error.message)
}

const checks = spec.checks.map((check) => ({
  id: check.id,
  context: check.context,
  category: check.category,
  observation: check.observation,
  description: check.description,
  dependencies: check.dependsOn,
}))
const decisions = spec.planningDecisions?.decisions || []
const decisionsByCheck = new Map()
for (const decision of decisions) {
  for (const ac of decision.acceptanceChecks || []) {
    const list = decisionsByCheck.get(ac) || []
    list.push(decision.id)
    decisionsByCheck.set(ac, list)
  }
}
const queue = parsed
if (!Array.isArray(queue)) fail('feature_list.json must be an array')

try {
  validateDependencyGraph(checks.map((c) => ({ ...c, dependsOn: c.dependencies })), queue)
} catch (error) {
  fail(error.message)
}

const mapped = new Set(queue.flatMap((item) => item.acceptance_checks || []))
const missing = checks.filter((check) => !mapped.has(check.id))
if (checkOnly && missing.length) fail(`unmapped acceptance checks: ${missing.map((check) => check.id).join(', ')}`)

// Detect generated-ID collisions before append
for (const check of missing) {
  const id = `WI-${check.id}`
  if (queue.some((item) => String(item.id) === id)) fail(`generated Work Item id already exists: ${id}`)
}

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
    planning_decision_ids: decisionsByCheck.get(check.id) || [],
    depends_on: check.dependencies,
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
let decisionFilled = 0
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
  const linked = [...new Set((item.acceptance_checks || []).flatMap((id) => decisionsByCheck.get(id) || []))]
  const prev = Array.isArray(item.planning_decision_ids) ? item.planning_decision_ids.join(',') : ''
  if (linked.join(',') !== prev) {
    item.planning_decision_ids = linked
    decisionFilled += 1
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

if (!checkOnly && (missing.length || filled.length || observationFilled || decisionFilled)) {
  await atomicJson(queueFile, queue)
}

process.stdout.write(`${JSON.stringify({ projectRoot: repo, acceptanceChecks: checks.length, addedWorkItems: missing.length, addedIds: missing.map((check) => check.id), filledDependsOn: filled })}\n`)
