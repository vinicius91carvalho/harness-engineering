#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

function fail(message) {
  process.stderr.write(`orchestrator: ${message}\n`)
  process.exit(2)
}

const options = { mode: 'full', port: '5170' }
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]
  const value = process.argv[i + 1]
  if (!key?.startsWith('--') || value === undefined) fail(`invalid argument: ${key || ''}`)
  options[key.slice(2)] = value
}

if (!['claude', 'codex', 'opencode'].includes(options.host)) {
  fail('--host must be claude, codex, or opencode')
}
if (!options.workdir || !options.features) fail('--workdir and --features are required')

const wanted = options.features.split(',').filter(Boolean)
const featureFile = `${options.workdir}/feature_list.json`
const commands = {
  claude: (prompt) => ['claude', ['-p', prompt]],
  codex: (prompt) => ['codex', ['exec', prompt]],
  opencode: (prompt) => ['opencode', ['run', prompt]],
}

async function readFeatures() {
  let parsed
  try { parsed = JSON.parse(await readFile(featureFile, 'utf8')) } catch (error) {
    fail(`cannot read ${featureFile}: ${error.message}`)
  }
  const list = Array.isArray(parsed) ? parsed : parsed.features
  if (!Array.isArray(list)) fail('feature_list.json must be an array or contain a features array')
  return list
}

function runAgent(prompt) {
  const [program, args] = commands[options.host](prompt)
  const result = spawnSync(program, args, {
    cwd: options.workdir,
    env: {
      ...process.env,
      PORT: String(options.port),
      FRONTEND_PORT: String(options.port),
      BACKEND_PORT: String(Number(options.port) + 1000),
    },
    encoding: 'utf8',
    timeout: Number(process.env.HARNESS_AGENT_TIMEOUT_MS || 1_800_000),
  })
  // Some constrained launchers report a post-exec EPERM even when the child
  // exited successfully. A concrete exit status is authoritative.
  if (result.status === 0) return { ok: true, detail: (result.stderr || result.stdout || '').trim() }
  if (result.error) return { ok: false, detail: result.error.message }
  return { ok: false, detail: (result.stderr || result.stdout || '').trim() }
}

function prompt(kind, feature, attempt) {
  const action = kind === 'CODING'
    ? 'Implement this feature, test it through its public interface, and set only its implementation flag true after it works.'
    : 'Independently verify this feature as a black-box specification. Set qa true only on pass; on failure set implementation false and record defects.'
  return `${kind} attempt ${attempt}/3\nWORKDIR=${options.workdir}\nPORT=${options.port}\n` +
    `Feature id=${feature.id} context=${feature.context}: ${feature.description || ''}\n${action}\n` +
    'The orchestrator will verify feature_list.json; a prose claim of success is insufficient.'
}

const initial = await readFeatures()
const selected = wanted.map((id) => initial.find((feature) => String(feature.id) === id))
if (selected.some((feature) => !feature)) fail(`unknown feature id in --features: ${wanted.join(',')}`)

const results = []
let built = 0
let passed = 0

for (const feature of selected) {
  let status = 'stuck-implementation'
  let detail = ''
  for (let attempt = 1; attempt <= 3; attempt++) {
    let current = (await readFeatures()).find((item) => String(item.id) === String(feature.id))
    if (options.mode !== 'qa' && current.implementation !== true) {
      const coding = runAgent(prompt('CODING', feature, attempt))
      detail = coding.detail
      current = (await readFeatures()).find((item) => String(item.id) === String(feature.id))
      if (!coding.ok || current.implementation !== true) continue
    }
    if (current.implementation === true) built = Math.max(built, results.length + 1)

    const qa = runAgent(prompt('QA', feature, attempt))
    detail = qa.detail
    current = (await readFeatures()).find((item) => String(item.id) === String(feature.id))
    if (qa.ok && current.implementation === true && current.qa === true) {
      status = 'passed'
      passed++
      break
    }
    status = 'stuck-qa'
    if (options.mode === 'qa') continue
  }
  results.push({ id: feature.id, status, ...(status === 'passed' ? {} : { detail }) })
}

process.stdout.write(`${JSON.stringify({ total: selected.length, built, passed, stuck: results.filter((r) => r.status !== 'passed'), results }, null, 2)}\n`)
