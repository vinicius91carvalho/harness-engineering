#!/usr/bin/env node
import { appendFile, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJson, atomicJson } from './lib/fs-json.mjs'
import { parseObject, VERDICT_HINT, isProviderQuotaLimited, fallbackReason } from './lib/verdict.mjs'
import { writeWorkerResult } from './lib/worker-result.mjs'
import { cleanupBrowserOrphans } from './lib/browser-cleanup.mjs'
import { spawnHostAgent, hostSpawnVisible } from './lib/agent-spawn.mjs'
import { integrateCheckpoint } from './lib/integrate-checkpoint.mjs'
import { buildHostCommand, hostCommands, roleNames } from './adapters/hosts.mjs'
import { featurePrompt as buildFeaturePrompt } from './prompts/feature.mjs'
import { integrationBranchName } from './lib/integration-branch.mjs'
import { createWorkflowState } from './lib/workflow-state.mjs'
import { buildPlan, buildCandidates, lastCoder, mkey, bumpStrike } from './lib/route-plan.mjs'
import { blockClaim, mergeAcquire, mergeRelease } from './lib/claim-lease.mjs'
import { runAttemptLoop } from './workflow/attempt-machine.mjs'

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
if (!['claude', 'codex', 'opencode', 'pi', 'agent'].includes(options.host)) fail('--host must be claude, codex, opencode, pi, or agent')
if (!options.workdir) fail('--workdir is required')

options.workdir = realpathSync(resolve(options.workdir))
options.repo = realpathSync(resolve(options.repo || options.workdir))
const wanted = (options.features || '').split(',').filter(Boolean)
const reconcileScript = resolve(dirname(fileURLToPath(import.meta.url)), 'reconcile.mjs')
const MAX_ATTEMPTS = 3
const MAX_OPERATIONAL_FAILURES = 3
const RATE_LIMIT_BACKOFF_MS = Number(process.env.HARNESS_RATE_LIMIT_BACKOFF_MS || 75_000)
const RATE_LIMIT_JITTER_MS = Number(process.env.HARNESS_RATE_LIMIT_JITTER_MS || 10_000)

async function backoffIfRateLimited(detail) {
  if (!isProviderQuotaLimited(detail)) return
  const hintSeconds = Number(detail.match(/retry_after_seconds"?\s*[:=]\s*"?(\d+(?:\.\d+)?)/)?.[1])
  const baseMs = hintSeconds > 0 ? Math.max(hintSeconds * 1000, RATE_LIMIT_BACKOFF_MS / 3) : RATE_LIMIT_BACKOFF_MS
  const jitterMs = Math.floor(Math.random() * Math.max(0, RATE_LIMIT_JITTER_MS))
  await new Promise((resolveWait) => setTimeout(resolveWait, baseMs + jitterMs))
}

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

const workflow = createWorkflowState({
  stateFile,
  leaseToken,
  context,
  readJson,
  atomicJson,
  hostname,
  process,
  fail,
  dirname,
  join,
  mkdir,
  appendFile,
  writeFile,
  readFile,
  git,
  workdir: options.workdir,
  terminateChild,
})

const {
  writeState,
  writeInterruptedState,
  readFeatures,
  updateFeature,
  journal,
  commitPaths,
  getState,
  setState,
} = workflow

process.on('SIGINT', () => writeInterruptedState('SIGINT'))
process.on('SIGTERM', () => writeInterruptedState('SIGTERM'))

function logVisible(message) {
  if (hostSpawnVisible()) process.stderr.write(`orchestrator: ${message}\n`)
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
    if (!candidate || !['claude', 'codex', 'opencode', 'pi', 'agent'].includes(candidate.harness)) {
      fail(`${file}: ${role} candidates must use claude, codex, opencode, pi, or agent`)
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
  if (Array.isArray(roles.noCredits)) normalized.noCredits = roles.noCredits.map((value) => normalizeCandidate('noCredits', value))
  return normalized
}

function bumpStrikeScoped(scope, key, delta) {
  bumpStrike(options.repo, key, delta)
}

async function recentCodingHarness(id) {
  if (codingHarnesses.has(String(id))) return codingHarnesses.get(String(id))
  const state = getState()
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

async function evidence(id, attempt, kind, detail, route = null) {
  const dir = join(runDir, 'evidence', context.replace(/[^a-zA-Z0-9_-]/g, '_'))
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${String(id).replace(/[^a-zA-Z0-9_-]/g, '_')}-${attempt}-${kind.toLowerCase()}.log`)
  const header = route ? `route=${JSON.stringify(route)}\n` : ''
  await writeFile(file, `${header}${detail}`)
  return file
}

async function spawnAgent(program, args, cwd) {
  const visible = hostSpawnVisible()
  return await new Promise((resolveRun) => {
    child = spawnHostAgent(program, args, {
      cwd,
      env: {
        PORT: String(options.port),
        FRONTEND_PORT: String(options.port),
        BACKEND_PORT: String(Number(options.port) + 1000),
      },
      visible,
    })
    let stdout = '', stderr = '', timedOut = false, settled = false
    const finish = (result) => { if (!settled) { settled = true; child = null; resolveRun(result) } }
    const registered = writeState({ childPid: child.pid || null }).catch((error) => { terminateChild(); fail(error.message) })
    child.stdout?.on('data', (data) => {
      stdout = `${stdout}${data}`.slice(-1_000_000)
      if (visible) {
        const text = String(data)
        if (!/^BUSY\n?$/.test(text.trim())) process.stdout.write(data)
      }
    })
    child.stderr?.on('data', (data) => {
      stderr = `${stderr}${data}`.slice(-1_000_000)
      if (visible) process.stderr.write(data)
    })
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
  const state = getState()
  const codedBy = await recentCodingHarness(id) || [...(state.routeHistory || [])].reverse()
    .find((entry) => entry.kind === 'CODING' && String(entry.id) === String(id) && entry.outcome === 'selected')?.harness
  const candidates = buildCandidates({
    plan,
    kind,
    attempt,
    options,
    roleNames,
    codedBy,
    state,
  })
  const failures = []
  for (const candidate of candidates) {
    const independence = direct ? 'direct-host' : ['QA', 'INTEGRATION_QA', 'GOAL_REVIEW'].includes(kind)
      ? (candidate.harness === (codedBy || roles?.coding[0].harness) ? 'same-harness-fallback' : 'independent-harness')
      : 'not-applicable'
    const route = {
      adapter: direct ? 'direct' : 'roles', kind, id: String(id), harness: candidate.harness,
      model: candidate.model || null, fallbackReason: failures.at(-1)?.reason || (!direct && independence === 'same-harness-fallback' ? 'no-different-harness-available' : null),
      independence,
    }
    const [program, args] = direct
      ? hostCommands[candidate.harness](referencedPrompt)
      : buildHostCommand(candidate.harness, referencedPrompt, candidate.model)
    if (hostSpawnVisible()) {
      process.stderr.write(`orchestrator: ${kind} → ${program} attempt ${attempt}\n`)
    }
    await writeState({ agentRoute: route, childPid: null })
    const result = await spawnAgent(program, args, cwd)
    const reason = !direct && !result.ok ? fallbackReason(result) : null
    if (reason) bumpStrikeScoped('infra', `infra|${mkey(candidate.harness, candidate.model)}`, 1)
    if (!direct && !result.ok && candidates.indexOf(candidate) < candidates.length - 1) {
      failures.push({ harness: candidate.harness, model: candidate.model || null, reason, detail: result.detail.slice(-1000) })
      const nextHistory = [...(getState().routeHistory || []), { ...route, outcome: 'fallback', fallbackReason: reason }]
      setState({ ...getState(), routeHistory: nextHistory })
      await writeState({ routeHistory: nextHistory, lastResult: `${candidate.harness}: ${reason}`, childPid: null })
      continue
    }
    const selected = { ...route, outcome: result.ok ? 'selected' : 'failed' }
    const routeHistory = [...(getState().routeHistory || []), selected]
    setState({ ...getState(), routeHistory })
    if (kind === 'CODING' && result.ok) codingHarnesses.set(String(id), candidate.harness)
    if (!direct && result.ok) bumpStrikeScoped('infra', `infra|${mkey(candidate.harness, candidate.model)}`, -1)
    const diagnostic = `${failures.length ? `fallbacks=${JSON.stringify(failures)}\n` : ''}${result.parsed ? `${JSON.stringify(result.parsed, null, 2)}\n` : `${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ''}`.slice(-16_000)}`
    const artifact = await evidence(id, attempt, kind, diagnostic, selected)
    await writeState({ childPid: null, evidence: artifact, agentRoute: selected, routeHistory })
    cleanupBrowserOrphans({ port: options.port, workdir: cwd })
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
  if (!pid) { if (getState().appPid) await writeState({ appPid: null }); return }
  try { process.kill(pid, 'SIGTERM') } catch {}
  try { await unlink(pidFile) } catch {}
  cleanupBrowserOrphans({ port: options.port, workdir })
  await writeState({ appPid: null })
}

function featurePrompt(kind, feature, attempt, repairPlan = null, workdir = options.workdir) {
  return buildFeaturePrompt(kind, feature, attempt, repairPlan, workdir, {
    port: options.port,
    getVerifyFirst: (wd) => verifyFirstCache.get(wd),
    integrationBranch: integrationBranchName(options.repo),
  })
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
  blockClaim(options.repo, feature.context)
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
  const tryBudget = Number(process.env.HARNESS_MERGE_LOCK_TRIES || 3600)
  const visible = hostSpawnVisible()
  let lastLog = 0
  for (let tries = 0; tries < tryBudget; tries++) {
    const result = mergeAcquire(options.repo, process.pid)
    if (!result.busy && result.integDir) {
      if (visible) process.stderr.write('orchestrator: merge lock acquired\n')
      return result.integDir
    }
    if (visible && Date.now() - lastLog >= 10_000) {
      process.stderr.write('orchestrator: waiting for merge lock (another context is integrating)…\n')
      lastLog = Date.now()
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
  }
  fail('timed out waiting for merge lock')
}

function syncWorkdirWithIntegration(workdir) {
  const branch = integrationBranchName(options.repo)
  const result = git(['merge', '--no-edit', branch], workdir, true)
  if (result.status !== 0) git(['merge', '--abort'], workdir, true)
}

async function integrate(feature, attempt) {
  return integrateCheckpoint({
    feature,
    attempt,
    workdir: options.workdir,
    repo: options.repo,
    maxAttempts: MAX_ATTEMPTS,
    git,
    runAgent,
    featurePrompt,
    stopApp,
    journal,
    commitPaths,
    updateFeature,
    readFeatures,
    writeState,
    syncWorkdirWithIntegration,
    join,
    acquireMergeLock,
  })
}

async function runWorkItems() {
  logVisible(`build context=${context} host=${options.host} port=${options.port} features=${wanted.join(',') || 'all'}`)
  if (hostSpawnVisible()) {
    process.stderr.write(
      `orchestrator: workdir=${options.workdir}\n`,
    )
  }
  return runAttemptLoop({
    wanted,
    options,
    getState,
    setState,
    stateFile,
    reconcileScript,
    MAX_ATTEMPTS,
    MAX_OPERATIONAL_FAILURES,
    fail,
    command,
    readJson,
    readFeatures,
    updateFeature,
    journal,
    commitPaths,
    writeState,
    verifyFirstCache,
    isVerifyFirst,
    buildPlan: (roles) => buildPlan(options.repo, roles),
    readRoles,
    block,
    planRepair,
    integrate,
    runAgent,
    featurePrompt,
    stopApp,
    join,
    context,
    setHeartbeatTimer: (timer) => { heartbeatTimer = timer },
    getHeartbeatTimer: () => heartbeatTimer,
    setItemPlan: (plan) => { itemPlan = plan },
    getItemPlan: () => itemPlan,
    lastCoder: () => lastCoder(getState()),
    bumpStrike: bumpStrikeScoped,
    backoffIfRateLimited,
    appPid,
  })
}

async function runGoalReviewLocked() {
  command(process.execPath, [reconcileScript, options.workdir, '--check'], options.workdir)
  const { list } = await readFeatures()
  const incomplete = list.filter((item) => item.integration !== true)
  if (incomplete.length) fail(`Goal Review requires every Work Item integrated; incomplete: ${incomplete.map((item) => item.id).join(', ')}`)
  setState(await readJson(stateFile, {}))
  const dirtyBefore = git(['status', '--porcelain', '--', '.'], options.workdir).stdout.trim()
  if (dirtyBefore) fail(`Goal Review requires a clean integrated ${integrationBranchName(options.repo)} checkout`)
  const headBefore = git(['rev-parse', 'HEAD'], options.workdir).stdout.trim()
  const state = getState()
  if (state.status === 'complete' && state.phase === 'complete' && state.reviewedHead === headBefore) {
    return { goal: true, reused: true, summary: state.lastResult, defects: [] }
  }
  await writeState({ status: 'running', phase: 'goal-review', nextAction: 'goal-review', attempt: 1 })
  heartbeatTimer = setInterval(() => writeState().catch(() => {}), 15_000)
  itemPlan = buildPlan(options.repo, await readRoles())
  const integrationBranch = integrationBranchName(options.repo)
  const prompt = `You are the independent Goal Review agent. Read project_specs.xml, especially Project Goal and every stable Acceptance Check. On integrated ${integrationBranch} (never main/master for in-flight plans), exercise every check and cross-feature primary journeys through a real browser or real HTTP. Do not trust existing flags. Do not modify product code. Never commit to main/master. Return only JSON: {"goal":true|false,"summary":"...","acceptanceCheckIds":["AC-..."],"defects":["expected ...; observed ...; evidence ..."]}. ${VERDICT_HINT}`
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
  logVisible(`goal-review context=${context} host=${options.host} port=${options.port}`)
  const lockedMain = await acquireMergeLock()
  const canonicalLockedMain = realpathSync(lockedMain)
  const canonicalWorkdir = realpathSync(options.workdir)
  if (canonicalLockedMain !== canonicalWorkdir) {
    mergeRelease(options.repo, process.pid)
    fail(`Goal Review must run in the locked integration checkout (${integrationBranchName(options.repo)}): ${canonicalLockedMain}`)
  }
  try {
    return await runGoalReviewLocked()
  } finally {
    mergeRelease(options.repo, process.pid)
  }
}

logVisible(`started pid=${process.pid} workdir=${options.workdir}`)
const result = options.mode === 'goal-review' ? await runGoalReview() : await runWorkItems()
await writeWorkerResult(stateFile, { exitCode: 0, payload: result })
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
