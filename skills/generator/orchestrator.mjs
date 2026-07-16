#!/usr/bin/env node
import { appendFile, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJson, atomicJson } from './lib/fs-json.mjs'
import { VERDICT_HINT, isProviderQuotaLimited, fallbackReason } from './lib/worker-outcome.mjs'
import { writeDurable } from './lib/worker-result.mjs'
import { cleanupBrowserOrphans } from './lib/browser-cleanup.mjs'
import { cleanupWorktreeRuntime } from './lib/worktree-teardown.mjs'
import { appendOwnedRuntime } from './lib/runtime-manifest.mjs'
import { buildHostCommand, hostCommands, roleNames, runHostAgentSession, terminateHostProcess, hostSpawnVisible } from './adapters/hosts.mjs'
import { integrateCheckpoint } from './lib/integrate-checkpoint.mjs'
import { featurePrompt as buildFeaturePrompt, RESOURCE_CLEANUP_RULE } from './prompts/feature.mjs'
import { integrationBranchName } from './lib/integration-branch.mjs'
import { resolveProjectTopology, runStatePath } from './lib/project-topology.mjs'
import { createWorkflowState } from './lib/workflow-state.mjs'
import { buildPlan, buildCandidates, lastCoder, mkey, bumpStrike } from './lib/route-plan.mjs'
import { blockClaim, mergeAcquire, mergeRelease } from './lib/claim-lease.mjs'
import { requestAdmission, releaseAdmission, defaultGovernorOptions } from './lib/resource-governor.mjs'
import { workItemObservationMethods } from './lib/observation-method.mjs'
import { runAttemptLoop } from './workflow/attempt-machine.mjs'
import { putEvidenceArtifact, newRunId } from './lib/evidence-artifacts.mjs'
import { meaningfulCheckoutDirt } from './lib/checkout-dirt.mjs'
import { goalReviewAdmissible, progressOf } from './lib/completion-contract.mjs'
import { parseProjectSpecification } from './lib/project-specification.mjs'
import {
  filterGoalReviewFlagDrift,
  formatJobsDoneForPrompt,
  incompleteIds,
} from './lib/jobs-done.mjs'

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

const topology = resolveProjectTopology(options.repo)
const commonGit = topology.commonGit
const runDir = topology.runsDir
const context = options.context || 'goal-review'
const projectPrefix = topology.projectPrefix.replace(/\/$/, '')
const projectId = topology.projectId === 'root' ? '' : topology.projectId
const stateFile = runStatePath(topology, context)
const leaseToken = randomUUID()
const runId = newRunId()
let governorReservationId = process.env.HARNESS_GOVERNOR_RESERVATION || null
let child = null
let itemPlan = null
const verifyFirstCache = new Map()
const codingHarnesses = new Map()
let heartbeatTimer

function terminateChild(signal = 'SIGTERM') {
  terminateHostProcess(child, signal)
}

const workflow = createWorkflowState({
  stateFile,
  leaseToken,
  context,
  commonGit,
  projectId,
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

appendOwnedRuntime(options.workdir, {
  kind: 'orchestrator-runtime',
  context,
  port: Number(options.port) || null,
  workdir: options.workdir,
  pids: [],
  shared: false,
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

async function ensureGovernorAdmission() {
  if (process.env.HARNESS_TEST_SKIP_GOVERNOR === '1') return
  if (governorReservationId) {
    const { observeCapacity } = await import('./lib/resource-governor.mjs')
    const observed = await observeCapacity(commonGit, {
      ...defaultGovernorOptions(),
      provider: options.host,
      quotaFile: join(topology.controlRoot, 'quota.json'),
    })
    const held = observed.state?.reservations?.[governorReservationId]
    if (held && held.context === context) return
    governorReservationId = null
  }
  const admission = await requestAdmission(commonGit, {
    projectId: projectId || 'root',
    context,
    provider: options.host,
    resourceClass: options.mode === 'goal-review' ? 'goal-review' : 'coding',
    quotaFile: join(topology.controlRoot, 'quota.json'),
    ...defaultGovernorOptions(),
  })
  if (!admission.granted) {
    fail(`resource governor denied admission (${admission.reason || 'no-capacity'})`)
  }
  governorReservationId = admission.reservation.id
}

async function releaseGovernorAdmission() {
  if (governorReservationId) {
    await releaseAdmission(commonGit, governorReservationId)
    governorReservationId = null
  }
}

function logVisible(message) {
  if (!hostSpawnVisible()) return
  // Herdr panes are for agent work — keep orchestrator chatter to phase lines only.
  if (/^(CODING|QA|INTEGRATION_QA|REPAIR_PLAN|MERGE|GOAL_REVIEW)\b/.test(message)) {
    process.stderr.write(`\n── ${message} ──\n`)
  }
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
  const artifact = await putEvidenceArtifact({
    commonGit,
    projectId: projectId || 'root',
    runId,
    context,
    workItemId: id,
    attempt,
    kind,
    detail,
    route,
  })
  return artifact.path
}

function createAgentOutputRecorder({ minIntervalMs = Number(process.env.HARNESS_AGENT_OUTPUT_WRITE_MS || 2000) } = {}) {
  let lastWriteMs = 0
  let pendingIso = null
  let chain = Promise.resolve()
  const writeAt = (iso) => {
    chain = chain
      .then(() => writeState({ lastAgentOutputAt: iso }))
      .catch(() => {})
    return chain
  }
  return {
    note() {
      const now = Date.now()
      const iso = new Date(now).toISOString()
      pendingIso = iso
      if (!lastWriteMs || now - lastWriteMs >= minIntervalMs) {
        lastWriteMs = now
        pendingIso = null
        writeAt(iso)
      }
    },
    flush() {
      if (!pendingIso) return chain
      const iso = pendingIso
      pendingIso = null
      lastWriteMs = Date.now()
      return writeAt(iso)
    },
  }
}

async function spawnAgent(program, args, cwd) {
  let registered = Promise.resolve()
  const agentOutput = createAgentOutputRecorder()
  const result = await runHostAgentSession({
    program,
    args,
    cwd,
    env: {
      PORT: String(options.port),
      FRONTEND_PORT: String(options.port),
      BACKEND_PORT: String(Number(options.port) + 1000),
    },
    onChildPid: (spawned) => {
      child = spawned
      registered = writeState({ childPid: spawned?.pid || null }).catch((error) => { terminateChild(); fail(error.message) })
    },
    onAgentOutput: () => {
      agentOutput.note()
    },
  })
  await registered
  await agentOutput.flush()
  child = null
  return result
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
  let observationMethods = []
  try {
    const queue = await readJson(join(cwd, 'feature_list.json'), [])
    const feature = (Array.isArray(queue) ? queue : []).find((item) => String(item.id) === String(id))
    if (feature) {
      observationMethods = Array.isArray(feature.observation_methods) && feature.observation_methods.length
        ? feature.observation_methods
        : workItemObservationMethods(feature)
    }
  } catch { /* best-effort */ }
  const { candidates, gateFailure } = buildCandidates({
    plan,
    kind,
    attempt,
    options,
    roleNames,
    codedBy,
    state,
    observationMethods,
  })
  if (!gateFailure.ok) {
    await writeState({ lastResult: gateFailure.reason, childPid: null })
    return { ok: false, detail: gateFailure.reason, parsed: null, observationGateFailure: true }
  }
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
      process.stderr.write(`\n── ${kind} → ${program} attempt ${attempt} ──\n`)
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
  const result = cleanupWorktreeRuntime({ workdir, port: options.port })
  cleanupBrowserOrphans({ port: options.port, workdir })
  if (getState().appPid || result.appPid?.stopped) await writeState({ appPid: null })
}

function featurePrompt(kind, feature, attempt, repairPlan = null, workdir = options.workdir) {
  const observationMethods = Array.isArray(feature.observation_methods) && feature.observation_methods.length
    ? feature.observation_methods
    : (feature.observation_method ? [feature.observation_method] : workItemObservationMethods(feature))
  return buildFeaturePrompt(kind, feature, attempt, repairPlan, workdir, {
    port: options.port,
    getVerifyFirst: (wd) => verifyFirstCache.get(wd),
    integrationBranch: integrationBranchName(options.repo),
    observationMethods,
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
  commitPaths(options.workdir, [file], `chore(harness): block ${feature.id}`)
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
  commitPaths(options.workdir, [file], `chore(harness): plan repair for ${feature.id}`)
  await writeState({ repairPlan: plan, nextAction: 'coding', attempt: attempt + 1, lastResult: plan.summary })
  return plan
}

async function acquireMergeLock() {
  const tryBudget = Number(process.env.HARNESS_MERGE_LOCK_TRIES || 3600)
  const visible = hostSpawnVisible()
  const startedAt = Date.now()
  let lastLog = 0
  for (let tries = 0; tries < tryBudget; tries++) {
    const result = mergeAcquire(options.repo, process.pid)
    if (!result.busy && result.integDir) {
      if (visible) {
        const waitedSec = Math.round((Date.now() - startedAt) / 1000)
        process.stderr.write(
          waitedSec > 0
            ? `orchestrator: merge lock acquired after ${waitedSec}s — starting agent (thinking/tools will stream here)\n`
            : 'orchestrator: merge lock acquired\n',
        )
      }
      return result.integDir
    }
    if (visible && Date.now() - lastLog >= 15_000) {
      const waitedSec = Math.round((Date.now() - startedAt) / 1000)
      const who = result.owner
        ? `holder pid=${result.owner}${result.host ? ` @${result.host}` : ''}`
        : 'another context is integrating'
      process.stderr.write(
        `orchestrator: waiting for merge lock (${who}; waited ${waitedSec}s) — this tab stays idle until that worker finishes integration; watch the holder pane for thinking/tools\n`,
      )
      lastLog = Date.now()
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
  }
  fail('timed out waiting for merge lock')
}

function syncWorkdirWithIntegration(workdir) {
  const branch = integrationBranchName(options.repo)
  const result = git(['merge', '--no-edit', branch], workdir, true)
  if (result.status === 0) return
  // Journal-only conflicts must not leave the worktree lagging the plan
  // feature_list (that re-triggers endless integrate loops).
  const unmerged = git(['diff', '--name-only', '--diff-filter=U'], workdir, true).stdout.trim().split('\n').filter(Boolean)
  const onlyJournals = unmerged.length > 0 && unmerged.every((p) => /(^|\/)harness-progress\//.test(p))
  if (onlyJournals) {
    for (const relPath of unmerged) {
      git(['checkout', '--theirs', '--', relPath], workdir, true)
      git(['add', '--', relPath], workdir, true)
    }
    const mergeHead = git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], workdir, true)
    if (mergeHead.status === 0) git(['commit', '--no-edit'], workdir, true)
    return
  }
  git(['merge', '--abort'], workdir, true)
  // Always pull plan feature_list so integration=true sticks on the worktree.
  git(['checkout', branch, '--', 'feature_list.json'], workdir, true)
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
  return runAttemptLoop({
    wanted,
    options,
    context,
    constants: { MAX_ATTEMPTS, MAX_OPERATIONAL_FAILURES, reconcileScript },
    fail,
    command,
    join,
    state: {
      get: getState,
      set: setState,
      write: writeState,
      readJson,
      stateFile,
      journal,
      commitPaths,
      block,
      setHeartbeatTimer: (timer) => { heartbeatTimer = timer },
      getHeartbeatTimer: () => heartbeatTimer,
    },
    queue: { readFeatures, updateFeature },
    agent: {
      run: runAgent,
      featurePrompt,
      planRepair,
      backoffIfRateLimited,
      lastCoder: () => lastCoder(getState()),
      bumpStrike: bumpStrikeScoped,
      buildPlan: (roles) => buildPlan(options.repo, roles),
      readRoles,
      setItemPlan: (plan) => { itemPlan = plan },
      getItemPlan: () => itemPlan,
    },
    integrate: {
      run: integrate,
      stopApp,
      appPid,
    },
    verifyFirst: {
      cache: verifyFirstCache,
      isVerifyFirst,
    },
  })
}

async function runGoalReviewLocked() {
  command(process.execPath, [reconcileScript, options.workdir, '--check'], options.workdir)
  const { list, ledgerFile } = await readFeatures()
  const ledger = await readJson(ledgerFile, { version: 1, items: {} })
  setState(await readJson(stateFile, {}))
  const dirtyBefore = meaningfulCheckoutDirt(git(['status', '--porcelain', '--', '.'], options.workdir).stdout)
  const headBefore = git(['rev-parse', 'HEAD'], options.workdir).stdout.trim()
  const state = getState()
  let checks = null
  try {
    const specXml = await readFile(join(options.workdir, 'project_specs.xml'), 'utf8')
    checks = parseProjectSpecification(specXml).checks
  } catch { /* counts/catalog fallback when spec unavailable */ }
  const gate = goalReviewAdmissible({
    checks,
    catalog: list,
    ledger,
    integrationHead: headBefore,
    reviewedHead: state.reviewedHead || '',
    cleanCheckout: !dirtyBefore,
    status: state.status || '',
  })
  if (gate.reason === 'already-reviewed-head') {
    return {
      goal: true,
      reused: true,
      summary: state.lastResult || 'Goal Review already satisfied at reviewed head',
      defects: [],
    }
  }
  if (!gate.ok) {
    if (gate.reason === 'dirty-checkout') {
      fail(`Goal Review requires a clean integrated ${integrationBranchName(options.repo)} checkout`)
    }
    if (gate.reason === 'empty-queue') fail('Goal Review requires at least one Work Item')
    if (gate.reason === 'blocked-items') {
      const blocked = list.filter((item) => item.blocked === true)
      fail(`Goal Review blocked by Work Items: ${blocked.map((item) => item.id).join(', ')}`)
    }
    const incomplete = incompleteIds(list, ledger)
    fail(`Goal Review requires every Work Item integrated; incomplete: ${incomplete.join(', ')}`)
  }
  await writeState({ status: 'running', phase: 'goal-review', nextAction: 'goal-review', attempt: 1 })
  heartbeatTimer = setInterval(() => writeState().catch(() => {}), 15_000)
  itemPlan = buildPlan(options.repo, await readRoles())
  const integrationBranch = integrationBranchName(options.repo)
  const guidance = options.guidance ? `\nOperator guidance (follow this when deciding pass vs block):\n${options.guidance}\n` : ''
  const jobsDone = formatJobsDoneForPrompt(list, ledger, { ledgerPath: ledgerFile })
  const prompt = `You are the independent Goal Review agent. Read project_specs.xml, especially Project Goal and every stable Acceptance Check. On integrated ${integrationBranch} (never main/master for in-flight plans), exercise every check and cross-feature primary journeys through a real browser or real HTTP. Do not modify product code. Never commit to main/master.\n${jobsDone}\nDo not trust feature_list.json progress flags for "already done" — use the Execution Ledger (and harness-evidence INTEGRATION_QA verdicts) to detect jobs already completed. Still black-box verify the live compose/HTTP Project Goal; reopen only ACs with proven product/runtime defects, never for flag drift alone.${guidance} ${RESOURCE_CLEANUP_RULE} Return only JSON: {"goal":true|false,"summary":"...","acceptanceCheckIds":["AC-..."],"defects":["expected ...; observed ...; evidence ..."]}. ${VERDICT_HINT}`
  const reviewed = await runAgent('GOAL_REVIEW', prompt, 'goal', 1)
  if (reviewed?.observationGateFailure) {
    clearInterval(heartbeatTimer)
    await writeState({
      status: 'blocked', phase: 'blocked', nextAction: 'user-guidance',
      lastResult: reviewed.detail, childPid: null,
    })
    return { goal: false, blocked: true, defects: [reviewed.detail] }
  }
  let verdict = reviewed.parsed
  if (verdict && verdict.goal !== true) {
    const filtered = filterGoalReviewFlagDrift({
      defects: verdict.defects || [],
      acceptanceCheckIds: verdict.acceptanceCheckIds || [],
      catalog: list,
      ledger,
    })
    verdict = {
      ...verdict,
      defects: filtered.defects,
      acceptanceCheckIds: filtered.acceptanceCheckIds,
    }
    // Flag-drift-only failure must not reopen integrated Work Items or auto-pass.
    // Block and ask for a Goal Review retry that ignores feature_list lag.
    if (filtered.strippedDrift && filtered.defects.length === 0) {
      const summary = `${verdict.summary || 'Goal Review'} [harness: stripped feature_list flag-drift defects; ledger shows full integration — retry Goal Review for compose black-box only]`
      commitPaths(options.workdir, [], 'chore(harness): ignore Goal Review flag-drift')
      clearInterval(heartbeatTimer)
      await writeState({
        status: 'blocked',
        phase: 'blocked',
        nextAction: 'user-guidance',
        lastResult: summary,
        childPid: null,
      })
      return {
        goal: false,
        blocked: true,
        retryGoalReview: true,
        summary,
        defects: [],
        strippedFlagDrift: true,
      }
    }
  }
  const dirtyAfter = meaningfulCheckoutDirt(git(['status', '--porcelain', '--', '.'], options.workdir).stdout)
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
  // Use ledger-aware retries. Only block when every affected WI is exhausted —
  // do not let an all-AC dump (or one burned WI) prevent reopening the rest.
  const retryOf = (item) => Number(progressOf(item, ledger).retries || item.retries || 0)
  const exhausted = affected.filter((item) => retryOf(item) >= 2)
  const actionable = affected.filter((item) => retryOf(item) < 2)
  if (!actionable.length) {
    commitPaths(options.workdir, [file], 'chore(harness): block exhausted Goal Review defects')
    clearInterval(heartbeatTimer)
    await writeState({
      status: 'blocked', phase: 'blocked', nextAction: 'user-guidance',
      lastResult: `Attempt budget exhausted for ${exhausted.map((item) => item.id).join(', ')}`, childPid: null,
    })
    return { goal: false, blocked: true, exhausted: exhausted.map((item) => item.id), summary: verdict?.summary, defects: verdict?.defects || [] }
  }
  for (const item of actionable) {
    await updateFeature(options.workdir, item.id, {
      implementation: false, qa: false, integration: false, retries: retryOf(item) + 1,
    })
  }
  commitPaths(options.workdir, [file], 'fix(harness): reopen Goal Review defects')
  clearInterval(heartbeatTimer)
  await writeState({ status: 'complete', phase: 'defects-found', nextAction: 'claim-repair-work', lastResult: verdict?.summary, childPid: null })
  return {
    goal: false,
    reopened: actionable.map((item) => item.id),
    exhausted: exhausted.length ? exhausted.map((item) => item.id) : undefined,
    summary: verdict?.summary,
    defects: verdict?.defects || [],
  }
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
setState(await readJson(stateFile, {}))
// Clear prior-run agent output timestamps so the supervisor does not treat this
// invocation as already past the MCP warmup budget.
await writeState({ invocationId: runId, lastAgentOutputAt: null })
let result
try {
  await ensureGovernorAdmission()
  result = options.mode === 'goal-review' ? await runGoalReview() : await runWorkItems()
} finally {
  await releaseGovernorAdmission()
}
await writeDurable(stateFile, {
  exitCode: 0,
  leaseToken,
  invocationId: runId,
  reviewedHead: result?.reviewedHead || getState()?.reviewedHead || null,
  payload: { ...result, leaseToken, invocationId: runId },
})
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
