#!/usr/bin/env node
import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir, hostname } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
if (!['claude', 'codex', 'opencode', 'pi'].includes(options.host)) fail('--host must be claude, codex, opencode, or pi')
if (!options.workdir) fail('--workdir is required')

options.workdir = realpathSync(resolve(options.workdir))
options.repo = realpathSync(resolve(options.repo || options.workdir))
const claimScript = options['claim-script'] || resolve(dirname(fileURLToPath(import.meta.url)), 'claim.sh')
const wanted = (options.features || '').split(',').filter(Boolean)
const commands = {
  claude: (prompt) => ['claude', ['-p', prompt]],
  codex: (prompt) => ['codex', ['exec', prompt]],
  opencode: (prompt) => ['opencode', ['run', prompt]],
  // ponytail: pi's default model is GLM 5.2 via OpenRouter (pi has no built-in default for it).
  pi: (prompt) => ['pi', ['--model', 'openrouter/z-ai/glm-5.2', '-p', prompt]],
}
const roleNames = {
  CODING: 'coding', QA: 'validation', INTEGRATION_QA: 'validation',
  REPAIR_PLAN: 'repairPlanning', MERGE: 'coding', GOAL_REVIEW: 'goalReview',
}
const reconcileScript = resolve(dirname(fileURLToPath(import.meta.url)), 'reconcile.mjs')
const MAX_ATTEMPTS = 3
const MAX_OPERATIONAL_FAILURES = 3

function command(program, args, cwd = options.workdir, allowFailure = false) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8' })
  if (!allowFailure && result.status !== 0) fail((result.stderr || result.stdout || `${program} failed`).trim())
  return result
}

function git(args, cwd = options.workdir, allowFailure = false) {
  return command('git', args, cwd, allowFailure)
}

function gitTopLevel(cwd) {
  return realpathSync(git(['rev-parse', '--show-toplevel'], cwd).stdout.trim())
}

const commonGitRaw = git(['rev-parse', '--git-common-dir']).stdout.trim()
const commonGit = isAbsolute(commonGitRaw) ? commonGitRaw : resolve(options.workdir, commonGitRaw)
const runDir = join(commonGit, 'harness-runs')
const context = options.context || 'goal-review'
const projectPrefix = git(['rev-parse', '--show-prefix'], options.repo).stdout.trim().replace(/\/$/, '')
const projectId = projectPrefix ? projectPrefix.replace(/[^a-zA-Z0-9_-]/g, '_') : ''
const stateContext = projectId ? `${projectId}--${context}` : context
const stateFile = join(runDir, `${stateContext.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)
const leaseToken = randomUUID()
let child = null
let state = {}
let itemPlan = null
const verifyFirstCache = new Map()
const codingHarnesses = new Map()
let heartbeatTimer

function terminateChild(signal = 'SIGTERM') {
  if (!child?.pid) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch { try { child.kill(signal) } catch {} }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return fallback }
}

async function atomicJson(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.tmp.${process.pid}.${randomUUID()}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temporary, file)
}

async function writeState(change = {}) {
  const current = await readJson(stateFile, {})
  if (current.leaseToken && current.leaseToken !== leaseToken && current.ownerHost === hostname() && current.ownerPid && current.ownerPid !== process.pid) {
    try { process.kill(current.ownerPid, 0); fail(`Claim Lease for ${context} is owned by live pid ${current.ownerPid}`) } catch {}
  }
  const nextStatus = change.status || state.status
  state = {
    ...state,
    ...change,
    context,
    leaseToken,
    ownerHost: hostname(),
    ownerPid: nextStatus === 'blocked' || nextStatus === 'complete' ? null : process.pid,
    heartbeat: new Date().toISOString(),
    heartbeatEpoch: Math.floor(Date.now() / 1000),
  }
  await atomicJson(stateFile, state)
}

function writeInterruptedState(signal) {
  try {
    terminateChild()
    const value = {
      ...state, context, leaseToken, ownerHost: hostname(), ownerPid: null, childPid: null,
      status: 'interrupted', lastResult: `orchestrator received ${signal}`,
      heartbeat: new Date().toISOString(), heartbeatEpoch: Math.floor(Date.now() / 1000),
    }
    const temporary = `${stateFile}.tmp.${process.pid}.${randomUUID()}`
    mkdirSync(dirname(stateFile), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
    renameSync(temporary, stateFile)
  } finally { process.exit(130) }
}
process.on('SIGINT', () => writeInterruptedState('SIGINT'))
process.on('SIGTERM', () => writeInterruptedState('SIGTERM'))

async function readFeatures(workdir = options.workdir) {
  const file = join(workdir, 'feature_list.json')
  let parsed
  try { parsed = JSON.parse(await readFile(file, 'utf8')) } catch (error) { fail(`cannot read ${file}: ${error.message}`) }
  if (!Array.isArray(parsed)) fail('feature_list.json must be an array')
  return { file, parsed, list: parsed }
}

async function isVerifyFirst(workdir = options.workdir) {
  try {
    const spec = await readFile(join(workdir, 'project_specs.xml'), 'utf8')
    return /<mode>\s*existing-codebase\s*<\/mode>/.test(spec)
  } catch { return false }
}

async function readRoles(workdir = options.workdir) {
  const file = join(workdir, '.harness', 'roles.json')
  let roles
  try { roles = JSON.parse(await readFile(file, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return null
    fail(`cannot read ${file}: ${error.message}`)
  }
  const normalized = {}
  const normalizeCandidate = (role, value) => {
    const candidate = typeof value === 'string' ? { harness: value } : value
    if (!candidate || !['claude', 'codex', 'opencode', 'pi'].includes(candidate.harness)) {
      fail(`${file}: ${role} candidates must use claude, codex, opencode, or pi`)
    }
    if (candidate.model !== undefined && (typeof candidate.model !== 'string' || !candidate.model.trim())) {
      fail(`${file}: ${role} model must be a non-empty string`)
    }
    return { harness: candidate.harness, ...(candidate.model ? { model: candidate.model } : {}) }
  }
  for (const role of ['coding', 'validation', 'repairPlanning', 'goalReview']) {
    if (!Array.isArray(roles[role]) || !roles[role].length) fail(`${file}: ${role} must be a non-empty array`)
    normalized[role] = roles[role].map((value) => normalizeCandidate(role, value))
  }
  // Optional free/no-credits tier: validated like the four roles (claude/codex/opencode/pi, optional model). Absent/empty is fine.
  if (Array.isArray(roles.noCredits)) normalized.noCredits = roles.noCredits.map((value) => normalizeCandidate('noCredits', value))
  return normalized
}

// Route history stores model as `model||null`; coerce null/undefined to '' so keys never split (infra|h| vs infra|h|undefined).
function mkey(harness, model) { return `${harness}|${model || ''}` }

// Best-effort read of the per-run strike scoreboard via claim.sh. Never aborts the run; {} on any failure/empty.
function readStrikes() {
  const result = command('bash', [claimScript, 'strikes', options.repo], options.repo, true)
  if (result.status !== 0) return {}
  try { return JSON.parse(result.stdout) || {} } catch { return {} }
}

function strikeOf(role, harness, model, strikes) {
  return (strikes[`infra|${mkey(harness, model)}`] || 0) + (strikes[`quality|${role}|${mkey(harness, model)}`] || 0)
}

// scope documents intent; the key already carries its scope prefix. Best-effort — a failure here must never abort the run.
function bumpStrike(scope, key, delta) {
  command('bash', [claimScript, 'strike', options.repo, key, String(delta)], options.repo, true)
}

// Read strikes ONCE per Work Item and pre-sort every role list, so order stays stable within an item (only the
// attempt-driven coder offset shifts it). Direct mode (no roles.json) → null: no strikes, no sort.
function buildPlan(roles) {
  if (!roles) return null
  const strikes = readStrikes()
  const sortedRoles = {}
  for (const role of ['coding', 'validation', 'repairPlanning', 'goalReview']) {
    sortedRoles[role] = [...roles[role]].sort((a, b) =>
      strikeOf(role, a.harness, a.model, strikes) - strikeOf(role, b.harness, b.model, strikes))
  }
  return { roles, sortedRoles, strikes }
}

// The (harness, model) of the most recent selected coder, for quality-strike bookkeeping. Route carries model.
function lastCoder() {
  const route = [...(state.routeHistory || [])].reverse().find((r) => r.kind === 'CODING' && r.outcome === 'selected')
  return route ? mkey(route.harness, route.model) : null
}

async function recentCodingHarness(id) {
  if (codingHarnesses.has(String(id))) return codingHarnesses.get(String(id))
  const entries = []
  try {
    for (const file of await readdir(runDir)) {
      if (!file.endsWith('.json')) continue
      const name = file.slice(0, -5)
      if (projectId ? !name.startsWith(`${projectId}--`) : name.includes('--')) continue
      const run = await readJson(join(runDir, file), {})
      for (const route of run.routeHistory || []) {
        if (route.kind === 'CODING' && route.outcome === 'selected' && (id === 'goal' || String(route.id) === String(id))) {
          entries.push({ ...route, heartbeat: run.heartbeat || '' })
        }
      }
    }
  } catch {}
  entries.sort((a, b) => a.heartbeat.localeCompare(b.heartbeat))
  return entries.at(-1)?.harness
}

async function updateFeature(workdir, id, changes) {
  const { file, parsed, list } = await readFeatures(workdir)
  const feature = list.find((item) => String(item.id) === String(id))
  if (!feature) fail(`unknown Work Item ${id}`)
  Object.assign(feature, changes)
  await atomicJson(file, parsed)
  return feature
}

function parseObject(text) {
  const trimmed = text.trim()
  const BEGIN = '===HARNESS-VERDICT-BEGIN===', END = '===HARNESS-VERDICT-END==='
  const open = trimmed.lastIndexOf(BEGIN)
  if (open >= 0) {
    const rest = trimmed.slice(open + BEGIN.length)
    const close = rest.indexOf(END)
    const body = (close >= 0 ? rest.slice(0, close) : rest).trim()
    try { const v = JSON.parse(body); if (v && typeof v === 'object') return v } catch {}
  }
  // ponytail: fallback positional scan keeps un-delimited (older) agents working
  const candidates = [trimmed, ...trimmed.split('\n').reverse()]
  const start = trimmed.indexOf('{'), end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1))
  for (const candidate of candidates) {
    try { const parsed = JSON.parse(candidate); if (parsed && typeof parsed === 'object') return parsed } catch {}
  }
  return null
}

async function evidence(id, attempt, kind, detail, route = null) {
  const dir = join(runDir, 'evidence', context.replace(/[^a-zA-Z0-9_-]/g, '_'))
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${String(id).replace(/[^a-zA-Z0-9_-]/g, '_')}-${attempt}-${kind.toLowerCase()}.log`)
  const header = route ? `route=${JSON.stringify(route)}\n` : ''
  await writeFile(file, `${header}${detail}`)
  return file
}

function fallbackReason(result) {
  const detail = result.timedOut ? 'timeout' : result.detail || ''
  if (/\b429\b|rate.?limit/i.test(detail)) return 'rate-limited'
  if (/auth|credential|unauthorized|forbidden|login/i.test(detail)) return 'authentication-failure'
  if (/model.{0,40}(unavailable|not available|not found|unknown)|unavailable.{0,20}model/i.test(detail)) return 'model-unavailable'
  if (/\b402\b|insufficient credits|payment required|quota exceeded|billing/i.test(detail)) return 'no-credits'
  return result.timedOut ? 'launch-timeout' : 'launch-failure'
}

async function spawnAgent(program, args, cwd) {
  return await new Promise((resolveRun) => {
    child = spawn(program, args, {
      cwd,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        PORT: String(options.port),
        FRONTEND_PORT: String(options.port),
        BACKEND_PORT: String(Number(options.port) + 1000),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = '', timedOut = false, settled = false
    const finish = (result) => { if (!settled) { settled = true; child = null; resolveRun(result) } }
    const registered = writeState({ childPid: child.pid || null }).catch((error) => { terminateChild(); fail(error.message) })
    child.stdout?.on('data', (data) => { stdout = `${stdout}${data}`.slice(-1_000_000) })
    child.stderr?.on('data', (data) => { stderr = `${stderr}${data}`.slice(-1_000_000) })
    const timeout = setTimeout(() => { timedOut = true; terminateChild() }, Number(process.env.HARNESS_AGENT_TIMEOUT_MS || 1_800_000))
    child.on('close', async (code) => {
      clearTimeout(timeout)
      await registered
      const detail = (stderr || stdout || '').trim()
      finish({ ok: code === 0 && !timedOut, code, detail, stdout, stderr, parsed: parseObject(stdout || stderr), timedOut })
    })
    child.on('error', async (error) => {
      clearTimeout(timeout)
      await registered
      finish({ ok: false, detail: error.message, stdout, stderr, parsed: null, timedOut: false })
    })
  })
}

async function runAgent(kind, prompt, id, attempt, cwd = options.workdir) {
  const specFile = join(cwd, 'project_specs.xml')
  try { await readFile(specFile) } catch (error) { fail(`cannot reference project_specs.xml: ${error.message}`) }
  const referencedPrompt = `${prompt}\n\nBefore acting, read ${specFile} and verify that the repository contains every structure and file it requires. Handle missing scaffold artifacts according to your role.`
  await writeState({ phase: kind.toLowerCase(), currentFeatureId: id, attempt, childPid: null })
  const plan = itemPlan
  const roles = plan?.roles
  const direct = !roles
  const role = roleNames[kind]
  const strikes = plan?.strikes || {}
  const codedBy = await recentCodingHarness(id) || [...(state.routeHistory || [])].reverse()
    .find((entry) => entry.kind === 'CODING' && String(entry.id) === String(id) && entry.outcome === 'selected')?.harness
  let candidates
  if (direct) {
    candidates = [{ harness: options.host }]
  } else {
    // Base order = item-start strike-sorted role list (stable); do NOT re-read/re-sort strikes per attempt.
    const roleList = [...plan.sortedRoles[role]]
    if (['QA', 'INTEGRATION_QA', 'GOAL_REVIEW'].includes(kind)) {
      const avoid = codedBy || roles.coding[0].harness
      roleList.sort((a, b) => (Number(a.harness === avoid) - Number(b.harness === avoid))
        || (strikeOf(role, a.harness, a.model, strikes) - strikeOf(role, b.harness, b.model, strikes)))
    }
    // ponytail: integration-QA defects also bump `attempt`, so they advance the coder offset too (accepted simplification).
    const repairBudget = Number(process.env.HARNESS_REPAIR_BUDGET || 2)
    const pool = [...roleList, ...(roles.noCredits || [])]
    const offset = kind === 'CODING' ? Math.min(Math.floor((attempt - 1) / repairBudget) + (plan.coderDeclines || 0), pool.length - 1) : 0
    candidates = pool.slice(offset)
  }
  const failures = []
  for (const candidate of candidates) {
    const independence = direct ? 'direct-host' : ['QA', 'INTEGRATION_QA', 'GOAL_REVIEW'].includes(kind)
      ? (candidate.harness === (codedBy || roles?.coding[0].harness) ? 'same-harness-fallback' : 'independent-harness')
      : 'not-applicable'
    const route = {
      adapter: direct ? 'direct' : 'omnigent', kind, id: String(id), harness: candidate.harness,
      model: candidate.model || null, fallbackReason: failures.at(-1)?.reason || (!direct && independence === 'same-harness-fallback' ? 'no-different-harness-available' : null),
      independence,
    }
    const [program, args] = direct
      ? commands[candidate.harness](referencedPrompt)
      : [process.env.HARNESS_OMNIGENT_BIN || 'omni', ['run', join(process.env.HARNESS_OMNIGENT_BUNDLE || join(homedir(), '.omnigent', 'agents', 'harness-engineering'), 'agents', candidate.harness), '--no-session', ...(candidate.model ? ['--model', candidate.model] : []), '--prompt', referencedPrompt]]
    await writeState({ agentRoute: route, childPid: null })
    const result = await spawnAgent(program, args, direct ? cwd : gitTopLevel(cwd))
    const reason = !direct && !result.ok ? fallbackReason(result) : null
    if (reason) bumpStrike('infra', `infra|${mkey(candidate.harness, candidate.model)}`, 1)
    if (!direct && !result.ok && candidates.indexOf(candidate) < candidates.length - 1) {
      failures.push({ harness: candidate.harness, model: candidate.model || null, reason, detail: result.detail.slice(-1000) })
      state.routeHistory = [...(state.routeHistory || []), { ...route, outcome: 'fallback', fallbackReason: reason }]
      await writeState({ routeHistory: state.routeHistory, lastResult: `${candidate.harness}: ${reason}`, childPid: null })
      continue
    }
    const selected = { ...route, outcome: result.ok ? 'selected' : 'failed' }
    state.routeHistory = [...(state.routeHistory || []), selected]
    if (kind === 'CODING' && result.ok) codingHarnesses.set(String(id), candidate.harness)
    if (!direct && result.ok) bumpStrike('infra', `infra|${mkey(candidate.harness, candidate.model)}`, -1)
    const diagnostic = `${failures.length ? `fallbacks=${JSON.stringify(failures)}\n` : ''}${result.parsed ? `${JSON.stringify(result.parsed, null, 2)}\n` : `${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ''}`.slice(-16_000)}`
    const artifact = await evidence(id, attempt, kind, diagnostic, selected)
    await writeState({ childPid: null, evidence: artifact, agentRoute: selected, routeHistory: state.routeHistory })
    return { ...result, artifact, route: selected }
  }
}

async function appPid(workdir) {
  try {
    const pid = Number((await readFile(join(workdir, '.harness', 'app.pid'), 'utf8')).trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch { return null }
}

async function stopApp(workdir) {
  const pidFile = join(workdir, '.harness', 'app.pid')
  const pid = await appPid(workdir)
  if (!pid) { if (state.appPid) await writeState({ appPid: null }); return }
  try { process.kill(pid, 'SIGTERM') } catch {}
  try { await unlink(pidFile) } catch {}
  await writeState({ appPid: null })
}

function journalPath(workdir = options.workdir, name = context) {
  return join(workdir, 'harness-progress', `${name}.md`)
}

async function journal(workdir, title, fields, name = context) {
  const file = journalPath(workdir, name)
  await mkdir(dirname(file), { recursive: true })
  let exists = true
  try { await readFile(file) } catch { exists = false }
  if (!exists) await writeFile(file, `# ${name} workflow journal\n`)
  const lines = Object.entries(fields).filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `- ${key}: ${Array.isArray(value) ? value.join('; ') : value}`)
  await appendFile(file, `\n## ${new Date().toISOString()} — ${title}\n\n${lines.join('\n')}\n`)
  return file
}

function commitPaths(workdir, paths, message) {
  const relative = paths.map((path) => path.replace(`${workdir}/`, ''))
  git(['add', '--', ...relative], workdir)
  const staged = git(['diff', '--cached', '--quiet'], workdir, true)
  if (staged.status !== 0) git(['commit', '-m', message], workdir)
}

// ponytail: shared wrap instruction so every JSON-returning prompt uses the same delimiters parseObject looks for.
const VERDICT_HINT = 'Emit that JSON as the very last thing you print, on its own lines, wrapped exactly:\n===HARNESS-VERDICT-BEGIN===\n{...}\n===HARNESS-VERDICT-END==='

function featurePrompt(kind, feature, attempt, repairPlan = null, workdir = options.workdir) {
  const base = `WORKDIR=${workdir}\nPORT=${options.port}\nWork Item id=${feature.id} context=${feature.context}\n` +
    `Acceptance Checks=${(feature.acceptance_checks || []).join(',')}\nDescription=${feature.description || ''}\n`
  if (kind === 'CODING') {
    // Per-Work-Item verify_first: baseline items (initializer, existing-codebase) audit;
    // items appended after the baseline (new features/refactor) build in implement mode.
    // Fall back to the global spec mode for legacy queues that predate the field.
    const verifyFirst = feature.verify_first === undefined ? verifyFirstCache.get(workdir) : feature.verify_first === true
    const head = verifyFirst
      ? `You are the coding-agent in VERIFY-FIRST mode (existing codebase). First exercise every mapped Acceptance Check against the EXISTING code at a real external boundary (HTTP or browser). If all pass, set implementation=true and make NO code changes (a zero-diff checkpoint is valid; commit only if you intentionally changed tracked files). If any check fails, fix only the root cause with the smallest possible diff — do not refactor, restructure, or rewrite working code. The bar is "the AC passes at a real boundary," not "the code is idiomatic."\n${base}`
      : `You are the coding-agent. Implement exactly this Work Item, then stop.\n${base}`
    return head +
      `${repairPlan ? `Follow this Repair Plan from the orchestrator:\n${JSON.stringify(repairPlan)}\n` : ''}` +
      `Read the exact queue entry and Workflow Journal. Bring up the app on the assigned ports, run black-box behavior tests, set only this item implementation=true after success, update the journal concisely, and commit. Return one JSON object: {"id":"...","implementation":true|false,"notes":"..."}. ${VERDICT_HINT}`
  }
  if (kind === 'QA') return `You are the qa-agent. Independently test exactly this Work Item in its isolated worktree.\n${base}` +
    `Use a real browser for UI or real HTTP for API behavior. On pass set qa=true. On any defect set implementation=false and qa=false. Update the journal concisely and commit. Return only JSON: {"id":"...","qa":true|false,"implementation":true|false,"defects":["expected ...; observed ...; evidence ..."]}. ${VERDICT_HINT}`
  if (kind === 'INTEGRATION_QA') return `You are the qa-agent performing Integrated Verification on latest main.\n${base}` +
    `Run the mapped Acceptance Checks and core smoke behavior at real external boundaries. On pass set integration=true for this Work Item. On any defect set implementation=false, qa=false, integration=false. Update the journal concisely and commit. Return only JSON: {"id":"...","integration":true|false,"implementation":true|false,"defects":["expected ...; observed ...; evidence ..."]}. ${VERDICT_HINT}`
  if (kind === 'REPAIR_PLAN') return `Act as the orchestrator repair planner. Do not modify files. Diagnose the QA Defect Report against the Work Item and repository.\n${base}` +
    `Defect Report=${JSON.stringify(repairPlan)}\nReturn only concise JSON: {"summary":"...","rootCause":"...","actions":["..."],"validation":["..."]}. ${VERDICT_HINT}`
  if (kind === 'MERGE') return `You are resolving integration conflicts for one verified Checkpoint.\n${base}` +
    `Resolve only the current Git conflicts. Keep Work Items append-only; a newer Defect Report overrides older true flags. Run affected black-box checks, commit, and return only JSON: {"resolved":true|false,"notes":"..."}. ${VERDICT_HINT}`
}

async function block(feature, attempt, reason, defects = []) {
  await stopApp(options.workdir)
  const queue = await updateFeature(options.workdir, feature.id, {
    implementation: false, qa: false, integration: false, retries: Math.max(Number(feature.retries || 0), attempt),
  })
  const file = await journal(options.workdir, 'Blocked Work Item', {
    Attempt: `${attempt}/${MAX_ATTEMPTS}`, WorkItem: feature.id, Outcome: reason, Defects: defects,
    NextAction: 'User reviews evidence and explicitly resumes with guidance',
  })
  commitPaths(options.workdir, [file, join(options.workdir, 'feature_list.json')], `chore(harness): block ${feature.id}`)
  await writeState({ status: 'blocked', phase: 'blocked', currentFeatureId: feature.id, attempt, lastResult: reason, nextAction: 'user-guidance', childPid: null })
  command('bash', [claimScript, 'block', options.repo, feature.context], options.repo)
  return { id: queue.id, status: 'blocked', reason, defects }
}

async function planRepair(feature, attempt, defectReport) {
  await writeState({ phase: 'repair-plan', nextAction: 'repair-plan', defectReport })
  const planned = await runAgent('REPAIR_PLAN', featurePrompt('REPAIR_PLAN', feature, attempt, defectReport), feature.id, attempt)
  const plan = planned.parsed || { summary: 'Repair planning did not return structured JSON', rootCause: 'unknown', actions: [planned.detail.slice(-2000)], validation: [] }
  const file = await journal(options.workdir, 'QA defect and Repair Plan', {
    Attempt: `${attempt}/${MAX_ATTEMPTS}`, WorkItem: feature.id,
    DefectReport: defectReport.defects || defectReport.detail,
    RepairPlan: [plan.summary, ...(plan.actions || [])], Evidence: defectReport.evidence,
    NextAction: `Coding Attempt ${attempt + 1}`,
  })
  await updateFeature(options.workdir, feature.id, { implementation: false, qa: false, integration: false, retries: attempt })
  commitPaths(options.workdir, [file, join(options.workdir, 'feature_list.json')], `chore(harness): plan repair for ${feature.id}`)
  await writeState({ repairPlan: plan, nextAction: 'coding', attempt: attempt + 1, lastResult: plan.summary })
  return plan
}

async function acquireMergeLock() {
  // The merge lock is monorepo-wide (git-common-dir), not per-subproject, so
  // running several subprojects' orchestrators concurrently against one repo
  // means every worker across all of them serializes through this one lock.
  // Default budget is generous enough for that; override for slower hosts.
  const tryBudget = Number(process.env.HARNESS_MERGE_LOCK_TRIES || 3600)
  for (let tries = 0; tries < tryBudget; tries++) {
    const result = command('bash', [claimScript, 'merge-acquire', options.repo, String(process.pid)], options.repo, true)
    const output = result.stdout.trim()
    if (result.status === 0 && output && output !== 'BUSY') return output
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
  }
  fail('timed out waiting for merge lock')
}

async function integrate(feature, attempt) {
  await stopApp(options.workdir)
  const journalFile = await journal(options.workdir, 'Checkpoint ready', {
    Attempt: `${attempt}/${MAX_ATTEMPTS}`, WorkItem: feature.id, Outcome: 'isolated QA passed', NextAction: 'Integrated Verification',
  })
  commitPaths(options.workdir, [journalFile], `chore(harness): checkpoint ${feature.id}`)
  const checkpointSha = git(['rev-parse', 'HEAD'], options.workdir).stdout.trim()
  const integrationDir = await acquireMergeLock()
  try {
    await writeState({ phase: 'merge', nextAction: 'merge', integrationDir })
    const merged = command('bash', [claimScript, 'merge-do', options.repo, feature.context, integrationDir], options.repo, true)
    if (merged.status === 2) {
      const resolved = await runAgent('MERGE', featurePrompt('MERGE', feature, attempt, null, integrationDir), feature.id, attempt, integrationDir)
      const unmerged = git(['diff', '--name-only', '--diff-filter=U'], integrationDir).stdout.trim()
      if (unmerged) {
        git(['merge', '--abort'], integrationDir, true)
        return { passed: false, operational: true, defects: ['merge conflict could not be resolved'], evidence: resolved.artifact }
      }
      const mergeHead = git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], integrationDir, true)
      if (mergeHead.status === 0) git(['commit', '--no-edit'], integrationDir)
    } else if (merged.status !== 0) {
      return { passed: false, operational: true, defects: [merged.stderr.trim() || 'merge failed'] }
    }
    if (git(['merge-base', '--is-ancestor', checkpointSha, 'HEAD'], integrationDir, true).status !== 0) {
      git(['merge', '--abort'], integrationDir, true)
      return { passed: false, operational: true, defects: ['Checkpoint was not integrated into main'] }
    }

    await writeState({ phase: 'integration-qa', nextAction: 'integration-qa' })
    const verified = await runAgent('INTEGRATION_QA', featurePrompt('INTEGRATION_QA', feature, attempt, null, integrationDir), feature.id, attempt, integrationDir)
    await stopApp(integrationDir)
    if (verified.ok && verified.parsed?.implementation === true && verified.parsed?.integration === true) {
      await updateFeature(integrationDir, feature.id, { implementation: true, qa: true, integration: true })
    }
    const current = (await readFeatures(integrationDir)).list.find((item) => String(item.id) === String(feature.id))
    if (verified.ok && current?.implementation === true && current?.qa === true && current?.integration === true) {
      const file = await journal(integrationDir, 'Integrated Verification passed', {
        Attempt: `${attempt}/${MAX_ATTEMPTS}`, WorkItem: feature.id, AcceptanceChecks: feature.acceptance_checks || [],
        Outcome: 'passed on integrated main', Evidence: verified.artifact, NextAction: 'next Ready Work Item',
      })
      commitPaths(integrationDir, [join(integrationDir, 'feature_list.json'), file], `verify(harness): integrate ${feature.id}`)
      git(['merge', '--no-edit', 'main'], options.workdir)
      await writeState({ phase: 'integrated', nextAction: 'next-work-item', lastResult: 'Integrated Verification passed' })
      return { passed: true }
    }

    const defects = verified.parsed?.defects?.length ? verified.parsed.defects : [verified.detail.slice(-2000) || 'Integrated Verification failed']
    await updateFeature(integrationDir, feature.id, { implementation: false, qa: false, integration: false, retries: attempt })
    const file = await journal(integrationDir, 'Integrated Verification defect', {
      Attempt: `${attempt}/${MAX_ATTEMPTS}`, WorkItem: feature.id, Defects: defects, Evidence: verified.artifact, NextAction: 'Repair Plan',
    })
    commitPaths(integrationDir, [join(integrationDir, 'feature_list.json'), file], `qa(${feature.context}): ${feature.id} integration defect`)
    git(['merge', '--no-edit', 'main'], options.workdir)
    return { passed: false, defects, evidence: verified.artifact }
  } finally {
    command('bash', [claimScript, 'merge-release', options.repo, String(process.pid)], options.repo, true)
  }
}

async function runWorkItems() {
  if (!wanted.length) fail('--features is required outside goal-review mode')
  command(process.execPath, [reconcileScript, options.workdir, '--check'], options.workdir)
  const initialState = await readJson(stateFile, {})
  state = initialState
  if (initialState.status === 'blocked' && !options.guidance) fail('blocked work requires --guidance for explicit Resume')
  if (initialState.status === 'blocked') {
    const id = initialState.currentFeatureId || wanted[0]
    await updateFeature(options.workdir, id, { implementation: false, qa: false, integration: false, retries: 0 })
    const file = await journal(options.workdir, 'Explicit Resume', {
      WorkItem: id, Outcome: 'user authorized a new Attempt cycle', Guidance: options.guidance, NextAction: 'Coding Attempt 1',
    })
    commitPaths(options.workdir, [file, join(options.workdir, 'feature_list.json')], `chore(harness): resume ${id} with guidance`)
    state = {
      ...initialState, phase: 'resume', attempt: 1, nextAction: 'coding',
      repairPlan: { summary: 'User guidance', rootCause: 'user-directed', actions: [options.guidance], validation: [] },
    }
  } else if (initialState.status === 'resuming' || initialState.status === 'interrupted') {
    const file = await journal(options.workdir, 'Resumed', {
      WorkItem: initialState.currentFeatureId || wanted[0], PreviousPhase: initialState.previousPhase || initialState.phase,
      Attempt: initialState.attempt, NextAction: initialState.nextAction,
    })
    commitPaths(options.workdir, [file], `chore(harness): resume ${context}`)
  }
  await writeState({ status: 'running', phase: state.phase || 'starting', nextAction: state.nextAction || 'coding', featureIds: wanted })
  heartbeatTimer = setInterval(() => writeState().catch(() => {}), 15_000)
  verifyFirstCache.set(options.workdir, await isVerifyFirst(options.workdir))
  const initial = await readFeatures()
  const selected = wanted.map((id) => initial.list.find((feature) => String(feature.id) === id))
  if (selected.some((feature) => !feature)) fail(`unknown Work Item id in --features: ${wanted.join(',')}`)
  const results = []

  for (const original of selected) {
    let current = (await readFeatures()).list.find((item) => String(item.id) === String(original.id))
    if (current.integration === true) { results.push({ id: current.id, status: 'passed' }); continue }
    // Read strikes and sort candidate lists ONCE per Work Item — stable within the item so only the attempt offset switches coders.
    itemPlan = buildPlan(await readRoles())
    const resumingCurrent = String(state.currentFeatureId) === String(current.id)
    let attempt = resumingCurrent ? Number(state.attempt || current.retries + 1 || 1) : Number(current.retries || 0) + 1
    let repairPlan = resumingCurrent ? state.repairPlan : null
    let operationalFailures = 0

    if (attempt > MAX_ATTEMPTS) { results.push(await block(current, MAX_ATTEMPTS, 'Attempt budget already exhausted')); break }
    if (resumingCurrent && state.nextAction === 'repair-plan' && state.defectReport) {
      repairPlan = await planRepair(current, attempt, state.defectReport)
      attempt++
    }
    while (attempt <= MAX_ATTEMPTS) {
      current = (await readFeatures()).list.find((item) => String(item.id) === String(original.id))
      if (current.implementation !== true) {
        await writeState({ currentFeatureId: current.id, attempt, nextAction: 'coding', repairPlan })
        const coded = await runAgent('CODING', featurePrompt('CODING', current, attempt, repairPlan), current.id, attempt)
        if (coded.ok && coded.parsed?.implementation === true) {
          await updateFeature(options.workdir, current.id, { implementation: true })
          commitPaths(options.workdir, [join(options.workdir, 'feature_list.json')], `chore(harness): record coding ${current.id}`)
        }
        current = (await readFeatures()).list.find((item) => String(item.id) === String(original.id))
        // An explicit decline (agent ran fine, said implementation:false) is not an operational failure and
        // does not consume an Attempt: it advances the coder offset so the next candidate is asked instead.
        if (coded.ok && coded.parsed?.implementation === false) {
          const declineEvidence = [coded.parsed.notes || coded.detail]
          if (!itemPlan) { results.push(await block(current, attempt, 'coding agent declined the Work Item', declineEvidence)); break }
          itemPlan.coderDeclines = (itemPlan.coderDeclines || 0) + 1
          const poolSize = itemPlan.sortedRoles.coding.length + (itemPlan.roles.noCredits?.length || 0)
          if (Math.floor((attempt - 1) / Number(process.env.HARNESS_REPAIR_BUDGET || 2)) + itemPlan.coderDeclines >= poolSize) {
            results.push(await block(current, attempt, 'every coding candidate declined the Work Item', declineEvidence)); break
          }
          continue
        }
        if (!coded.ok || current.implementation !== true) {
          operationalFailures++
          if (operationalFailures >= MAX_OPERATIONAL_FAILURES) { results.push(await block(current, attempt, 'coding agent failed three times', [coded.detail])); break }
          continue
        }
        operationalFailures = 0
        await writeState({ appPid: await appPid(options.workdir) })
      }

      if (current.qa !== true) {
        await writeState({ nextAction: 'qa', phase: 'qa' })
        const checked = await runAgent('QA', featurePrompt('QA', current, attempt), current.id, attempt)
        if (checked.ok && checked.parsed?.implementation === true && checked.parsed?.qa === true) {
          await updateFeature(options.workdir, current.id, { implementation: true, qa: true })
          commitPaths(options.workdir, [join(options.workdir, 'feature_list.json')], `chore(harness): record QA ${current.id}`)
          const coder = itemPlan && lastCoder()
          if (coder) bumpStrike('quality', `quality|coding|${coder}`, -1)
        }
        current = (await readFeatures()).list.find((item) => String(item.id) === String(original.id))
        if (!checked.ok && !checked.parsed) {
          operationalFailures++
          if (operationalFailures >= MAX_OPERATIONAL_FAILURES) { results.push(await block(current, attempt, 'QA agent failed three times', [checked.detail])); break }
          continue
        }
        operationalFailures = 0
        await writeState({ appPid: await appPid(options.workdir) })
        if (current.implementation !== true || current.qa !== true) {
          const defectReport = {
            defects: checked.parsed?.defects?.length ? checked.parsed.defects : [checked.detail.slice(-2000) || 'QA failed'],
            evidence: checked.artifact,
          }
          await writeState({ phase: 'qa-defect', nextAction: 'repair-plan', defectReport, attempt })
          if (attempt >= MAX_ATTEMPTS) { results.push(await block(current, attempt, 'QA failed after Attempt 3', defectReport.defects)); break }
          const coder = itemPlan && lastCoder()
          if (coder) bumpStrike('quality', `quality|coding|${coder}`, 1)
          repairPlan = await planRepair(current, attempt, defectReport)
          attempt++
          continue
        }
      }

      const integrated = await integrate(current, attempt)
      if (integrated.passed) { results.push({ id: current.id, status: 'passed' }); break }
      if (integrated.operational) {
        results.push(await block(current, attempt, 'integration could not complete', integrated.defects)); break
      }
      await writeState({
        phase: 'integration-defect', nextAction: 'repair-plan',
        defectReport: { defects: integrated.defects, evidence: integrated.evidence }, attempt,
      })
      if (attempt >= MAX_ATTEMPTS) { results.push(await block(current, attempt, 'Integrated Verification failed after Attempt 3', integrated.defects)); break }
      repairPlan = await planRepair(current, attempt, { defects: integrated.defects, evidence: integrated.evidence })
      attempt++
    }
    if (results.at(-1)?.status === 'blocked') break
  }

  await stopApp(options.workdir)
  clearInterval(heartbeatTimer)
  const stuck = results.filter((result) => result.status === 'blocked')
  await writeState({ status: stuck.length ? 'blocked' : 'complete', phase: stuck.length ? 'blocked' : 'complete', nextAction: stuck.length ? 'user-guidance' : 'release-claim', childPid: null })
  return { total: selected.length, passed: results.filter((result) => result.status === 'passed').length, stuck, results }
}

async function runGoalReviewLocked() {
  command(process.execPath, [reconcileScript, options.workdir, '--check'], options.workdir)
  const { list } = await readFeatures()
  const incomplete = list.filter((item) => item.integration !== true)
  if (incomplete.length) fail(`Goal Review requires every Work Item integrated; incomplete: ${incomplete.map((item) => item.id).join(', ')}`)
  state = await readJson(stateFile, {})
  const dirtyBefore = git(['status', '--porcelain', '--', '.'], options.workdir).stdout.trim()
  if (dirtyBefore) fail('Goal Review requires a clean integrated main checkout')
  const headBefore = git(['rev-parse', 'HEAD'], options.workdir).stdout.trim()
  if (state.status === 'complete' && state.phase === 'complete' && state.reviewedHead === headBefore) {
    return { goal: true, reused: true, summary: state.lastResult, defects: [] }
  }
  await writeState({ status: 'running', phase: 'goal-review', nextAction: 'goal-review', attempt: 1 })
  heartbeatTimer = setInterval(() => writeState().catch(() => {}), 15_000)
  itemPlan = buildPlan(await readRoles())
  const prompt = `You are the independent Goal Review agent. Read project_specs.xml, especially Project Goal and every stable Acceptance Check. On integrated main, exercise every check and cross-feature primary journeys through a real browser or real HTTP. Do not trust existing flags. Do not modify product code. Return only JSON: {"goal":true|false,"summary":"...","acceptanceCheckIds":["AC-..."],"defects":["expected ...; observed ...; evidence ..."]}. ${VERDICT_HINT}`
  const reviewed = await runAgent('GOAL_REVIEW', prompt, 'goal', 1)
  const verdict = reviewed.parsed
  const dirtyAfter = git(['status', '--porcelain', '--', '.'], options.workdir).stdout.trim()
  const headAfter = git(['rev-parse', 'HEAD'], options.workdir).stdout.trim()
  if (dirtyAfter || headAfter !== headBefore) {
    clearInterval(heartbeatTimer)
    await writeState({ status: 'blocked', phase: 'blocked', nextAction: 'user-guidance', lastResult: 'Goal Review agent modified the checkout', childPid: null })
    return { goal: false, blocked: true, defects: [`Goal Review must be read-only; checkout changed: ${dirtyAfter || `${headBefore} -> ${headAfter}`}`] }
  }
  const file = await journal(options.workdir, verdict?.goal === true ? 'Goal Review passed' : 'Goal Review defect', {
    Outcome: verdict?.summary || (reviewed.ok ? 'unstructured verdict' : 'Goal Review agent failed'),
    AcceptanceChecks: verdict?.acceptanceCheckIds || [], Defects: verdict?.defects || [],
    Evidence: reviewed.artifact, NextAction: verdict?.goal === true ? 'Project Goal complete' : 'repair affected Work Items',
  }, 'goal-review')

  if (reviewed.ok && verdict?.goal === true) {
    commitPaths(options.workdir, [file], 'verify(harness): Project Goal complete')
    clearInterval(heartbeatTimer)
    const reviewedHead = git(['rev-parse', 'HEAD'], options.workdir).stdout.trim()
    await writeState({ status: 'complete', phase: 'complete', nextAction: 'none', reviewedHead, lastResult: verdict.summary, childPid: null })
    return { goal: true, summary: verdict.summary, defects: [] }
  }

  const ids = new Set(verdict?.acceptanceCheckIds || [])
  const affected = list.filter((item) => (item.acceptance_checks || []).some((id) => ids.has(id)))
  if (!affected.length) {
    commitPaths(options.workdir, [file], 'chore(harness): block Goal Review')
    clearInterval(heartbeatTimer)
    await writeState({ status: 'blocked', phase: 'blocked', nextAction: 'user-guidance', lastResult: verdict?.summary || reviewed.detail, childPid: null })
    return { goal: false, blocked: true, summary: verdict?.summary, defects: verdict?.defects || [reviewed.detail] }
  }
  const exhausted = affected.filter((item) => Number(item.retries || 0) >= 2)
  if (exhausted.length) {
    commitPaths(options.workdir, [file], 'chore(harness): block exhausted Goal Review defects')
    clearInterval(heartbeatTimer)
    await writeState({
      status: 'blocked', phase: 'blocked', nextAction: 'user-guidance',
      lastResult: `Attempt budget exhausted for ${exhausted.map((item) => item.id).join(', ')}`, childPid: null,
    })
    return { goal: false, blocked: true, exhausted: exhausted.map((item) => item.id), summary: verdict?.summary, defects: verdict?.defects || [] }
  }
  for (const item of affected) {
    await updateFeature(options.workdir, item.id, {
      implementation: false, qa: false, integration: false, retries: Number(item.retries || 0) + 1,
    })
  }
  commitPaths(options.workdir, [join(options.workdir, 'feature_list.json'), file], 'fix(harness): reopen Goal Review defects')
  clearInterval(heartbeatTimer)
  await writeState({ status: 'complete', phase: 'defects-found', nextAction: 'claim-repair-work', lastResult: verdict?.summary, childPid: null })
  return { goal: false, reopened: affected.map((item) => item.id), summary: verdict?.summary, defects: verdict?.defects || [] }
}

async function runGoalReview() {
  const lockedMain = await acquireMergeLock()
  const canonicalLockedMain = realpathSync(lockedMain)
  const canonicalWorkdir = realpathSync(options.workdir)
  if (canonicalLockedMain !== canonicalWorkdir) {
    command('bash', [claimScript, 'merge-release', options.repo, String(process.pid)], options.repo, true)
    fail(`Goal Review must run in the locked main checkout: ${canonicalLockedMain}`)
  }
  try {
    return await runGoalReviewLocked()
  } finally {
    command('bash', [claimScript, 'merge-release', options.repo, String(process.pid)], options.repo, true)
  }
}

const result = options.mode === 'goal-review' ? await runGoalReview() : await runWorkItems()
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
