#!/usr/bin/env node
import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { watch } from 'node:fs'
import { createWriteStream, existsSync, unlinkSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { hostname } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import {
  resolveGeneratorDir,
  tickFailureDelay,
} from '../lib/runtime-layout.mjs'

const commandName = process.argv[2]
const rawArgs = process.argv.slice(3)
const options = {}
for (let i = 0; i < rawArgs.length; i += 2) {
  const key = rawArgs[i], value = rawArgs[i + 1]
  if (!key?.startsWith('--') || value === undefined) fatal(`invalid argument: ${key || ''}`)
  options[key.slice(2)] = value
}
if (!commandName) fatal('usage: harness-control.mjs {start|run|status|fleet-snapshot|capacity|events|ack|respond|quota|pause|resume|stop|kill-supervisor|release-supervisor-lock|kill-worker|release-lease|clear-dead-lock|preflight|remediate} --repo <path> ...')

const scriptFile = fileURLToPath(import.meta.url)
const supervisorLib = resolve(dirname(scriptFile), '..', 'lib')
const repo = resolve(options.repo || '.')
const generatorDir = resolveGeneratorDir(scriptFile, options['generator-dir'] || null)
const libDir = join(generatorDir, 'lib')
/** Control Plane modules live only under skills/supervisor/lib. */
const CONTROL_MODULES = new Set([
  'control-journal.mjs',
  'control-beacon.mjs',
  'fleet-snapshot.mjs',
  'supervisor-tick.mjs',
  'supervisor-admission.mjs',
  'wake-triage.mjs',
  'supervisor-lease.mjs',
  'resource-governor.mjs',
  'host-resources.mjs',
  'host-remediation.mjs',
  'anomaly-detect.mjs',
  'representative-brief.mjs',
  'orphan-claims.mjs',
  'runtime-view.mjs',
  'supervisor-preflight.mjs',
  'runtime-layout.mjs',
])
/** Load control modules from supervisor/lib; shared execution primitives from generator/lib. */
async function importLib(name) {
  if (CONTROL_MODULES.has(name)) {
    const fromSupervisor = join(supervisorLib, name)
    if (!existsSync(fromSupervisor)) {
      throw new Error(`control module missing: ${fromSupervisor} (expected skills/supervisor/lib/${name})`)
    }
    return import(pathToFileURL(fromSupervisor).href)
  }
  const fromGenerator = join(libDir, name)
  if (!existsSync(fromGenerator)) {
    throw new Error(`generator module missing: ${fromGenerator} (expected skills/generator/lib/${name})`)
  }
  return import(pathToFileURL(fromGenerator).href)
}
const { readJson, atomicJson } = await importLib('fs-json.mjs')
const { isProviderQuotaLimited } = await importLib('worker-outcome.mjs')
const { readFeatureListFromIntegration } = await importLib('git-repo.mjs')
const {
  isLiveRunOwner,
  classifyRunStateHealth,
  abandonGhostRun,
  listGhostClaims,
  countLiveClaims,
  processAlive,
} = await importLib('orphan-claims.mjs')
const { scopeClaims, runStateFile: runStatePath } = await importLib('project-keys.mjs')
const { resolveProjectTopology } = await importLib('project-topology.mjs')
const { cleanupWorktreeRuntime } = await importLib('worktree-teardown.mjs')
const { acquireComposeShare } = await importLib('compose-shared.mjs')
const {
  readDurable,
  interpretClosed,
  isWorkerStuck,
  isWorkerStuckByHealth,
  stuckThresholdMs,
} = await importLib('worker-outcome.mjs')
const { planWorkerClosedActions, shouldEnqueueStuckWorkerRetry, planAutoRetryResponses } = await importLib('failure-policy.mjs')
const { enrichGuidanceWithEvidence } = await importLib('evidence-guidance.mjs')
const {
  buildOrchestratorArgv,
  buildWorkerBase,
  workerLogFileName,
  planWorkerStop,
  planWorkerCleanupTargets,
  terminateProcessTree,
  processGroupForWorker,
  cleanupBrowserOrphans,
} = await importLib('worker-lifecycle.mjs')
const { drainRetryQueue, applyRetryResumeOutcome, shouldFinalizePendingGoal, nextTickDelay, tickWatchPaths } = await importLib('supervisor-tick.mjs')
const {
  planTickAdmission,
  goalReviewGate,
  pruneOrphanPendingInputs,
  isCrashBoundContext,
} = await importLib('supervisor-admission.mjs')
const { isCheckoutCleanForGoalReview } = await importLib('checkout-dirt.mjs')
const { selectClaim, resumeClaim, releaseClaim, mergeLockHolder, clearDeadLock, clearStaleGeneratorLocks } = await importLib('claim-lease.mjs')
const { integrationBranchName, integrationBranchRef } = await importLib('integration-branch.mjs')
const { ledgerPath, readLedger, applyLedgerToCatalog } = await importLib('execution-ledger.mjs')
const { catalogFullyIntegrated } = await importLib('completion-contract.mjs')
const { observeCapacity, pruneDeadReservations, releaseAdmission } = await importLib('resource-governor.mjs')
const { evidenceGuidanceExcerpt } = await importLib('evidence-guidance.mjs')
const { readHostResources } = await importLib('host-resources.mjs')
const { composeShareSnapshot } = await importLib('compose-shared.mjs')
const {
  fleetSnapshotFromState,
  isEmptyFleetActionable,
  buildFleetSnapshot,
  planRuntimeRecovery,
  shouldEmitEmptyFleet,
} = await importLib('fleet-snapshot.mjs')
const {
  planHostRemediation,
  indexLockInfo,
  shouldEscalateRemediation,
  escalationReason,
  remainingWorkFromProject,
  REMEDIATION_ESCALATE_AFTER,
} = await importLib('host-remediation.mjs')
const {
  planNeverStarted,
  planCrashLoop,
  planSpawnFailed,
  DEFAULT_NEVER_STARTED_MS,
  DEFAULT_CRASH_LOOP_WINDOW_MS,
  DEFAULT_CRASH_LOOP_THRESHOLD,
} = await importLib('anomaly-detect.mjs')
const { runSupervisorPreflight } = await import(pathToFileURL(join(supervisorLib, 'supervisor-preflight.mjs')).href)
const orchestrator = join(generatorDir, 'orchestrator.mjs')
const reconciler = join(generatorDir, 'reconcile.mjs')

async function executePreflight({ repair = true, config = null } = {}) {
  const cfg = config || baseConfig()
  return runSupervisorPreflight({
    repo,
    commonGit,
    projectId,
    projectPrefix,
    stateFile,
    reconciler,
    repair,
    nodeExecPath: process.execPath,
    capacityOptions: governorOptions(cfg),
    deps: {
      pruneDeadReservations,
      observeCapacity,
      evidenceGuidanceExcerpt,
    },
  })
}

function fatal(message, code = 2) {
  process.stderr.write(`harness-control: ${message}\n`)
  process.exit(code)
}

function exec(program, args, cwd = repo, allowFailure = false) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8' })
  if (!allowFailure && result.status !== 0) fatal((result.stderr || result.stdout || result.error?.message || `${program} failed`).trim())
  return result
}

function git(args, allowFailure = false) { return exec('git', args, repo, allowFailure) }

function gitIn(cwd, args, allowFailure = false) { return exec('git', args, cwd, allowFailure) }

const topology = resolveProjectTopology(repo)
const commonGit = topology.commonGit
const projectPrefix = topology.projectPrefix.replace(/\/$/, '')
const projectId = topology.projectId
const root = topology.controlRoot

async function queueWithLedger() {
  const catalog = readFeatureListFromIntegration(repo) ?? []
  const ledger = await readLedger(ledgerPath(commonGit, projectId === 'root' ? '' : projectId))
  return applyLedgerToCatalog(catalog, ledger)
}

function goalReviewStateFile() {
  const goalStateName = projectPrefix ? `${projectId}--goal-review.json` : 'goal-review.json'
  return join(commonGit, 'harness-runs', goalStateName)
}

async function readGoalReviewLedger() {
  return readLedger(ledgerPath(commonGit, projectId === 'root' ? '' : projectId))
}

async function goalReviewContext() {
  const goalState = await readJson(goalReviewStateFile(), {})
  const head = git(['rev-parse', integrationBranchName(repo)], true).stdout.trim()
  const clean = isCheckoutCleanForGoalReview(git(['status', '--porcelain'], true).stdout)
  const ledger = await readGoalReviewLedger()
  return { goalState, head, clean, ledger }
}

async function fleetForWakeTriage(state, { ghostClaims = null, events = null } = {}) {
  let ghosts = ghostClaims
  if (!ghosts) ghosts = await listProjectGhostClaims()
  const journalEvents = events ?? await readEvents()
  let liveClaimWorkers = 0
  try {
    const claims = await ownClaims()
    const runStatesByContext = {}
    for (const [key, claim] of Object.entries(claims)) {
      const context = claim.context || key
      runStatesByContext[context] = await readJson(runStateFile(context), {})
    }
    liveClaimWorkers = countLiveClaims({ claims, runStatesByContext, processAlive })
  } catch { /* best-effort */ }
  const extras = {
    ghostClaims: ghosts,
    events: journalEvents,
    liveClaimWorkers,
    hostResources: readHostResources(),
    sharedRuntime: composeShareSnapshot(commonGit),
    recoveryReasons: recoveryReasonsFromFleet({ state, ghostClaims: ghosts }),
    supervisorLive: deriveSupervisorLiveForState(state),
    localHost: hostname(),
    leaseSeconds: Math.max(10, number('supervisor-lease-seconds', 30)),
  }
  try {
    const queue = await queueWithLedger()
    const { goalState, head } = await goalReviewContext()
    return fleetSnapshotFromState(state, {
      ...extras,
      queueComplete: catalogFullyIntegrated(queue),
      integrationHead: head,
      reviewedHead: goalState.reviewedHead || '',
      goalReviewStatus: goalState.status || '',
      retryGoalReview: Boolean(state.retryQueue?.['goal-review']),
    })
  } catch {
    return fleetSnapshotFromState(state, extras)
  }
}

function deriveSupervisorLiveForState(state = {}) {
  const heartbeatAge = Math.floor(Date.now() / 1000) - Number(state.heartbeatEpoch || 0)
  const leaseSeconds = Math.max(10, number('supervisor-lease-seconds', 30))
  const localLive = state.supervisorHost === hostname() && processAlive(state.supervisorPid)
  const remoteLive = state.supervisorHost && state.supervisorHost !== hostname()
    && (state.supervisorPid || state.status === 'starting') && heartbeatAge < leaseSeconds
  return Boolean(localLive || remoteLive)
}

function recoveryReasonsFromFleet({ state = {}, ghostClaims = [] } = {}) {
  const reasons = []
  for (const ghost of ghostClaims || []) {
    reasons.push({
      kind: 'ghost_claim',
      context: ghost.context,
      action: 'abandon_and_readmit',
      safety: 'same runtime health classifier',
      reason: ghost.health?.reason || 'runtime no longer live',
    })
  }
  if (state.capacity?.pressureReason) {
    reasons.push({
      kind: 'capacity_zero',
      action: 'defer_admission',
      safety: 'resource governor',
      reason: state.capacity.pressureReason,
    })
  }
  if (state.retryQueue?.['goal-review']) {
    reasons.push({
      kind: 'goal_review_stale',
      context: 'goal-review',
      action: 'retry_goal_review',
      safety: 'completion contract',
      reason: 'goal-review retry queued',
    })
  }
  return reasons
}

async function loadRunStatesByContext(contexts) {
  const runStatesByContext = {}
  await Promise.all([...new Set(contexts.filter(Boolean))].map(async (context) => {
    runStatesByContext[context] = await readJson(runStateFile(context), {})
  }))
  return runStatesByContext
}

async function listProjectGhostClaims() {
  const claims = await ownClaims()
  const contexts = Object.entries(claims).map(([key, claim]) => claim.context || key)
  const runStatesByContext = await loadRunStatesByContext(contexts)
  return listGhostClaims({ claims, runStatesByContext, processAlive })
}

async function readProjectRoles() {
  try {
    return await readJson(join(repo, '.harness', 'roles.json'), null)
  } catch {
    return null
  }
}

async function observationMethodsForWorker({ mode, phase, featureIds = [] }) {
  const { workItemObservationMethods, observationMethodsForQueue } = await importLib('observation-method.mjs')
  const queue = await queueWithLedger()
  if (mode === 'goal-review') return observationMethodsForQueue(queue)
  const id = featureIds?.[0]
  if (!id) return ['grep']
  const item = queue.find((row) => String(row.id) === String(id))
  if (!item) return ['grep']
  if (Array.isArray(item.observation_methods) && item.observation_methods.length) {
    return item.observation_methods
  }
  return workItemObservationMethods(item)
}
const stateFile = join(root, 'state.json')
const eventFile = join(root, 'events.jsonl')
const responseDir = join(root, 'responses')
const cursorDir = join(root, 'cursors')
const quotaFile = join(root, 'quota.json')
const controlFile = join(root, 'control.json')
const logDir = join(root, 'logs')
const supervisorLog = join(root, 'supervisor.log')
const supervisorLock = join(root, 'supervisor.lock')

// generator-claims.json lives under commonGit (the shared .git of the whole
// monorepo, not this subproject alone) so every sibling subproject's claims
// sit in the same file, namespaced by claim.sh's own `<projectId>--<context>`
// key convention. Reading it unfiltered makes every subproject's supervisor
// process every OTHER subproject's claims too -- ghost input_required events
// under the wrong runId, and `blocked` counts that are a monorepo-wide total
// mislabeled as this subproject's own. Scope to this subproject's own keys.
async function ownClaims() {
  return scopeClaims(await readJson(join(commonGit, 'generator-claims.json'), {}), projectPrefix)
}

function runStateFile(context) {
  return runStatePath(commonGit, projectPrefix, context)
}

async function readEvents() {
  const { readControlEvents } = await importLib('control-journal.mjs')
  try {
    return await readControlEvents(root, eventFile)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    if (error?.code === 'CONTROL_JOURNAL_CORRUPT') fatal(error.message)
    fatal(`cannot read control events: ${error.message}`)
  }
}

function consumerFile() {
  const consumer = options.consumer || ''
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(consumer)) fatal('--consumer must contain 1-64 letters, digits, underscores, or hyphens')
  return join(cursorDir, `${consumer}.json`)
}

function governorOptions(config) {
  return {
    maxWorkers: config.maxWorkers,
    quotaWorkers: config.quotaWorkers,
    cpuPerWorker: config.cpuPerWorker,
    memoryPerWorkerMb: config.memoryPerWorkerMb,
    reserveMemoryMb: config.reserveMemoryMb,
    maxLoadRatio: config.maxLoadRatio,
    maxSwapUsedRatio: config.maxSwapUsedRatio,
    quotaFile,
    provider: config.host || 'default',
  }
}

async function acquireSupervisorLock(token, pid, status, leaseSeconds) {
  const { acquireSupervisorLease } = await importLib('supervisor-lease.mjs')
  try {
    return await acquireSupervisorLease(root, { token, pid, status, leaseSeconds })
  } catch (error) {
    if (error?.code === 'SUPERVISOR_LEASE_HELD') fatal(error.message)
    throw error
  }
}

async function updateSupervisorLock(token, fenceGeneration, status = 'running', pid = process.pid) {
  const { updateSupervisorLease } = await importLib('supervisor-lease.mjs')
  try {
    return await updateSupervisorLease(root, {
      token,
      fenceGeneration,
      pid,
      status,
      leaseSeconds: Math.max(10, number('supervisor-lease-seconds', 30)),
    })
  } catch (error) {
    if (error?.code === 'SUPERVISOR_LEASE_STALE' && status !== 'stopping') {
      return acquireSupervisorLock(token, pid, status, Math.max(10, number('supervisor-lease-seconds', 30)))
    }
    throw error
  }
}

async function releaseSupervisorLock(token) {
  const { releaseSupervisorLease } = await importLib('supervisor-lease.mjs')
  await releaseSupervisorLease(root, token)
}

function number(name, fallback) {
  const value = Number(options[name] ?? process.env[`HARNESS_${name.replaceAll('-', '_').toUpperCase()}`] ?? fallback)
  return Number.isFinite(value) ? value : fallback
}

function workerHost() {
  if (options.host) return options.host
  for (const host of ['codex', 'claude', 'opencode', 'pi', 'agent']) {
    if (exec('sh', ['-c', `command -v ${host}`], repo, true).status === 0) return host
  }
  fatal('no worker host found; pass --host claude|codex|opencode|pi|agent')
}

function capacityConfig({ requireHost = false } = {}) {
  return {
    host: requireHost ? workerHost() : (options.host || 'default'),
    maxWorkers: Math.max(1, Math.floor(number('max-workers', 4))),
    quotaWorkers: Math.max(0, Math.floor(number('quota-workers', 2))),
    cpuPerWorker: Math.max(0.25, number('cpu-per-worker', 2)),
    // Default 1GB/worker; allow explicit low values for tests / tiny hosts (floor 1MB).
    memoryPerWorkerMb: Math.max(1, number('memory-per-worker-mb', 1024)),
    reserveMemoryMb: Math.max(0, number('reserve-memory-mb', 1024)),
    maxLoadRatio: Math.max(0.1, number('max-load-ratio', 0.85)),
    maxSwapUsedRatio: Math.max(0.01, number('max-swap-used-ratio', 0.2)),
    quotaCooldownSeconds: Math.max(1, number('quota-cooldown-seconds', 300)),
    summaryMinutes: Math.max(1, number('summary-minutes', 20)),
    stuckTimeoutMs: Math.max(60_000, number('stuck-timeout-ms', stuckThresholdMs())),
    pollMs: Math.max(250, number('poll-ms', 2000)),
    supervisorLeaseSeconds: Math.max(10, number('supervisor-lease-seconds', 30)),
  }
}

function baseConfig() {
  return capacityConfig({ requireHost: true })
}

async function capacity(config, active = 0) {
  const { observeCapacity } = await importLib('resource-governor.mjs')
  const observed = await observeCapacity(commonGit, governorOptions(config))
  const localAvailable = Math.max(0, observed.limit - active)
  return {
    ...observed,
    active,
    available: Math.min(observed.available, localAvailable),
    slots: Math.min(observed.slots, localAvailable),
  }
}

function resourceClassForContext(context, phase = '') {
  if (context === 'goal-review') return 'goal-review'
  if (/browser|integration_qa|goal/i.test(phase)) return 'browser'
  if (/http|qa/i.test(phase)) return 'http'
  return 'coding'
}

async function integrationCheckout() {
  const branchRef = integrationBranchRef(repo)
  const branch = integrationBranchName(repo)
  const lines = git(['worktree', 'list', '--porcelain']).stdout.split('\n')
  let worktree = ''
  for (const line of lines) {
    if (line.startsWith('worktree ')) worktree = line.slice(9)
    if (line === `branch ${branchRef}`) return projectPrefix ? join(worktree, projectPrefix) : worktree
  }
  fatal(`${branch} must be checked out in a worktree (set .harness/integration-branch or HARNESS_INTEGRATION_BRANCH)`)
}

class Supervisor {
  constructor(config) {
    this.config = config
    this.leaseToken = process.env.HARNESS_SUPERVISOR_TOKEN || randomUUID()
    this.fenceGeneration = 1
    this.state = null
    this.workers = new Map()
    this.stopping = false
    this.lastSummary = 0
    this.lastEmptyFleetEmit = null
    this.finalizing = new Set()
    this.pendingGoalResult = null
    this.tickDirty = false
    this.tickWatchers = []
    this.wakeTick = null
    this.lastJournalCompactAt = 0
  }

  lease() {
    return { token: this.leaseToken, fenceGeneration: this.fenceGeneration }
  }

  startTickWatchers() {
    if (this.tickWatchers.length || options.once === 'true') return
    for (const path of tickWatchPaths({ controlRoot: root, runsDir: join(commonGit, 'harness-runs'), commonGit })) {
      try {
        const watcher = watch(path, { persistent: false }, () => {
          this.tickDirty = true
          if (this.wakeTick) this.wakeTick()
        })
        this.tickWatchers.push(watcher)
      } catch {}
    }
  }

  stopTickWatchers() {
    for (const watcher of this.tickWatchers) {
      try { watcher.close() } catch {}
    }
    this.tickWatchers = []
  }

  async waitForNextTick(delay) {
    if (delay <= 0) return
    await new Promise((resolve) => {
      const timer = setTimeout(done, delay)
      const previous = this.wakeTick
      this.wakeTick = done
      function done() {
        clearTimeout(timer)
        resolve()
      }
      if (previous) previous()
    })
    this.wakeTick = null
  }

  async refreshLease(status = 'running', pid = process.pid) {
    const refreshed = await updateSupervisorLock(this.leaseToken, this.fenceGeneration, status, pid)
    if (refreshed?.fenceGeneration) this.fenceGeneration = refreshed.fenceGeneration
  }

  // A worker's 'close' event fires whenever the OS schedules it, independent of the tick/run
  // loop. Track its settling promise so shutdown can wait for it: otherwise releaseSupervisorLock
  // can delete the lease directory while this in-flight handler's own save() is still using it,
  // and updateSupervisorLock finds the lease gone and fatals mid-write.
  trackClose(promise) {
    this.finalizing.add(promise)
    promise.finally(() => this.finalizing.delete(promise))
  }

  async drainFinalizers() {
    while (this.finalizing.size) await Promise.allSettled([...this.finalizing])
  }

  async save(change = {}) {
    this.state = {
      ...this.state,
      ...change,
      supervisorPid: this.stopping ? null : process.pid,
      supervisorHost: hostname(),
      heartbeat: new Date().toISOString(),
      heartbeatEpoch: Math.floor(Date.now() / 1000),
      workers: Object.fromEntries([...this.workers].map(([key, worker]) => [key, {
        pid: worker.child?.pid || worker.childPid || worker.pid || null,
        type: 'background',
        context: worker.context, featureIds: worker.featureIds,
        worktree: worker.worktree, port: worker.port, logFile: worker.logFile, startedAt: worker.startedAt,
      }])),
    }
    await atomicJson(stateFile, this.state)
    await this.refreshLease(this.stopping ? 'stopping' : this.state.status)
  }

  async emit(kind, data = {}, immediate = false) {
    const { appendControlEvent } = await importLib('control-journal.mjs')
    const event = await appendControlEvent(root, {
      runId: this.state.runId,
      kind,
      immediate,
      ...data,
    }, this.lease())
    return event
  }

  async requestWorkerAdmission(context) {
    if (process.env.HARNESS_TEST_SKIP_GOVERNOR === '1') return { granted: true, reservation: { id: null } }
    const { requestAdmission } = await importLib('resource-governor.mjs')
    const runState = await readJson(runStateFile(context), {})
    return requestAdmission(commonGit, {
      projectId: projectId || 'root',
      context,
      resourceClass: resourceClassForContext(context, runState.phase || runState.status || ''),
      ...governorOptions(this.config),
    })
  }

  async releaseWorkerAdmission(reservationId) {
    if (!reservationId) return
    const { releaseAdmission } = await importLib('resource-governor.mjs')
    await releaseAdmission(commonGit, reservationId)
  }

  applyWorkerStop(worker, signal = 'SIGTERM') {
    const plan = planWorkerStop(worker, { signal })
    if (plan.kind === 'terminate_tree') {
      terminateProcessTree(plan.pid, plan.signal)
    }
    return plan
  }

  cleanupWorkerResources(worker) {
    if (!worker) return { browsers: { killed: 0 }, runtime: null }
    const targets = planWorkerCleanupTargets(worker)
    return {
      browsers: cleanupBrowserOrphans(targets),
      runtime: cleanupWorktreeRuntime(targets),
    }
  }

  async startWorkerRuntime({
    claim,
    guidance = '',
    mode = 'work-items',
    startedEvent,
    quotaTestTail = null,
    phase = 'coding',
  }) {
    const key = claim.context
    if (this.workers.has(key)) return false
    const {
      validationKindFromAdmission,
      observationAdmissionCheck,
    } = await importLib('observation-method.mjs')
    const validationKind = validationKindFromAdmission({ mode, phase })
    if (validationKind) {
      const roles = await readProjectRoles()
      const observationMethods = await observationMethodsForWorker({
        mode,
        phase,
        featureIds: claim.featureIds || [],
      })
      const gate = observationAdmissionCheck({
        kind: validationKind,
        roles,
        observationMethods,
        host: this.config.host,
      })
      if (!gate.ok) {
        const scope = mode === 'goal-review' ? 'goal' : 'context'
        await this.input(scope, gate.reason, {
          kind: validationKind,
          observationMethods,
          phase,
          mode,
        }, scope === 'context' ? key : null)
        return false
      }
    }
    const admission = await this.requestWorkerAdmission(key)
    if (!admission.granted) return false
    // Propagate the supervisor reservation id AND the same capacity knobs so the
    // orchestrator does not re-admit under stricter defaultGovernorOptions (1024MB).
    const governorEnv = {
      HARNESS_MAX_WORKERS: String(this.config.maxWorkers),
      HARNESS_QUOTA_WORKERS: String(this.config.quotaWorkers),
      HARNESS_CPU_PER_WORKER: String(this.config.cpuPerWorker),
      HARNESS_MEMORY_PER_WORKER_MB: String(this.config.memoryPerWorkerMb),
      HARNESS_RESERVE_MEMORY_MB: String(this.config.reserveMemoryMb),
      HARNESS_MAX_LOAD_RATIO: String(this.config.maxLoadRatio),
      ...(admission.reservation?.id
        ? { HARNESS_GOVERNOR_RESERVATION: admission.reservation.id }
        : {}),
    }
    const logFile = join(logDir, workerLogFileName(key))
    const argv = buildOrchestratorArgv({
      orchestrator,
      repo,
      host: this.config.host,
      claim,
      guidance,
      mode,
    })
    const workerBase = buildWorkerBase({
      claim,
      logFile,
      reservationId: admission.reservation?.id || null,
    })
    workerBase.commonGit = commonGit
    workerBase.projectId = projectId || 'root'
    workerBase.ownedResources = {
      ...(workerBase.ownedResources || {}),
      commonGit,
      projectId: projectId || 'root',
      context: claim.context,
    }
    // Shared compose infra lease — sibling workers reuse postgres/redis/hindsight
    // instead of each bringing a full stack (RAM exhaustion on small hosts).
    try {
      acquireComposeShare(commonGit, projectId || 'root', claim.context)
    } catch { /* best-effort; teardown still works without a lease */ }

    if (quotaTestTail != null) {
      await mkdir(logDir, { recursive: true })
      await writeFile(logFile, quotaTestTail)
      this.workers.set(key, {
        type: 'background', child: null, log: null,
        ...workerBase,
      })
      await this.emit(startedEvent || 'worker_started', { context: claim.context, featureIds: claim.featureIds, pid: null })
      await this.save()
      await this.trackClose(this.workerClosed(key, 1, quotaTestTail).catch((error) => this.crash(error)))
      return true
    }

    const child = spawn(process.execPath, argv, {
      cwd: claim.worktree,
      env: { ...process.env, ...governorEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    if (child.pid) {
      workerBase.ownedResources.processGroup = child.pid
      workerBase.childPid = child.pid
    } else {
      const spawnFail = planSpawnFailed({ context: key, pid: child.pid })
      if (spawnFail.emit) {
        await this.emit(spawnFail.kind, spawnFail.detail, true)
      }
      await this.releaseWorkerAdmission(admission.reservation?.id)
      return false
    }
    const log = createWriteStream(logFile, { flags: 'w' })
    let tail = ''
    const collect = (chunk) => { const text = String(chunk); log.write(text); tail = `${tail}${text}`.slice(-64_000) }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    child.on('error', (error) => collect(`${error.stack || error.message}\n`))
    this.workers.set(key, { type: 'background', child, log, ...workerBase })
    const eventPayload = startedEvent === 'goal_review_started'
      ? {}
      : { context: claim.context, featureIds: claim.featureIds, pid: child.pid }
    await this.emit(startedEvent || 'worker_started', eventPayload)
    // Clear prior never-started / crash-loop emit flags for a fresh spawn.
    if (this.state.anomalyEmitted?.[key]) {
      const next = { ...(this.state.anomalyEmitted || {}) }
      delete next[key]
      this.state.anomalyEmitted = next
    }
    await this.save()
    child.on('close', (code) => this.trackClose(this.workerClosed(key, code, tail).catch((error) => this.crash(error))))
    return true
  }

  async input(scope, reason, detail, context = null, choices = ['retry', 'pause', 'abort']) {
    const existing = Object.values(this.state.pendingInputs || {}).find((item) => item.status === 'pending' && item.scope === scope && item.context === context && item.reason === reason)
    if (existing) return existing
    const enrichedDetail = { ...(detail || {}) }
    const guidanceExcerpt = enrichGuidanceWithEvidence('', enrichedDetail)
    if (guidanceExcerpt) enrichedDetail.guidanceExcerpt = guidanceExcerpt
    const event = await this.emit('input_required', { scope, context, reason, detail: enrichedDetail, choices }, true)
    this.state.pendingInputs ||= {}
    this.state.pendingInputs[event.id] = { ...event, status: 'pending' }
    await this.save({ status: scope === 'goal' ? 'needs_input' : this.state.status })
    return event
  }

  async initialize() {
    await mkdir(root, { recursive: true })
    if (!existsSync(eventFile)) await writeFile(eventFile, '')
    await mkdir(responseDir, { recursive: true })
    await mkdir(logDir, { recursive: true })
    const previous = await readJson(stateFile, {})
    const heartbeatAge = Math.floor(Date.now() / 1000) - Number(previous.heartbeatEpoch || 0)
    const localLive = previous.supervisorHost === hostname() && processAlive(previous.supervisorPid)
    const remoteLive = previous.supervisorHost && previous.supervisorHost !== hostname()
      && (previous.supervisorPid || previous.status === 'starting') && heartbeatAge < this.config.supervisorLeaseSeconds
    if (previous.supervisorPid !== process.pid && (localLive || remoteLive)) {
      fatal(`supervisor already running on ${previous.supervisorHost} as pid ${previous.supervisorPid}`)
    }
    const acquired = await acquireSupervisorLock(this.leaseToken, process.pid, 'running', this.config.supervisorLeaseSeconds)
    this.fenceGeneration = acquired?.fenceGeneration || 1
    const control = await readJson(controlFile, {})
    const paused = previous.status === 'paused' && control.status !== 'running'
    const goalPending = Object.values(previous.pendingInputs || {}).some((item) => item.status === 'pending' && item.scope === 'goal')
    let status = goalPending ? 'needs_input' : paused ? 'paused' : 'running'
    // Keep an already-complete Goal Review as complete when the integration head is unchanged.
    // Otherwise a one-tick --once run demotes complete→running and can leave status non-complete.
    if (!goalPending && !paused && previous.status === 'complete') {
      const goalStateName = projectPrefix ? `${projectId}--goal-review.json` : 'goal-review.json'
      const goalState = await readJson(join(commonGit, 'harness-runs', goalStateName), {})
      const head = git(['rev-parse', integrationBranchName(repo)], true).stdout.trim()
      const clean = isCheckoutCleanForGoalReview(git(['status', '--porcelain'], true).stdout)
      if (goalState.status === 'complete' && goalState.reviewedHead === head && clean) status = 'complete'
    }
    this.state = {
      ...previous,
      runId: previous.runId || randomUUID(),
      repo,
      config: this.config,
      status,
      pendingInputs: previous.pendingInputs || {},
      retryQueue: previous.retryQueue || {},
      startedAt: previous.startedAt || new Date().toISOString(),
    }
    await this.save()
    if (!previous.startedAt) await this.emit('run_started', { host: this.config.host, config: this.config })
    // First-invocation / restart preflight: clear ghosts before admission.
    const preflight = await executePreflight({ repair: true, config: this.config })
    this.state = await readJson(stateFile, this.state)
    await this.emit('supervisor_preflight', {
      ok: preflight.ok,
      reconcileOk: preflight.reconcileOk,
      actions: preflight.actions,
      warnings: preflight.warnings,
      blockers: preflight.blockers,
      capacityAvailable: preflight.capacity?.available ?? preflight.capacity?.slots ?? null,
    }, !preflight.ok)
    if (!preflight.ok) {
      const reason = preflight.blockers.map((b) => b.message || b.kind).join('; ') || 'preflight failed'
      await this.input('goal', 'Planning or reconciliation required', { preflight, error: reason }, null, ['amend', 'abort'])
      this.stopping = true
      await this.save({ status: 'needs_input' })
      return
    }
  }

  async snapshot() {
    const queue = await queueWithLedger()
    const claims = await ownClaims()
    const counts = { total: queue.length, implemented: 0, qa: 0, integrated: 0, blocked: 0 }
    for (const item of queue) {
      if (item.implementation === true) counts.implemented++
      if (item.qa === true) counts.qa++
      if (item.integration === true) counts.integrated++
    }
    counts.blocked = Object.values(claims).filter((claim) => claim.status === 'blocked').length
    return { counts, claims: Object.values(claims).map((claim) => claim.context), queue }
  }

  // Drop orphaned pending Input Requests: context-scoped events whose context no
  // longer maps to a live claim for this subproject, is not queued for retry, and
  // has no active worker. These are residue -- cross-subproject contexts parked
  // here before claims were scoped per-subproject (the ownClaims fix), or contexts
  // whose work completed and released its claim, leaving a stale blocked/"could not
  // resume" event that clutters status and never clears (no response action deletes
  // one). A genuinely blocked item always keeps a status:'blocked' claim, so it is
  // never pruned and inspectClaims still re-raises it below; goal-scoped events
  // (real human decisions) are never pruned.
  pruneOrphanPending(claims) {
    const { pendingInputs, pruned } = pruneOrphanPendingInputs(this.state.pendingInputs, {
      claims,
      retryQueue: this.state.retryQueue,
      workerContexts: this.workers,
    })
    this.state.pendingInputs = pendingInputs
    return pruned
  }

  async inspectClaims(runStates = null, claims = null) {
    claims = claims || await ownClaims()
    if (this.pruneOrphanPending(claims)) await this.save()
    let external = 0
    const recoverable = []
    for (const [claimKey, claim] of Object.entries(claims)) {
      const context = claim.context || claimKey
      if (this.workers.has(context)) continue
      const runState = runStates?.[context] ?? await readJson(runStateFile(context), {})
      if (this.state.retryQueue?.[context]) continue
      // A worker that crashes before ever reaching a recognizable result (e.g. reconcile.mjs
      // choking on a corrupted feature_list.json in its own worktree) never sets claim/runState
      // status to 'blocked' -- so without this check it re-qualifies as recoverable on literally
      // every tick, forever, monopolizing this subproject's capacity slots on a context that can
      // never succeed. Mirror retryQueue's 5-attempt bound: once workerClosed's crashCounts for
      // this context hits it, stop auto-resuming and leave the last-raised input_required as the
      // terminal signal, same as an exhausted retryQueue entry.
      if (isCrashBoundContext(context, this.state.crashCounts)) continue
      if (claim.status === 'blocked' || runState.status === 'blocked') {
        await this.input('context', runState.lastResult || 'Work Item blocked', { nextAction: runState.nextAction, attempt: runState.attempt, evidence: runState.evidence }, context)
      } else if (runState.ownerHost && runState.ownerHost !== hostname()) {
        const leaseSeconds = Math.max(1, number('lease-timeout-seconds', 60))
        const age = Math.floor(Date.now() / 1000) - Number(runState.heartbeatEpoch || 0)
        if (age < leaseSeconds) external++
        else await this.input('context', 'Claim Lease is stale on another host', {
          ownerHost: runState.ownerHost, heartbeat: runState.heartbeat, ageSeconds: age,
          nextAction: 'Confirm retry to take over the stale Claim Lease',
        }, context)
      } else if (isLiveRunOwner(runState, processAlive)) {
        external++
      } else {
        recoverable.push({ context, claim, runState })
      }
    }
    return { external, recoverable }
  }

  async resumeClaim(context, force = 'auto', guidance = '') {
    const claim = resumeClaim(repo, context, process.pid, force)
    if (claim) await this.spawnWorker(claim, guidance)
    return Boolean(claim)
  }

  async claim() {
    return selectClaim(repo, 'all', '', process.pid)
  }

  async spawnWorker(claim, guidance = '') {
    const key = claim.context
    const runState = await readJson(runStateFile(key), {})
    if (process.env.HARNESS_TEST_SUPERVISOR_QUOTA === '1') {
      const quotaTail = "ERROR: You've hit your usage limit. Try again at Jul 9th, 2026 12:17 AM.\n"
      return this.startWorkerRuntime({
        claim,
        guidance,
        quotaTestTail: quotaTail,
        phase: runState.phase || 'coding',
      })
    }
    return this.startWorkerRuntime({
      claim,
      guidance,
      phase: runState.phase || 'coding',
    })
  }

  async completeGoal(result) {
    this.pendingGoalResult = null
    await this.emit('run_completed', { summary: result.summary }, true)
    // Mark stopping before save so supervisorPid is cleared in the complete snapshot.
    this.stopping = true
    await this.save({ status: 'complete', completedAt: new Date().toISOString() })
  }

  async inspectStuckWorkers(runStates = null) {
    const lock = mergeLockHolder(repo)
    const lockAlive = lock.busy && lock.owner ? processAlive(Number(lock.owner)) : false
    const healthByContext = {}

    for (const [key, worker] of [...this.workers]) {
      const runState = runStates?.[key] ?? await readJson(runStateFile(key), {})
      const stuck = await isWorkerStuck({
        logFile: worker.logFile,
        runState,
        thresholdMs: this.config.stuckTimeoutMs,
      })
      const health = stuck
        ? { verdict: 'stuck', reason: 'log/heartbeat stale', recycle: true }
        : { verdict: 'healthy', reason: 'log/heartbeat fresh', recycle: false }

      healthByContext[key] = {
        ...health,
        phase: runState.phase || null,
        childPid: runState.childPid || null,
        lastAgentOutputAt: runState.lastAgentOutputAt || null,
      }

      const prevHealth = this.state.workerHealth?.[key]
      if (!prevHealth || prevHealth.verdict !== health.verdict || prevHealth.reason !== health.reason) {
        await this.emit('worker_health', { context: key, ...health }, health.verdict === 'stuck')
      }

      if (!isWorkerStuckByHealth(health)) continue

      await this.emit('worker_stuck', {
        context: key,
        logFile: worker.logFile,
        phase: runState.phase,
        health,
      }, true)
      this.applyWorkerStop(worker, 'SIGTERM')
      setTimeout(() => this.applyWorkerStop(worker, 'SIGKILL'), 5000)
      if (shouldEnqueueStuckWorkerRetry(health)) {
        this.state.retryQueue ||= {}
        this.state.retryQueue[key] = {
          guidance: health.reason
            || 'Supervisor detected a stuck worker with no recent agent output; resume after confirming the worktree is healthy',
          attempts: this.state.retryQueue[key]?.attempts || 0,
        }
      }
      await this.save()
    }

    await this.inspectNeverStartedWorkers(runStates)
    await this.inspectExternalStuckClaims(runStates, healthByContext)

    const mergeInfo = lock.busy
      ? { owner: lock.owner || null, host: lock.host || null, holderAlive: lockAlive }
      : null
    await this.save({
      workerHealth: healthByContext,
      mergeLock: mergeInfo,
    })
  }

  /**
   * External Claim Leases (generator orchestrators not in state.workers) still
   * need stuck recycle — otherwise a silent agent can hold the fleet forever
   * while orchestrator heartbeats look healthy.
   */
  async inspectExternalStuckClaims(runStates = null, healthByContext = {}) {
    const claims = await ownClaims()
    let changed = false
    for (const [claimKey, claim] of Object.entries(claims)) {
      const key = claim.context || claimKey
      if (this.workers.has(key)) continue
      const runState = runStates?.[key] ?? await readJson(runStateFile(key), {})
      if (!isLiveRunOwner(runState, processAlive)) continue
      const logFile = join(logDir, workerLogFileName(key))
      // Prefer newest matching log if named with timestamp suffix.
      let resolvedLog = logFile
      try {
        const { readdirSync } = await import('node:fs')
        const names = readdirSync(logDir)
          .filter((n) => n.startsWith(`${key}-`) && n.endsWith('.log'))
          .sort()
        if (names.length) resolvedLog = join(logDir, names.at(-1))
      } catch { /* use default */ }
      const stuck = await isWorkerStuck({
        logFile: resolvedLog,
        runState,
        thresholdMs: this.config.stuckTimeoutMs,
      })
      const health = stuck
        ? { verdict: 'stuck', reason: 'external agent silent (empty log / no lastAgentOutputAt)', recycle: true }
        : { verdict: 'healthy', reason: 'external live claim', recycle: false }
      healthByContext[key] = {
        ...health,
        phase: runState.phase || null,
        childPid: runState.childPid || null,
        lastAgentOutputAt: runState.lastAgentOutputAt || null,
        external: true,
      }
      if (!isWorkerStuckByHealth(health)) continue
      await this.emit('worker_stuck', {
        context: key,
        logFile: resolvedLog,
        phase: runState.phase,
        health,
        external: true,
      }, true)
      for (const pid of [runState.ownerPid, runState.childPid]) {
        if (!processAlive(pid)) continue
        try { process.kill(Number(pid), 'SIGTERM') } catch { /* ignore */ }
      }
      setTimeout(() => {
        for (const pid of [runState.ownerPid, runState.childPid]) {
          if (!processAlive(pid)) continue
          try { process.kill(Number(pid), 'SIGKILL') } catch { /* ignore */ }
        }
      }, 5000)
      if (shouldEnqueueStuckWorkerRetry(health)) {
        this.state.retryQueue ||= {}
        this.state.retryQueue[key] = {
          guidance: health.reason
            || 'Supervisor recycled a silent external worker; resume after confirming the worktree is healthy',
          attempts: this.state.retryQueue[key]?.attempts || 0,
        }
      }
      changed = true
    }
    if (changed) await this.save()
  }

  /**
   * Zero-token: admitted workers with no live Run State / pid past deadline
   * emit worker_never_started (Wake Triage → Control Host).
   */
  async inspectNeverStartedWorkers(runStates = null) {
    const deadlineMs = Math.max(
      5_000,
      number('never-started-ms', DEFAULT_NEVER_STARTED_MS),
    )
    let changed = false
    this.state.anomalyEmitted ||= {}
    for (const [key, worker] of [...this.workers]) {
      if (this.state.anomalyEmitted[key]?.neverStarted) continue
      const runState = runStates?.[key] ?? await readJson(runStateFile(key), {})
      const plan = planNeverStarted({
        context: key,
        startedAt: worker.startedAt,
        runState,
        workerPid: worker.childPid || worker.pid || worker.child?.pid || null,
        now: Date.now(),
        deadlineMs,
        processAlive,
      })
      if (!plan.emit) continue
      await this.emit(plan.kind, plan.detail, true)
      this.state.anomalyEmitted[key] = {
        ...(this.state.anomalyEmitted[key] || {}),
        neverStarted: true,
        at: new Date().toISOString(),
      }
      changed = true
    }
    if (changed) await this.save()
  }

  async finalizeWorkerRecord(key, worker) {
    this.workers.delete(key)
    this.cleanupWorkerResources(worker)
  }

  /**
   * Sliding-window crash / start-stop flap detector. Emits worker_crash_loop
   * once per window so Control Host wakes without per-exit LLM cost.
   */
  async recordWorkerExitAnomaly(key, exitCode) {
    const windowMs = Math.max(
      10_000,
      number('crash-loop-window-ms', DEFAULT_CRASH_LOOP_WINDOW_MS),
    )
    const threshold = Math.max(
      2,
      number('crash-loop-threshold', DEFAULT_CRASH_LOOP_THRESHOLD),
    )
    this.state.anomalyExits ||= {}
    this.state.anomalyEmitted ||= {}
    const prior = this.state.anomalyExits[key] || []
    const already = Boolean(this.state.anomalyEmitted[key]?.crashLoop)
    const plan = planCrashLoop({
      context: key,
      recentExits: prior,
      exitAt: Date.now(),
      windowMs,
      threshold,
      alreadyEmitted: already,
    })
    this.state.anomalyExits[key] = plan.recentExits
    if (plan.emit) {
      await this.emit(plan.kind, {
        ...plan.detail,
        exitCode: exitCode == null ? null : Number(exitCode),
      }, true)
      this.state.anomalyEmitted[key] = {
        ...(this.state.anomalyEmitted[key] || {}),
        crashLoop: true,
        at: new Date().toISOString(),
      }
    }
    await this.save()
  }

  async workerClosed(key, code, capturedTail) {
    const worker = this.workers.get(key)
    if (!worker) return
    await this.releaseWorkerAdmission(worker.governorReservationId)
    // Track exits for crash-loop detection (zero-token Wake Triage).
    if (!this.stopping) {
      await this.recordWorkerExitAnomaly(key, code)
    }
    if (this.stopping) {
      if (worker.log) {
        await new Promise((done) => { worker.log.once('finish', done); worker.log.end() })
      }
      this.workers.delete(key)
      this.cleanupWorkerResources(worker)
      return
    }
    if (worker.log) {
      await new Promise((done) => { worker.log.once('finish', done); worker.log.end() })
    }
    let tail = capturedTail
    try { tail = (await readFile(worker.logFile, 'utf8')).slice(-64_000) || tail } catch {}
    const runState = await readJson(runStateFile(key), {})
    const persisted = await readDurable(runStateFile(key), {
      expectedLeaseToken: runState.leaseToken || null,
      expectedReviewedHead: runState.reviewedHead || null,
      expectedInvocationId: runState.invocationId || null,
    })
    const queue = await queueWithLedger()
    const integrationHead = key === 'goal-review'
      ? git(['rev-parse', integrationBranchName(repo)], true).stdout.trim()
      : null
    const result = interpretClosed({
      key,
      exitCode: code,
      tail,
      persisted,
      runState,
      featureIds: worker.featureIds,
      queue,
      integrationHead,
    })
    const plan = planWorkerClosedActions({
      key,
      exitCode: code,
      tail,
      result,
      rateLimited: isProviderQuotaLimited(tail),
      crashCount: this.state.crashCounts?.[key] || 0,
      harnessRepairs: this.state.harnessRepairs,
      retryQueue: this.state.retryQueue,
      autoRepair: process.env.HARNESS_AUTO_REPAIR === 'true',
      logFile: worker.logFile,
    })

    if (plan.emitHarnessIssue) {
      await this.emit('harness_issue', { context: key, reason: plan.emitHarnessIssue.reason, log: plan.emitHarnessIssue.logFile }, true)
    }

    switch (plan.action) {
      case 'quota_retry': {
        const pauseUntil = Math.floor(Date.now() / 1000) + this.config.quotaCooldownSeconds
        const quota = await readJson(quotaFile, {})
        await atomicJson(quotaFile, { ...quota, pauseUntil, reason: 'worker reported provider rate limit' })
        await this.emit('quota_wait', { context: key, pauseUntil }, true)
        this.state.retryQueue ||= {}
        this.state.retryQueue[key] = {
          guidance: plan.guidance,
          attempts: this.state.retryQueue[key]?.attempts || 0,
        }
        if (plan.clearCrashCount) delete this.state.crashCounts?.[key]
        await this.save()
        await this.finalizeWorkerRecord(key, worker)
        return
      }
      case 'operational_retry': {
        this.state.retryQueue ||= {}
        this.state.retryQueue[key] = {
          guidance: plan.guidance,
          attempts: this.state.retryQueue[key]?.attempts || 0,
        }
        if (plan.clearCrashCount) delete this.state.crashCounts?.[key]
        await this.save()
        await this.finalizeWorkerRecord(key, worker)
        return
      }
      case 'goal_complete':
        if (Object.keys(this.state.retryQueue || {}).length === 0) await this.completeGoal(plan.result)
        else this.pendingGoalResult = plan.result
        break
      case 'pending_goal':
        this.pendingGoalResult = plan.result
        break
      case 'goal_defects':
        await this.emit('goal_defects', { reopened: plan.reopened, defects: plan.defects }, true)
        break
      case 'goal_review_retry': {
        this.state.retryQueue ||= {}
        this.state.retryQueue['goal-review'] = {
          guidance: plan.guidance,
          attempts: this.state.retryQueue['goal-review']?.attempts || 0,
          strippedFlagDrift: plan.strippedFlagDrift === true,
        }
        if (plan.clearGoalBlock) {
          for (const request of Object.values(this.state.pendingInputs || {})) {
            if (request.status === 'pending' && request.scope === 'goal') request.status = 'superseded'
          }
          if (this.state.status === 'needs_input') this.state.status = 'running'
        }
        await this.emit('goal_review_retry', {
          reason: plan.guidance,
          strippedFlagDrift: plan.strippedFlagDrift === true,
        }, false)
        break
      }
      case 'blocked_input': {
        const runState = await readJson(runStateFile(key), {})
        const detail = {
          ...(plan.detail || {}),
          evidence: plan.detail?.evidence || runState.evidence || null,
        }
        await this.input(plan.scope, plan.reason, detail, plan.context)
        break
      }
      case 'release':
        releaseClaim(repo, key)
        await this.emit('context_completed', { context: key, passed: plan.passed, total: plan.total })
        if (plan.clearCrashCount) delete this.state.crashCounts?.[key]
        break
      case 'harness_repair':
        this.state.harnessRepairs ||= {}
        this.state.harnessRepairs[key] = true
        this.state.retryQueue ||= {}
        this.state.retryQueue[key] = { guidance: plan.guidance }
        if (plan.clearCrashCount) delete this.state.crashCounts?.[key]
        await this.save()
        await this.finalizeWorkerRecord(key, worker)
        return
      case 'crash_input':
        this.state.crashCounts = this.state.crashCounts || {}
        if (plan.incrementCrashCount) this.state.crashCounts[key] = plan.crashCount
        await this.input(plan.scope, plan.reason, plan.detail, plan.context)
        break
      case 'noop':
        break
      default:
        break
    }
    await this.finalizeWorkerRecord(key, worker)
    await this.save()
  }

  async autoRespondPendingInputs() {
    const planned = planAutoRetryResponses(this.state.pendingInputs, {
      workers: this.workers,
      retryQueue: this.state.retryQueue,
      crashCounts: this.state.crashCounts,
      isCrashBound: (context) => isCrashBoundContext(context, this.state.crashCounts),
    })
    if (!planned.length) return 0
    await mkdir(responseDir, { recursive: true })
    let written = 0
    for (const item of planned) {
      const file = join(responseDir, `${item.eventId}.json`)
      try {
        await writeFile(file, `${JSON.stringify(item.response, null, 2)}\n`, { flag: 'wx' })
        written++
        await this.emit('input_auto_responded', {
          requestId: item.eventId,
          context: item.context,
          action: item.response.action,
        })
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
    }
    return written
  }

  async processResponses() {
    for (const [id, request] of Object.entries(this.state.pendingInputs || {})) {
      if (request.status !== 'pending') continue
      const response = await readJson(join(responseDir, `${id}.json`), null)
      if (!response) continue
      request.status = 'responded'; request.response = response
      await this.emit('input_received', { requestId: Number(id), action: response.action, context: request.context })
      if (response.action === 'abort') {
        this.stopping = true
        await atomicJson(controlFile, { status: 'stopped', at: new Date().toISOString() })
        await this.save({ status: 'stopped', stoppedAt: new Date().toISOString() })
      } else if (response.action === 'pause') {
        await atomicJson(controlFile, { status: 'paused', at: new Date().toISOString() })
        await this.save({ status: 'paused' })
      } else if (response.action === 'retry' && request.context) {
        // Preserve operator/custom retryQueue guidance when an auto-retry response races in.
        const existing = this.state.retryQueue?.[request.context]
        if (existing?.guidance && response.auto) {
          this.state.retryQueue[request.context] = { ...existing, attempts: existing.attempts || 0 }
        } else {
          this.state.retryQueue[request.context] = { guidance: response.guidance || 'Retry after user review' }
        }
        delete this.state.crashCounts?.[request.context]
        await this.save()
      } else if (response.action === 'retry' && request.scope === 'goal') {
        // Goal-scoped retries have no Work Item context — queue goal-review with guidance.
        this.state.retryQueue ||= {}
        const existing = this.state.retryQueue['goal-review']
        if (!(existing?.guidance && response.auto)) {
          this.state.retryQueue['goal-review'] = { guidance: response.guidance || 'Retry Goal Review after user review', attempts: 0 }
        }
        await this.save({ status: 'running' })
      } else if (response.action === 'retry') {
        await this.save({ status: 'running' })
      } else if (response.action === 'amend') {
        await atomicJson(controlFile, { status: 'paused', at: new Date().toISOString() })
        await this.save({ status: 'paused' })
      }
    }
  }

  async maybeGoalReview(snapshot, active, available, guidance = '') {
    const { goalState, head, clean, ledger } = await goalReviewContext()
    const gate = goalReviewGate({
      catalog: snapshot.queue,
      ledger,
      counts: snapshot.counts,
      activeWorkers: active,
      slots: available,
      hasGoalReviewWorker: this.workers.has('goal-review'),
      integrationHead: head,
      reviewedHead: goalState.reviewedHead || '',
      cleanCheckout: clean,
      status: goalState.status || '',
    })
    if (gate.reason === 'already-reviewed-head') {
      await this.completeGoal({
        goal: true,
        summary: 'Goal Review already satisfied at reviewed head',
      })
      return true
    }
    if (!gate.ok) return false
    const queued = this.state.retryQueue?.['goal-review']
    const reviewGuidance = guidance || queued?.guidance || ''
    if (queued) delete this.state.retryQueue['goal-review']
    const worktree = await integrationCheckout()
    const claim = { context: 'goal-review', worktree, port: 5170, featureIds: [] }
    return this.startWorkerRuntime({
      claim,
      guidance: reviewGuidance,
      mode: 'goal-review',
      startedEvent: 'goal_review_started',
      phase: 'goal-review',
    })
  }

  async summary(snapshot, cap, runStates = null) {
    const now = Date.now()
    if (now - this.lastSummary < this.config.summaryMinutes * 60_000) return
    this.lastSummary = now
    const contexts = []
    for (const context of snapshot.claims) {
      const runState = runStates?.[context] ?? await readJson(runStateFile(context), {})
      contexts.push({ context, status: runState.status, phase: runState.phase, attempt: runState.attempt, nextAction: runState.nextAction })
    }
    // Include external live Claim Leases so Wake Triage does not treat a recycle
    // gap (state.workers={}) as empty-fleet while orchestrators are still live.
    let externalLive = 0
    try {
      const claims = await ownClaims()
      const runStatesByContext = {}
      for (const [key, claim] of Object.entries(claims)) {
        const context = claim.context || key
        runStatesByContext[context] = runStates?.[context]
          ?? await readJson(runStateFile(context), {})
      }
      externalLive = countLiveClaims({ claims, runStatesByContext, processAlive })
    } catch { /* best-effort */ }
    const liveWorkers = Math.max(this.workers.size, externalLive)
    await this.emit('progress', { ...snapshot.counts, workers: liveWorkers, capacity: cap, contexts })
  }

  /**
   * Hybrid empty-fleet recovery: clear mechanical blockers (ghost runs, dead locks)
   * when the fleet is empty but work remains. Admission below re-admits when slots allow.
   */
  /**
   * Fail-closed host remediation every tick: clear stale index.lock, drop sibling
   * goal-review / orphan reservations that starve this project, escalate to the
   * operator when playbooks cannot restore capacity for remaining work.
   */
  async remediateHostContention() {
    const fleet = await buildFleetSnapshotForRepo(this.state)
    // Count live Claim Leases / external orchestrators — state.workers alone
    // under-counts after supervisor recycle and caused false escalations.
    const claims = await ownClaims()
    const runStatesByContext = {}
    for (const [key, claim] of Object.entries(claims)) {
      const context = claim.context || key
      runStatesByContext[context] = await readJson(runStateFile(context), {})
    }
    const externalLive = countLiveClaims({ claims, runStatesByContext, processAlive })
    const projects = (fleet.projects || []).map((p) => {
      const isSelf = p.id === (projectId || 'root')
      const workers = isSelf
        ? Math.max(Number(p.workers || 0), this.workers.size, externalLive)
        : Number(p.workers || 0)
      return {
        id: p.id,
        root: p.root || null,
        status: p.status,
        progress: p.progress,
        workers,
        emptyFleetActionable: isSelf ? (workers === 0 && p.emptyFleetActionable) : p.emptyFleetActionable,
        needsGoalReviewRetry: p.needsGoalReviewRetry,
        supervisorLive: p.supervisorLive,
        supervisorPid: p.supervisorPid || null,
        capacity: p.capacity,
      }
    })
    const cap = await capacity(this.config, this.workers.size + externalLive)
    const reservations = cap.state?.reservations || {}
    const lock = indexLockInfo(commonGit)
    let indexLockHeld = false
    if (lock.present) {
      const held = spawnSync('fuser', [lock.path], { encoding: 'utf8' })
      indexLockHeld = held.status === 0
    }
    const plan = planHostRemediation({
      projects,
      reservations,
      blockerProjectId: projectId || 'root',
      indexLockPath: lock.present ? lock.path : null,
      indexLockHeld,
      indexLockAgeMs: lock.ageMs,
    })

    let applied = 0
    for (const action of plan.actions) {
      if (action.kind === 'clear_index_lock') {
        try {
          unlinkSync(action.path)
          applied += 1
          await this.emit('host_remediation', { action: 'clear_index_lock', path: action.path }, false)
        } catch (error) {
          await this.emit('host_remediation_failed', {
            action: 'clear_index_lock',
            path: action.path,
            error: error.message,
          }, true)
        }
      } else if (action.kind === 'release_reservation') {
        await releaseAdmission(commonGit, action.reservationId)
        applied += 1
        await this.emit('host_remediation', {
          action: 'release_reservation',
          reservationId: action.reservationId,
          projectId: action.projectId,
          context: action.context,
          reason: action.reason,
        }, false)
      } else if (action.kind === 'stop_idle_complete_supervisor') {
        const stopped = await stopIdleCompleteSupervisor(action)
        if (stopped.ok) {
          applied += 1
          await this.emit('host_remediation', {
            action: 'stop_idle_complete_supervisor',
            projectId: action.projectId,
            pid: stopped.pid || null,
            reason: action.reason,
          }, false)
        }
      }
    }

    const self = projects.find((p) => p.id === (projectId || 'root')) || projects[0]
    const remaining = remainingWorkFromProject(self || {})
    const afterCap = await capacity(this.config, this.workers.size + externalLive)
    const liveWorkers = Math.max(this.workers.size, externalLive, Number(self?.workers || 0))
    const empty = liveWorkers === 0 && remaining > 0
    if (applied > 0 || liveWorkers > 0) {
      this.state.remediationAttempts = 0
    } else if (empty && afterCap.available < 1 && remaining > 0) {
      this.state.remediationAttempts = Number(this.state.remediationAttempts || 0) + 1
    } else if (afterCap.available >= 1 || remaining <= 0) {
      this.state.remediationAttempts = 0
    }

    if (shouldEscalateRemediation({
      attempts: this.state.remediationAttempts,
      threshold: REMEDIATION_ESCALATE_AFTER,
      emptyFleetActionable: empty,
      available: afterCap.available,
      remaining,
    })) {
      await this.input('goal', escalationReason({
        blockerId: plan.blockerId || projectId || 'root',
        codes: [
          afterCap.pressureReason || null,
          afterCap.available < 1 ? 'no-capacity' : null,
          empty ? 'empty-fleet' : null,
        ].filter(Boolean),
      }), {
        remediationAttempts: this.state.remediationAttempts,
        capacity: {
          available: afterCap.available,
          activeCost: afterCap.activeCost,
          pressureReason: afterCap.pressureReason,
        },
        reservations: afterCap.state?.reservations || {},
      }, null, ['retry', 'pause', 'abort'])
      this.state.remediationAttempts = 0
    }

    if (applied > 0 || this.state.remediationAttempts) await this.save()
    return { applied, plan, available: afterCap.available }
  }

  async repairEmptyFleetActionable({ external, snapshot }) {
    const active = this.workers.size + external
    if (active > 0) return { repaired: false, ghosts: [], recoverable: null, external }

    const fleet = await fleetForWakeTriage(this.state)
    if (!isEmptyFleetActionable(null, fleet)) {
      return { repaired: false, ghosts: fleet.ghostClaims || [], recoverable: null, external }
    }

    const ghosts = fleet.ghostClaims || []
    const staleLocks = clearStaleGeneratorLocks(repo)
    const cap = await capacity(this.config, active)
    const recovery = planRuntimeRecovery({
      active,
      fleet,
      ghostClaims: ghosts,
      staleLocks,
      crashCounts: this.state.crashCounts,
      snapshotCounts: snapshot?.counts || this.state.progress || {},
      pressureReason: cap.pressureReason ?? null,
    })

    for (const cleared of staleLocks) {
      await this.emit('stale_lock_cleared', { lock: cleared.lock, reason: cleared.reason }, false)
    }
    if (recovery.statePatch.crashCounts) {
      this.state.crashCounts = recovery.statePatch.crashCounts
    }

    const ghostContexts = []
    for (const ghost of ghosts) {
      ghostContexts.push(ghost.context)
      if (ghost.runState) {
        await atomicJson(runStateFile(ghost.context), abandonGhostRun(ghost.runState, {
          reason: 'empty-fleet: ghost run abandoned before re-admission',
        }))
      }
    }

    for (const event of recovery.events) {
      const detail = {
        ...event.detail,
        ghostContexts: event.detail.ghostContexts || ghostContexts,
        staleLocks: event.detail.staleLocks || staleLocks.map((row) => row.lock),
      }
      if (event.kind === 'empty_fleet_actionable') {
        if (!shouldEmitEmptyFleet(this.lastEmptyFleetEmit, detail, Date.now())) continue
        this.lastEmptyFleetEmit = { detail, at: Date.now() }
      }
      await this.emit(event.kind, detail, event.immediate)
    }

    if (recovery.repaired) await this.save()
    const reinspect = recovery.repaired ? await this.inspectClaims() : null
    return {
      repaired: recovery.repaired,
      ghosts,
      recoverable: reinspect?.recoverable ?? null,
      external: reinspect?.external ?? external,
    }
  }

  async tick() {
    const control = await readJson(controlFile, {})
    const mayResume = control.status === 'running' && ['paused', 'interrupted'].includes(this.state.status)
    if ((['paused', 'stopped'].includes(control.status) || mayResume) && control.status !== this.state.status) {
      await this.save({ status: control.status })
    }
    // Host remediation before admission: sibling goal-review ghosts / stale
    // index.lock must not leave remaining work idle until a human pings chat.
    await this.remediateHostContention()
    // Cron/one-shot remediate may leave a durable escalation marker when it
    // cannot fix capacity — promote it to a goal Input Request immediately.
    const escalateMarker = join(root, 'ops-escalate.json')
    if (existsSync(escalateMarker)) {
      const marker = await readJson(escalateMarker, null)
      if (marker?.reason) {
        await this.input('goal', marker.reason, marker.detail || {}, null, marker.choices || ['retry', 'pause', 'abort'])
      }
      try { unlinkSync(escalateMarker) } catch { /* ignore */ }
    }
    // Auto-clear dead same-host merge/state locks before admission. Status used
    // to report holderAlive=false while the tick never cleared them, leaving an
    // empty fleet with free capacity until a human ran clear-dead-lock.
    const staleLocks = clearStaleGeneratorLocks(repo)
    for (const cleared of staleLocks) {
      await this.emit('stale_lock_cleared', { lock: cleared.lock, reason: cleared.reason }, false)
    }
    if (staleLocks.length > 0 && this.workers.size === 0 && Object.keys(this.state.crashCounts || {}).length > 0) {
      // Crash-bound was often tripped by workers dying on the stale lock. After
      // infra recovery with an empty fleet, allow one more auto-retry wave.
      this.state.crashCounts = {}
      await this.save()
    }
    // Prune before auto-retry so orphaned context Input Requests (no live claim,
    // retry queue entry, or worker) are not written into retryQueue and kept alive.
    const claimsForPrune = await ownClaims()
    if (this.pruneOrphanPending(claimsForPrune)) await this.save()
    await this.autoRespondPendingInputs()
    await this.processResponses()
    if (this.stopping || this.state.status === 'stopped' || this.state.status === 'complete') return
    const claims = await ownClaims()
    const runContexts = [
      ...Object.entries(claims).map(([key, claim]) => claim.context || key),
      ...this.workers.keys(),
    ]
    const runStates = await loadRunStatesByContext(runContexts)
    await this.inspectStuckWorkers(runStates)
    let { external, recoverable } = await this.inspectClaims(runStates, claims)
    const snapshot = await this.snapshot()
    const emptyRepair = await this.repairEmptyFleetActionable({ external, snapshot })
    if (emptyRepair.recoverable) {
      external = emptyRepair.external
      recoverable = emptyRepair.recoverable
    }
    const active = this.workers.size + external
    const cap = await capacity(this.config, active)
    await this.summary(snapshot, cap, runStates)
    await this.save({ capacity: cap, progress: snapshot.counts })
    try {
      const { maybeCompactControlJournal } = await importLib('control-journal.mjs')
      const compacted = await maybeCompactControlJournal(root, {
        minTail: 100,
        lease: this.lease(),
        minIntervalMs: 60_000,
        lastCompactAt: this.lastJournalCompactAt,
      })
      if (!compacted?.skipped || compacted.reason !== 'interval-throttle') {
        this.lastJournalCompactAt = Date.now()
      }
    } catch {}
    if (this.state.status === 'paused' || this.state.status === 'needs_input') return
    let slots = cap.available
    const { attempts: retryAttempts } = drainRetryQueue(this.state.retryQueue, slots)
    for (const { context, retry } of retryAttempts) {
      // Rehydrated workers (or an external live orchestrator) already own
      // this context — drop the retry instead of force-resuming into a race that
      // exhausts attempts and raises "Retry could not resume the Claim Lease".
      if (this.workers.has(context)) {
        const outcome = applyRetryResumeOutcome(this.state.retryQueue, context, retry, true)
        this.state.retryQueue = outcome.updatedQueue
        await this.save()
        continue
      }
      if (context === 'goal-review') {
        if (slots < 1) {
          await this.save()
          continue
        }
        const started = await this.maybeGoalReview(snapshot, active, slots, retry.guidance)
        const outcome = applyRetryResumeOutcome(this.state.retryQueue, context, retry, started)
        this.state.retryQueue = outcome.updatedQueue
        if (started) slots -= 1
        await this.save()
        continue
      }
      const runState = await readJson(runStateFile(context), {})
      const health = classifyRunStateHealth(runState, processAlive)
      // Ghost PID: run-state still names a live process, but this supervisor does
      // not own a worker for the context. Do not pretend the retry succeeded -
      // that cleared retryQueue and left an empty fleet. Terminate the orphan so
      // a later tick can force-resume.
      if (health.health === 'live' && !this.workers.has(context)) {
        for (const pid of [runState.ownerPid, runState.childPid]) {
          if (!processAlive(pid)) continue
          try { process.kill(Number(pid), 'SIGTERM') } catch { /* ignore */ }
        }
        await this.emit('retry_deferred_orphan_pid', {
          context,
          ownerPid: runState.ownerPid || null,
          childPid: runState.childPid || null,
        }, false)
        await this.save()
        continue
      }
      if (health.health === 'ghost') {
        await atomicJson(runStateFile(context), abandonGhostRun(runState, {
          reason: 'retry: ghost run abandoned before resume',
        }))
      }
      // Without a free slot, defer without burning retry attempts (ADR-0012).
      if (slots < 1) {
        await this.save()
        continue
      }
      if (await this.resumeClaim(context, 'force', retry.guidance)) {
        const outcome = applyRetryResumeOutcome(this.state.retryQueue, context, retry, true)
        this.state.retryQueue = outcome.updatedQueue
        slots += outcome.remainingSlotsDelta
        await this.save()
      } else {
        const outcome = applyRetryResumeOutcome(this.state.retryQueue, context, retry, false)
        this.state.retryQueue = outcome.updatedQueue
        if (outcome.exhausted) {
          await this.input('context', 'Retry could not resume the Claim Lease', { attempts: outcome.exhausted.attempts }, context)
        }
        await this.save()
      }
    }
    const grCtx = await goalReviewContext()
    const plan = planTickAdmission({
      slots,
      retryQueue: this.state.retryQueue,
      recoverable,
      pendingGoalResult: this.pendingGoalResult,
      snapshot,
      activeWorkers: active,
      hasGoalReviewWorker: this.workers.has('goal-review'),
      ledger: grCtx.ledger,
      integrationHead: grCtx.head,
      reviewedHead: grCtx.goalState.reviewedHead || '',
      cleanCheckout: grCtx.clean,
      status: grCtx.goalState.status || '',
    })
    for (const action of plan) {
      switch (action.type) {
        case 'finalize_goal':
          await this.completeGoal(action.result)
          return
        case 'wait_pending_goal':
          return
        case 'start_goal_review':
          if (await this.maybeGoalReview(snapshot, active, slots)) return
          break
        case 'resume':
          if (slots < 1) break
          if (await this.resumeClaim(action.context)) slots--
          break
        case 'claim_new':
          for (; slots > 0; slots--) {
            const claim = await this.claim()
            if (!claim) break
            if (!(await this.spawnWorker(claim))) break
          }
          break
        default:
          break
      }
    }
  }

  async run() {
    try {
      await this.initialize()
      await this.processResponses()
      // Only stop here when initialize marked stopping (failed preflight). A
      // needs_input status from pending goal Inputs must still tick so context
      // orphan pruning and worker admission can proceed for unrelated work.
      if (this.stopping || this.state.status === 'paused' || this.state.status === 'stopped') {
        this.stopping = true
        await this.save({ status: this.state.status })
        return
      }
      this.startTickWatchers()
      let consecutiveTickFailures = 0
      let lastTickFailure = ''
      while (!this.stopping && this.state.status !== 'stopped' && this.state.status !== 'complete') {
        this.tickDirty = false
        try {
          await this.tick()
          consecutiveTickFailures = 0
          lastTickFailure = ''
        } catch (error) {
          // Keep the supervisor alive through transient git/fs failures.
          const message = error.message || String(error)
          const repeat = message === lastTickFailure
          consecutiveTickFailures = repeat ? consecutiveTickFailures + 1 : 1
          lastTickFailure = message
          try {
            // First failure wakes immediately; repeats are folded (backoff) so a
            // missing generator module cannot flood the journal at ~4 Hz.
            await this.emit(
              'supervisor_tick_failed',
              { error: message, consecutiveFailures: consecutiveTickFailures },
              !repeat,
            )
            await this.save({ lastError: message })
          } catch {}
        }
        if (options.once === 'true') break
        const delay = consecutiveTickFailures > 0
          ? tickFailureDelay({
            pollMs: this.config.pollMs,
            consecutiveFailures: consecutiveTickFailures,
          })
          : nextTickDelay({ pollMs: this.config.pollMs, dirty: this.tickDirty })
        await this.waitForNextTick(delay)
      }
      this.stopping = true
      await this.save({ status: this.state.status })
    } finally {
      this.stopping = true
      this.stopTickWatchers()
      for (const worker of this.workers.values()) {
        try { worker.child?.stdout?.destroy?.() } catch {}
        try { worker.child?.stderr?.destroy?.() } catch {}
        this.applyWorkerStop(worker, 'SIGTERM')
      }
      const deadline = Date.now() + 5000
      while (this.workers.size > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      await this.drainFinalizers()
      await releaseSupervisorLock(this.leaseToken)
    }
  }

  async crash(error) {
    await this.emit('supervisor_failed', { error: error.message }, true)
    await this.save({ status: 'needs_input', lastError: error.message })
  }

  async stop(signal) {
    this.stopping = true
    const control = await readJson(controlFile, {})
    const operatorStop = control.status === 'stopped'
    if (operatorStop) {
      const { stopAllowed, turnEndDrain } = await importLib('control-beacon.mjs')
      await this.save()
      const snapshot = await buildBeaconSnapshotFromState(this.state)
      const decision = stopAllowed('soft', snapshot)
      if (!decision.allowed) {
        await this.emit('input_required', {
          scope: 'goal',
          reason: `soft stop blocked: ${decision.reason}`,
          choices: ['retry', 'pause', 'abort'],
        }, true)
        this.stopping = false
        return
      }
      void turnEndDrain()
    }
    for (const worker of this.workers.values()) {
      this.applyWorkerStop(worker, 'SIGTERM')
      if (operatorStop) this.cleanupWorkerResources(worker)
    }
    await this.emit('supervisor_stopped', { signal }, true)
    await this.save({ status: operatorStop ? 'stopped' : 'interrupted', lastSignal: signal })
    await this.drainFinalizers()
    await releaseSupervisorLock(this.leaseToken)
    process.exit(130)
  }
}

async function start() {
  await mkdir(root, { recursive: true })
  const current = await readJson(stateFile, {})
  const desired = await readJson(controlFile, {})
  const goalStateName = projectPrefix ? `${projectId}--goal-review.json` : 'goal-review.json'
  const goalState = await readJson(join(commonGit, 'harness-runs', goalStateName), {})
  const integrationBranch = integrationBranchName(repo)
  const head = git(['rev-parse', integrationBranch], true).stdout.trim()
  const clean = isCheckoutCleanForGoalReview(git(['status', '--porcelain'], true).stdout)
  if (current.status === 'complete' && clean && goalState.reviewedHead === head) {
    return process.stdout.write(`${JSON.stringify({ started: false, status: 'complete', reviewedHead: head })}\n`)
  }
  if (desired.status === 'paused') {
    return process.stdout.write(`${JSON.stringify({ started: false, status: 'paused' })}\n`)
  }
  const leaseSeconds = Math.max(10, number('supervisor-lease-seconds', 30))
  const heartbeatAge = Math.floor(Date.now() / 1000) - Number(current.heartbeatEpoch || 0)
  const localLive = current.supervisorHost === hostname() && processAlive(current.supervisorPid)
  const remoteLive = current.supervisorHost && current.supervisorHost !== hostname()
    && (current.supervisorPid || current.status === 'starting') && heartbeatAge < leaseSeconds
  if (localLive || remoteLive) fatal(`already running on ${current.supervisorHost} as pid ${current.supervisorPid}`)
  // Mandatory first-invocation preflight after proving no live supervisor owns the lease.
  const preflight = await executePreflight({ repair: true, config: baseConfig() })
  if (!preflight.ok) {
    return process.stdout.write(`${JSON.stringify({
      started: false,
      status: 'needs_input',
      preflight,
    })}\n`)
  }
  const token = randomUUID()
  const acquired = await acquireSupervisorLock(token, null, 'starting', leaseSeconds)
  try {
    await atomicJson(controlFile, { status: 'running', at: new Date().toISOString() })
    await atomicJson(stateFile, {
      ...current, repo, status: 'starting', supervisorPid: null, supervisorHost: hostname(),
      heartbeat: new Date().toISOString(), heartbeatEpoch: Math.floor(Date.now() / 1000),
      startedAt: current.startedAt || new Date().toISOString(),
    })
    const log = await open(supervisorLog, 'a')
    const child = spawn(process.execPath, [scriptFile, 'run', ...rawArgs], {
      cwd: repo, detached: true, stdio: ['ignore', log.fd, log.fd],
      env: { ...process.env, HARNESS_SUPERVISOR_TOKEN: token },
    })
    try { await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject) }) }
    finally { await log.close() }
    child.unref()
    await updateSupervisorLock(token, acquired?.fenceGeneration || 1, 'starting', child.pid)
    const latest = await readJson(stateFile, {})
    await atomicJson(stateFile, { ...latest, repo, supervisorPid: child.pid, supervisorHost: hostname() })
    process.stdout.write(`${JSON.stringify({ started: true, pid: child.pid, stateFile, eventFile, preflight })}\n`)
  } catch (error) {
    await releaseSupervisorLock(token)
    throw error
  }
}

async function preflightCmd() {
  const repair = options.repair !== 'false'
  const report = await executePreflight({ repair, config: capacityConfig() })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.ok) process.exitCode = 2
}

async function respond() {
  const id = Number(options.event)
  if (!id || !options.action) fatal('--event and --action are required')
  const events = await readEvents()
  let request = events.find((event) => event.id === id && event.kind === 'input_required')
  // Fallback when the journal has duplicate/recycled ids and dedupe hid the
  // live Input Request — state.pendingInputs is authoritative for the run.
  if (!request) {
    const state = await readJson(stateFile, {})
    const pending = state.pendingInputs?.[id] || state.pendingInputs?.[String(id)]
    if (pending?.status === 'pending' && (pending.kind === 'input_required' || pending.choices)) {
      request = pending
    }
  }
  if (!request) fatal(`unknown Input Request ${id}`)
  const choices = request.choices || ['retry', 'pause', 'abort']
  if (!choices.includes(options.action)) fatal(`action must be one of: ${choices.join(', ')}`)
  const file = join(responseDir, `${id}.json`)
  const response = { eventId: id, action: options.action, guidance: options.guidance || '', at: new Date().toISOString() }
  await mkdir(responseDir, { recursive: true })
  try {
    await writeFile(file, `${JSON.stringify(response, null, 2)}\n`, { flag: 'wx' })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const existing = await readJson(file, {})
    if (existing.action !== response.action || existing.guidance !== response.guidance) fatal(`Input Request ${id} already has a different response`)
  }
  process.stdout.write(`${JSON.stringify({ accepted: true, eventId: id })}\n`)
}

async function readConsumerCursors() {
  const consumerCursors = {}
  try {
    const { readdir } = await import('node:fs/promises')
    const names = await readdir(cursorDir)
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const consumer = name.slice(0, -5)
      consumerCursors[consumer] = await readJson(join(cursorDir, name), {})
    }
  } catch { /* no cursors yet */ }
  return consumerCursors
}

async function buildBeaconSnapshotFromState(state = {}) {
  const { beaconSnapshot, resolveWorkerLive } = await importLib('control-beacon.mjs')
  const events = await readEvents()
  const journalTip = events.length ? Number(events[events.length - 1].id) || 0 : 0
  const workers = {}
  for (const [context, worker] of Object.entries(state.workers || {})) {
    const runState = await readJson(runStateFile(context), {})
    workers[context] = {
      ...worker,
      context,
      type: 'background',
      live: resolveWorkerLive(worker, { processAlive, runState }),
    }
  }
  return beaconSnapshot({
    workers,
    journalTip,
    consumerCursors: await readConsumerCursors(),
    pendingInputs: state.pendingInputs || {},
    processAlive,
  })
}

async function setStatus(status) {
  const state = await readJson(stateFile, null)
  if (!state) fatal('no supervisor state')
  if (status === 'stopped') {
    const { stopAllowed } = await importLib('control-beacon.mjs')
    const snapshot = await buildBeaconSnapshotFromState(state)
    const decision = stopAllowed('soft', snapshot)
    if (!decision.allowed) {
      process.stdout.write(`${JSON.stringify({ status, blocked: true, reason: decision.reason })}\n`)
      return
    }
  }
  await atomicJson(controlFile, { status, at: new Date().toISOString() })
  if (status === 'stopped' && state.supervisorHost === hostname() && processAlive(state.supervisorPid)) process.kill(state.supervisorPid, 'SIGTERM')
  process.stdout.write(`${JSON.stringify({ status })}\n`)
}

async function fleetAuth() {
  const { authorizeFleetRecovery } = await importLib('supervisor-lease.mjs')
  const state = await readJson(stateFile, {})
  const token = process.env.HARNESS_SUPERVISOR_TOKEN || options.token || ''
  const force = options.force === 'true'
  const leaseSeconds = Math.max(10, number('supervisor-lease-seconds', 30))
  return authorizeFleetRecovery(root, { state, token, force, leaseSeconds })
}

async function killSupervisor() {
  const auth = await fleetAuth()
  const state = await readJson(stateFile, {})
  const { stopAllowed } = await importLib('control-beacon.mjs')
  const snapshot = await buildBeaconSnapshotFromState(state)
  const decision = stopAllowed('force', snapshot, { authorized: Boolean(auth.authorized) })
  if (!decision.allowed) fatal(decision.reason)
  const pid = Number(state.supervisorPid)
  if (!pid) fatal('no supervisorPid in state')
  const signal = options.signal === 'SIGTERM' ? 'SIGTERM' : 'SIGKILL'
  if (state.supervisorHost && state.supervisorHost !== hostname()) {
    fatal(`supervisor runs on ${state.supervisorHost}, not this host`)
  }
  if (!processAlive(pid)) {
    process.stdout.write(`${JSON.stringify({ killed: false, reason: 'not-running', pid })}\n`)
    return
  }
  process.kill(pid, signal)
  process.stdout.write(`${JSON.stringify({ killed: true, pid, signal })}\n`)
}

async function releaseSupervisorLockCmd() {
  const auth = await fleetAuth()
  const { clearStaleSupervisorLock, releaseSupervisorLease } = await importLib('supervisor-lease.mjs')
  const leaseSeconds = Math.max(10, number('supervisor-lease-seconds', 30))
  if (auth.mode === 'token' && auth.owner?.token) {
    await releaseSupervisorLease(root, auth.owner.token)
    process.stdout.write(`${JSON.stringify({ released: true, mode: 'token' })}\n`)
    return
  }
  const result = await clearStaleSupervisorLock(root, { leaseSeconds })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

async function killWorker() {
  await fleetAuth()
  const context = options.context
  if (!context) fatal('--context is required')
  const state = await readJson(stateFile, {})
  const saved = state.workers?.[context]
  const runState = await readJson(runStateFile(context), {})
  const worker = saved
    ? {
      ...saved,
      type: 'background',
      childPid: runState.childPid || saved.pid || null,
      ownedResources: {
        port: saved.port,
        worktree: saved.worktree,
        processGroup: processGroupForWorker(saved, runState),
      },
    }
    : {
      type: 'background',
      childPid: runState.childPid || runState.ownerPid || null,
      port: runState.port,
      worktree: runState.worktree,
      ownedResources: {
        port: runState.port,
        worktree: runState.worktree,
        processGroup: processGroupForWorker({}, runState),
      },
    }
  const signal = options.signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM'
  const stopPlan = planWorkerStop(worker, { signal })
  if (stopPlan.kind === 'terminate_tree') {
    terminateProcessTree(stopPlan.pid, stopPlan.signal)
  }
  const targets = planWorkerCleanupTargets(worker)
  const cleanup = {
    browsers: cleanupBrowserOrphans(targets),
    runtime: cleanupWorktreeRuntime({
      ...targets,
      commonGit: targets.commonGit || commonGit,
      projectId: targets.projectId || projectId || 'root',
      context: targets.context || context,
    }),
  }
  if (state.workers?.[context]) {
    const nextWorkers = { ...state.workers }
    delete nextWorkers[context]
    await atomicJson(stateFile, { ...state, workers: nextWorkers })
  }
  process.stdout.write(`${JSON.stringify({ context, stop: stopPlan, cleanup })}\n`)
}

async function releaseLease() {
  await fleetAuth()
  const context = options.context
  if (!context) fatal('--context is required')
  if (context === 'goal-review') fatal('goal-review has no Claim Lease to release')
  const message = releaseClaim(repo, context)
  process.stdout.write(`${JSON.stringify({ context, message })}\n`)
}

async function clearDeadLockCmd() {
  await fleetAuth()
  const lock = options.lock
  if (!lock) fatal('--lock merge|state is required')
  const force = options.force === 'true'
  const result = clearDeadLock(repo, lock, { force })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

async function resolveFleetSnapshotTargets() {
  const extraRoots = String(options.projects || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (extraRoots.length) {
    return extraRoots.map((rootPath) => {
      const topo = resolveProjectTopology(resolve(rootPath))
      return { id: topo.projectId, repo: resolve(rootPath), topology: topo }
    })
  }
  const registry = topology.registry
  if (registry?.projects?.length) {
    return registry.projects.map((entry) => {
      const projectRepo = resolve(topology.gitRoot, entry.path || entry.root || '.')
      const topo = resolveProjectTopology(projectRepo)
      return { id: entry.id || topo.projectId, repo: projectRepo, topology: topo }
    })
  }
  return [{ id: projectId, repo, topology }]
}

async function loadProjectFleetInputs(target) {
  const topo = target.topology
  const projectStateFile = join(topo.controlRoot, 'state.json')
  const projectEventFile = join(topo.controlRoot, 'events.jsonl')
  const current = await readJson(projectStateFile, { status: 'not_started' })
  let events = []
  try {
    const { readControlEvents } = await importLib('control-journal.mjs')
    events = await readControlEvents(topo.controlRoot, projectEventFile)
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'CONTROL_JOURNAL_CORRUPT') throw error
  }
  const eventsTip = events.length ? Number(events[events.length - 1].id) || 0 : 0
  const claims = scopeClaims(
    await readJson(join(topo.commonGit, 'generator-claims.json'), {}),
    topo.projectPrefix.replace(/\/$/, ''),
  )
  const runStatesByContext = {}
  for (const [key, claim] of Object.entries(claims)) {
    const context = claim.context || key
    runStatesByContext[context] = await readJson(
      runStatePath(topo.commonGit, topo.projectPrefix, context),
      {},
    )
  }
  const ghostClaims = listGhostClaims({ claims, runStatesByContext, processAlive })
  const liveClaimWorkers = countLiveClaims({ claims, runStatesByContext, processAlive })
  const cap = await observeCapacity(topo.commonGit, governorOptions(capacityConfig()))
  const sharedRuntime = composeShareSnapshot(topo.commonGit)
  const wakeExtended = await (async () => {
    try {
      const catalog = readFeatureListFromIntegration(target.repo) ?? []
      const ledger = await readLedger(ledgerPath(topo.commonGit, topo.projectId === 'root' ? '' : topo.projectId))
      const queue = applyLedgerToCatalog(catalog, ledger)
      const goalStateName = topo.projectPrefix
        ? `${topo.projectId}--goal-review.json`
        : 'goal-review.json'
      const goalState = await readJson(join(topo.commonGit, 'harness-runs', goalStateName), {})
      const head = gitIn(target.repo, ['rev-parse', integrationBranchName(target.repo)], true).stdout.trim()
      return {
        queueComplete: catalogFullyIntegrated(queue),
        integrationHead: head,
        reviewedHead: goalState.reviewedHead || '',
        goalReviewStatus: goalState.status || '',
        retryGoalReview: Boolean(current.retryQueue?.['goal-review']),
        liveClaimWorkers,
      }
    } catch {
      return { liveClaimWorkers }
    }
  })()
  return {
    id: target.id,
    root: target.repo,
    state: current,
    eventsTip,
    events,
    ghostClaims,
    liveClaimWorkers,
    wakeExtended,
    hostResources: readHostResources(),
    governorReservations: {
      activeWorkers: cap.activeWorkers,
      activeCost: cap.activeCost,
      reservations: cap.state?.reservations || {},
      pressureReason: cap.pressureReason || null,
    },
    sharedRuntime,
    recoveryReasons: recoveryReasonsFromFleet({ state: current, ghostClaims }),
    pressureAdvice: cap.pressureReason ? `admission deferred by ${cap.pressureReason}` : null,
    supervisorLive: deriveSupervisorLiveForState(current),
    localHost: hostname(),
    leaseSeconds: Math.max(10, number('supervisor-lease-seconds', 30)),
  }
}

async function buildFleetSnapshotForRepo(state = null, { wakeTriage = null, targets = null } = {}) {
  const projectTargets = targets || await resolveFleetSnapshotTargets()
  const projects = []
  for (const target of projectTargets) {
    const input = await loadProjectFleetInputs(target)
    if (target.id === projectId && state) input.state = state
    if (wakeTriage && target.id === projectId) input.wakeTriage = wakeTriage
    projects.push(input)
  }
  return buildFleetSnapshot({ projects })
}

async function fleetSnapshotCmd() {
  const state = await readJson(stateFile, { status: 'not_started' })
  const { shouldWake } = await importLib('wake-triage.mjs')
  const recent = (await readEvents()).slice(-20)
  const fleet = await fleetForWakeTriage(state)
  const snapshot = await buildFleetSnapshotForRepo(state, {
    wakeTriage: { shouldWake: shouldWake(recent, fleet) },
  })
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`)
}

/**
 * Stop a sibling supervisor that finished its queue but never demoted to
 * `complete` (idle PID / lease). Never targets the calling project.
 */
async function stopIdleCompleteSupervisor(action = {}) {
  const siblingId = action.projectId
  if (!siblingId || siblingId === (projectId || 'root')) {
    return { ok: false, reason: 'refuse-self' }
  }
  const siblingRoot = siblingId === 'root'
    ? join(commonGit, 'harness-control')
    : join(commonGit, 'harness-control', siblingId)
  const siblingStateFile = join(siblingRoot, 'state.json')
  const siblingControl = join(siblingRoot, 'control.json')
  if (!existsSync(siblingStateFile)) return { ok: false, reason: 'missing-state' }
  const state = await readJson(siblingStateFile, {})
  const pid = Number(state.supervisorPid || 0)
  let killed = false
  if (pid && processAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM')
      killed = true
      spawnSync('sleep', ['0.4'], { stdio: 'ignore' })
      if (processAlive(pid)) process.kill(pid, 'SIGKILL')
    } catch { /* ignore ESRCH */ }
  }
  await atomicJson(siblingStateFile, {
    ...state,
    status: 'complete',
    supervisorPid: null,
    completedAt: state.completedAt || new Date().toISOString(),
    stoppedBy: 'host-remediation-idle-complete',
  })
  try {
    await atomicJson(siblingControl, { status: 'complete', at: new Date().toISOString() })
  } catch { /* optional */ }
  try {
    const { clearStaleSupervisorLock } = await importLib('supervisor-lease.mjs')
    await clearStaleSupervisorLock(siblingRoot, {
      leaseSeconds: Math.max(10, number('supervisor-lease-seconds', 30)),
    })
  } catch { /* optional */ }
  return { ok: true, pid: pid || null, killed }
}

/** One-shot host remediation for systemd cron (does not steal the supervisor lease). */
async function remediateCmd() {
  const state = await readJson(stateFile, { status: 'not_started' })
  const snapshot = await buildFleetSnapshotForRepo(state)
  const claims = await ownClaims()
  const runStatesByContext = {}
  for (const [key, claim] of Object.entries(claims)) {
    const context = claim.context || key
    runStatesByContext[context] = await readJson(runStateFile(context), {})
  }
  const externalLive = countLiveClaims({ claims, runStatesByContext, processAlive })
  const projects = (snapshot.projects || []).map((p) => {
    const isSelf = p.id === (projectId || 'root')
    const workers = isSelf
      ? Math.max(Number(p.workers || 0), Number(Object.keys(state.workers || {}).length || 0), externalLive)
      : Number(p.workers || 0)
    return {
      id: p.id,
      root: p.root || null,
      status: p.status,
      progress: p.progress,
      workers,
      emptyFleetActionable: isSelf ? (workers === 0 && p.emptyFleetActionable) : p.emptyFleetActionable,
      needsGoalReviewRetry: p.needsGoalReviewRetry,
      supervisorLive: p.supervisorLive,
      supervisorPid: p.supervisorPid || null,
      capacity: p.capacity,
    }
  })
  const cfg = capacityConfig({ requireHost: false })
  const cap = await capacity(cfg, Number(Object.keys(state.workers || {}).length || 0) + externalLive)
  const lock = indexLockInfo(commonGit)
  let indexLockHeld = false
  if (lock.present) {
    const held = spawnSync('fuser', [lock.path], { encoding: 'utf8' })
    indexLockHeld = held.status === 0
  }
  const plan = planHostRemediation({
    projects,
    reservations: cap.state?.reservations || {},
    blockerProjectId: projectId || 'root',
    indexLockPath: lock.present ? lock.path : null,
    indexLockHeld,
    indexLockAgeMs: lock.ageMs,
  })
  const applied = []
  for (const action of plan.actions) {
    if (action.kind === 'clear_index_lock') {
      try {
        unlinkSync(action.path)
        applied.push(action)
      } catch (error) {
        applied.push({ ...action, error: error.message })
      }
    } else if (action.kind === 'release_reservation') {
      await releaseAdmission(commonGit, action.reservationId)
      applied.push(action)
    } else if (action.kind === 'stop_idle_complete_supervisor') {
      const stopped = await stopIdleCompleteSupervisor(action)
      applied.push({ ...action, ...stopped })
    }
  }
  const after = await capacity(cfg, externalLive)
  const self = projects.find((p) => p.id === (projectId || 'root')) || projects[0]
  const remaining = remainingWorkFromProject(self || {})
  const liveWorkers = Math.max(Number(self?.workers || 0), externalLive)
  const empty = liveWorkers === 0 && remaining > 0
  let attempts = Number(state.remediationAttempts || 0)
  if (applied.length > 0 || liveWorkers > 0) attempts = 0
  else if (empty && after.available < 1 && remaining > 0) attempts += 1
  else if (after.available >= 1 || remaining <= 0) attempts = 0
  const escalate = shouldEscalateRemediation({
    attempts,
    threshold: REMEDIATION_ESCALATE_AFTER,
    emptyFleetActionable: empty,
    available: after.available,
    remaining,
  })
  await atomicJson(stateFile, {
    ...state,
    remediationAttempts: escalate ? 0 : attempts,
    lastRemediation: {
      at: new Date().toISOString(),
      applied: applied.length,
      escalate,
      available: after.available,
      remaining,
      externalLive,
    },
  })
  if (escalate) {
    // Durable goal Input Request via a short-lived supervisor emit path is unsafe
    // without the lease; write a pending input marker the live supervisor will
    // promote, and desktop-notify the operator immediately.
    const reason = escalationReason({
      blockerId: plan.blockerId || projectId || 'root',
      codes: [
        after.pressureReason || null,
        after.available < 1 ? 'no-capacity' : null,
        empty ? 'empty-fleet' : null,
      ].filter(Boolean),
    })
    const pendingPath = join(root, 'ops-escalate.json')
    await atomicJson(pendingPath, {
      at: new Date().toISOString(),
      scope: 'goal',
      reason,
      detail: {
        remediationAttempts: attempts,
        capacity: { available: after.available, activeCost: after.activeCost },
        applied,
      },
      choices: ['retry', 'pause', 'abort'],
    })
    try {
      spawnSync('notify-send', ['--urgency=critical', '-a', 'Harness', 'Harness ESCALATION', reason], {
        env: {
          ...process.env,
          DISPLAY: process.env.DISPLAY || ':0',
          DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS
            || `unix:path=/run/user/${process.getuid?.() || 1000}/bus`,
        },
        stdio: 'ignore',
      })
    } catch { /* optional */ }
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    applied,
    plan,
    available: after.available,
    remaining,
    escalate,
    remediationAttempts: attempts,
  }, null, 2)}\n`)
}

async function main() {
  if (commandName === 'start') return start()
  if (commandName === 'status') {
    const state = await readJson(stateFile, { status: 'not_started' })
    const { classify, shouldWake, foldProgress } = await importLib('wake-triage.mjs')
    const fleet = await fleetForWakeTriage(state)
    const recent = (await readEvents()).slice(-20)
    const wakeTriage = {
      shouldWake: shouldWake(recent, fleet),
      fold: foldProgress(recent, fleet),
      latest: recent.length ? { ...recent.at(-1), wakeTriage: classify(recent.at(-1), fleet) } : null,
    }
    const fleetSnapshot = await buildFleetSnapshotForRepo(state, { wakeTriage })
    return process.stdout.write(`${JSON.stringify({ ...state, fleetSnapshot, wakeTriage }, null, 2)}\n`)
  }
  if (commandName === 'fleet-snapshot') return fleetSnapshotCmd()
  if (commandName === 'capacity') return process.stdout.write(`${JSON.stringify(await capacity(baseConfig(), Number(options.active || 0)), null, 2)}\n`)
  if (commandName === 'events') {
    const { classify } = await importLib('wake-triage.mjs')
    const fleet = await fleetForWakeTriage(await readJson(stateFile, {}))
    const cursor = options.consumer ? await readJson(consumerFile(), {}) : {}
    const after = Math.max(Number(options.after || 0), Number(cursor.eventId || 0))
    const events = (await readEvents())
      .filter((event) => event.id > after)
      .map((event) => ({ ...event, wakeTriage: classify(event, fleet) }))
    return process.stdout.write(`${JSON.stringify(events, null, 2)}\n`)
  }
  if (commandName === 'ack') {
    const id = Number(options.event)
    if (!id) fatal('--event is required')
    const events = await readEvents()
    if (!events.some((event) => event.id === id)) fatal(`unknown Control Event ${id}`)
    const file = consumerFile()
    const current = await readJson(file, {})
    const eventId = Math.max(Number(current.eventId || 0), id)
    const value = { eventId, at: new Date().toISOString() }
    await atomicJson(file, value)
    return process.stdout.write(`${JSON.stringify(value)}\n`)
  }
  if (commandName === 'respond') return respond()
  if (commandName === 'quota') {
    const current = await readJson(quotaFile, {})
    const value = { ...current }
    if (options.workers !== undefined) {
      const workers = Number(options.workers)
      if (!Number.isFinite(workers)) fatal('--workers must be a number')
      value.maxWorkers = Math.max(0, Math.floor(workers))
    }
    if (options['pause-until'] !== undefined) {
      const pauseUntil = Number(options['pause-until'])
      if (!Number.isFinite(pauseUntil)) fatal('--pause-until must be a Unix timestamp')
      value.pauseUntil = pauseUntil
    }
    value.updatedAt = new Date().toISOString()
    await atomicJson(quotaFile, value)
    return process.stdout.write(`${JSON.stringify(value)}\n`)
  }
  if (commandName === 'pause') return setStatus('paused')
  if (commandName === 'resume') return setStatus('running')
  if (commandName === 'stop') return setStatus('stopped')
  if (commandName === 'kill-supervisor') return killSupervisor()
  if (commandName === 'release-supervisor-lock') return releaseSupervisorLockCmd()
  if (commandName === 'kill-worker') return killWorker()
  if (commandName === 'release-lease') return releaseLease()
  if (commandName === 'clear-dead-lock') return clearDeadLockCmd()
  if (commandName === 'preflight') return preflightCmd()
  if (commandName === 'remediate') return remediateCmd()
  if (commandName === 'run') {
    const supervisor = new Supervisor(baseConfig())
    process.on('SIGINT', () => supervisor.stop('SIGINT'))
    process.on('SIGTERM', () => supervisor.stop('SIGTERM'))
    return supervisor.run()
  }
  fatal(`unknown command: ${commandName}`)
}

await main()
