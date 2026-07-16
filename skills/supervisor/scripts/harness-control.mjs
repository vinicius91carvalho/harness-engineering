#!/usr/bin/env node
import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { watch } from 'node:fs'
import { createWriteStream, existsSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { hostname } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const commandName = process.argv[2]
const rawArgs = process.argv.slice(3)
const options = {}
for (let i = 0; i < rawArgs.length; i += 2) {
  const key = rawArgs[i], value = rawArgs[i + 1]
  if (!key?.startsWith('--') || value === undefined) fatal(`invalid argument: ${key || ''}`)
  options[key.slice(2)] = value
}
if (!commandName) fatal('usage: harness-control.mjs {start|run|status|fleet-snapshot|capacity|events|ack|respond|quota|pause|resume|stop|kill-supervisor|release-supervisor-lock|kill-worker|release-lease|clear-dead-lock|preflight|reap-cursor-subagents} --repo <path> ...')

const scriptFile = fileURLToPath(import.meta.url)
const supervisorLib = resolve(dirname(scriptFile), '..', 'lib')
const bundledGenerator = resolve(dirname(scriptFile), '..', '..', 'generator')
const namespacedGenerator = resolve(dirname(scriptFile), '..', '..', 'harness-generator')
const defaultGenerator = existsSync(bundledGenerator) ? bundledGenerator : namespacedGenerator
const repo = resolve(options.repo || '.')
const generatorDir = resolve(options['generator-dir'] || defaultGenerator)
const libDir = join(generatorDir, 'lib')
async function importLib(name) {
  return import(pathToFileURL(join(libDir, name)).href)
}
const { readJson, atomicJson } = await importLib('fs-json.mjs')
const { isProviderQuotaLimited } = await importLib('worker-outcome.mjs')
const { readFeatureListFromIntegration } = await importLib('git-repo.mjs')
const {
  isLiveRunOwner,
  classifyRunStateHealth,
  abandonGhostRun,
  listGhostClaims,
  processAlive,
} = await importLib('orphan-claims.mjs')
const { scopeClaims, runStateFile: runStatePath } = await importLib('project-keys.mjs')
const { resolveProjectTopology } = await importLib('project-topology.mjs')
const { cleanupBrowserOrphans } = await importLib('browser-cleanup.mjs')
const { cleanupWorktreeRuntime } = await importLib('worktree-teardown.mjs')
const { acquireComposeShare } = await importLib('compose-shared.mjs')
const {
  readDurable,
  interpretClosed,
  assessLive,
  isWorkerStuck,
  isWorkerStuckByHealth,
  stuckThresholdMs,
} = await importLib('worker-outcome.mjs')
const { planWorkerClosedActions, shouldEnqueueStuckWorkerRetry, planAutoRetryResponses } = await importLib('failure-policy.mjs')
const { enrichGuidanceWithEvidence } = await importLib('evidence-guidance.mjs')
const { buildOrchestratorArgv, buildWorkerBase, workerLogFileName, planWorkerHerdrMeta, planWorkerStop, planWorkerCleanupTargets, terminateProcessTree, persistWorkerPaneTail, processGroupForWorker } = await importLib('worker-lifecycle.mjs')
const { drainRetryQueue, applyRetryResumeOutcome, shouldFinalizePendingGoal } = await importLib('supervisor-tick.mjs')
const { planTickAdmission, goalReviewGate } = await importLib('supervisor-admission.mjs')
const { isCheckoutCleanForGoalReview } = await importLib('checkout-dirt.mjs')
const { pruneOrphanPendingInputs, isCrashBoundContext } = await importLib('supervisor-claims.mjs')
const { planRuntimeRecovery } = await importLib('runtime-recovery.mjs')
const { nextTickDelay, tickWatchPaths } = await importLib('tick-context.mjs')
const { selectClaim, resumeClaim, releaseClaim, mergeLockHolder, clearDeadLock, clearStaleGeneratorLocks } = await importLib('claim-lease.mjs')
const { integrationBranchName, integrationBranchRef } = await importLib('integration-branch.mjs')
const { ledgerPath, readLedger, applyLedgerToCatalog } = await importLib('execution-ledger.mjs')
const { catalogFullyIntegrated } = await importLib('completion-contract.mjs')
const { observeCapacity, pruneDeadReservations } = await importLib('resource-governor.mjs')
const { evidenceGuidanceExcerpt } = await importLib('evidence-guidance.mjs')
const { readHostResources } = await importLib('host-resources.mjs')
const { composeShareSnapshot } = await importLib('compose-shared.mjs')
const {
  fleetSnapshotFromState,
  isEmptyFleetActionable,
  buildFleetSnapshot,
} = await importLib('fleet-snapshot.mjs')
const {
  resolveDisplayMode, spawnAgent, closeWorkerDisplay, renameWorkerTab,
  buildWorkerTabLabel, roleFromPhase, readPaneTail, getPaneAgentStatus, paneExists,
  reportHarnessAgent, detectPaneWaiting, detectPaneOrchestratorExited, detectPaneMergeLockWait,
  paneShowsIdleShell, listProjectWorkerAgents, contextFromWorkerAgent, getFocusedWorkspaceId,
  listHarnessWorkerTabs, closeDanglingShellPanes, closeStaleHarnessPanesForProject,
  closeAllDanglingHarnessShells, listPaneScroll, createPaneSnapshot, listPanes,
} = await import(pathToFileURL(join(supervisorLib, 'herdr-spawn.mjs')).href)
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
const herdrLayoutLock = join(commonGit, 'harness-control', 'herdr-layout.lock')
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
  try {
    const queue = await queueWithLedger()
    const { goalState, head } = await goalReviewContext()
    return fleetSnapshotFromState(state, {
      queueComplete: catalogFullyIntegrated(queue),
      integrationHead: head,
      reviewedHead: goalState.reviewedHead || '',
      goalReviewStatus: goalState.status || '',
      retryGoalReview: Boolean(state.retryQueue?.['goal-review']),
      ghostClaims: ghosts,
      events: journalEvents,
      hostResources: readHostResources(),
      sharedRuntime: composeShareSnapshot(commonGit),
      recoveryReasons: recoveryReasonsFromFleet({ state, ghostClaims: ghosts }),
      supervisorLive: deriveSupervisorLiveForState(state),
      localHost: hostname(),
      leaseSeconds: Math.max(10, number('supervisor-lease-seconds', 30)),
    })
  } catch {
    return fleetSnapshotFromState(state, {
      ghostClaims: ghosts,
      events: journalEvents,
      hostResources: readHostResources(),
      sharedRuntime: composeShareSnapshot(commonGit),
      recoveryReasons: recoveryReasonsFromFleet({ state, ghostClaims: ghosts }),
      supervisorLive: deriveSupervisorLiveForState(state),
      localHost: hostname(),
      leaseSeconds: Math.max(10, number('supervisor-lease-seconds', 30)),
    })
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

async function listProjectGhostClaims() {
  const claims = await ownClaims()
  const runStatesByContext = {}
  for (const [key, claim] of Object.entries(claims)) {
    const context = claim.context || key
    runStatesByContext[context] = await readJson(runStateFile(context), {})
  }
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
    display: resolveDisplayMode(options),
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
    this.lastFinishedTabReap = 0
    this.finalizing = new Set()
    this.pendingGoalResult = null
    this.tickDirty = false
    this.tickWatchers = []
    this.wakeTick = null
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
        pid: worker.child?.pid || null,
        paneId: worker.paneId || null,
        tabId: worker.tabId || null,
        tabLabel: worker.tabLabel || null,
        agentName: worker.agentName || null,
        display: worker.type || 'background',
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
    if (plan.kind === 'close_display') {
      closeWorkerDisplay(plan.paneId, plan.tabId)
      if (plan.alsoTerminatePid) terminateProcessTree(plan.alsoTerminatePid, plan.signal)
      return plan
    }
    if (plan.kind === 'terminate_tree') {
      terminateProcessTree(plan.pid, plan.signal)
      return plan
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
    herdrRole,
    herdrTaskId,
    herdrRetry,
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

    if (this.config.display === 'herdr') {
      const meta = planWorkerHerdrMeta({
        claim,
        projectId,
        role: herdrRole,
        taskId: herdrTaskId,
        retry: herdrRetry,
      })
      const { paneId, tabId, tabLabel } = spawnAgent(meta.agentName, [process.execPath, ...argv], {
        cwd: meta.cwd,
        layoutLockDir: herdrLayoutLock,
        taskId: meta.taskId,
        role: meta.role,
        project: meta.project,
        retry: meta.retry,
        env: governorEnv,
      })
      reportHarnessAgent(paneId, meta.agentName, 'working', mode === 'goal-review' ? 'goal review starting' : 'orchestrator starting')
      this.workers.set(key, {
        type: 'herdr', paneId, tabId, tabLabel, agentName: meta.agentName,
        ...workerBase,
      })
      const eventPayload = startedEvent === 'goal_review_started'
        ? { paneId, tabId, tabLabel, display: 'herdr' }
        : { context: claim.context, featureIds: claim.featureIds, paneId, tabId, tabLabel, display: 'herdr' }
      await this.emit(startedEvent || 'worker_started', eventPayload)
      await this.save()
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
    await this.rehydrateHerdrWorkers()
  }

  /** Reattach live herdr panes after supervisor restart (orchestrators keep running). */
  async rehydrateHerdrWorkers() {
    if (this.config.display !== 'herdr') return
    const claims = await ownClaims()
    const savedWorkers = this.state?.workers || {}
    const paneSnapshot = createPaneSnapshot()
    let added = false
    for (const agent of listProjectWorkerAgents(projectId)) {
      const context = contextFromWorkerAgent(agent.agent, projectId)
      if (!context || this.workers.has(context)) continue
      if (!paneExists(agent.pane_id, paneSnapshot)) continue
      const tail = readPaneTail(agent.pane_id, 30, paneSnapshot)
      if (paneShowsIdleShell(tail) && !detectPaneMergeLockWait(tail)) continue
      let claim
      if (context === 'goal-review') {
        try {
          claim = { context: 'goal-review', worktree: await integrationCheckout(), port: 5170, featureIds: [] }
        } catch {
          continue
        }
      } else {
        claim = Object.values(claims).find((entry) => entry.context === context)
        if (!claim) continue
      }
      const runState = await readJson(runStateFile(context), {})
      const live = isLiveRunOwner(runState, processAlive)
      if (!live && !detectPaneMergeLockWait(tail) && context !== 'goal-review') continue
      const saved = savedWorkers[context] || {}
      this.workers.set(context, {
        type: 'herdr',
        paneId: agent.pane_id,
        tabId: saved.tabId || agent.tab_id || null,
        tabLabel: saved.tabLabel || null,
        agentName: agent.agent,
        logFile: saved.logFile || join(logDir, `${context.replace(/[^a-zA-Z0-9_-]/g, '_')}-reattached.log`),
        context: claim.context,
        featureIds: saved.featureIds || claim.featureIds || [],
        worktree: saved.worktree || claim.worktree,
        port: saved.port || claim.port,
        startedAt: saved.startedAt || new Date().toISOString(),
        reservationId: saved.reservationId || null,
        governorReservationId: saved.governorReservationId || null,
        ownedResources: {
          port: saved.port || claim.port,
          worktree: saved.worktree || claim.worktree,
          profileDir: null,
          processGroup: processGroupForWorker({ type: 'herdr' }, runState),
        },
      })
      added = true
    }
    if (added) await this.save()
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

  async inspectClaims() {
    const claims = await ownClaims()
    if (this.pruneOrphanPending(claims)) await this.save()
    let external = 0
    const recoverable = []
    for (const [claimKey, claim] of Object.entries(claims)) {
      const context = claim.context || claimKey
      if (this.workers.has(context)) continue
      const runState = await readJson(runStateFile(context), {})
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
    const herdrRetry = Math.max(1, Number(runState.attempt) || Number(this.state.retryQueue?.[key]?.attempts) || 1)
    const herdrTaskId = (claim.featureIds && claim.featureIds[0]) || claim.context || key
    const herdrRole = roleFromPhase(runState.phase || 'coding')
    if (process.env.HARNESS_TEST_SUPERVISOR_QUOTA === '1') {
      const quotaTail = "ERROR: You've hit your usage limit. Try again at Jul 9th, 2026 12:17 AM.\n"
      return this.startWorkerRuntime({
        claim,
        guidance,
        herdrRole,
        herdrTaskId,
        herdrRetry,
        quotaTestTail: quotaTail,
        phase: runState.phase || 'coding',
      })
    }
    return this.startWorkerRuntime({
      claim,
      guidance,
      herdrRole,
      herdrTaskId,
      herdrRetry,
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

  async reapFinishedHarnessTabs({ force = false } = {}) {
    const { planFinishedTabReap } = await importLib('finished-tab-reaper.mjs')
    const plan = planFinishedTabReap({
      workers: this.workers,
      workerHealth: this.state?.workerHealth || {},
      now: Date.now(),
      lastReapAt: this.lastFinishedTabReap || 0,
      force,
    })
    if (!plan.shouldReap) {
      // Still sweep Cursor Task mirror tabs — they are not worker-* panes and
      // otherwise stick as agent_status=working after the Task finishes.
      await this.reapCursorSubagentTabs({ force })
      return plan
    }
    try {
      const workspaceId = getFocusedWorkspaceId()
      closeAllDanglingHarnessShells(workspaceId)
      for (const tab of listHarnessWorkerTabs(workspaceId)) {
        closeDanglingShellPanes(tab.tab_id, plan.keepPaneIds)
        closeStaleHarnessPanesForProject(tab.tab_id, projectId, plan.keepPaneIds)
      }
      this.lastFinishedTabReap = Date.now()
    } catch {}
    await this.reapCursorSubagentTabs({ force: true })
    return plan
  }

  async reapCursorSubagentTabs({ force = false } = {}) {
    try {
      const {
        planCursorSubagentTabReap,
        applyCursorSubagentTabReap,
        loadCursorSubagentRegistry,
        logviewAliveForMeta,
        DEFAULT_ORPHAN_GRACE_MS,
      } = await importLib('cursor-subagent-tab-reaper.mjs')
      const now = Date.now()
      if (!force && this.lastCursorSubagentReap
        && now - this.lastCursorSubagentReap < 15_000) {
        return { shouldReap: false, reason: 'rate_limited' }
      }
      const registry = loadCursorSubagentRegistry()
      const panes = listPanes()
      let tabs = []
      try {
        const proc = spawnSync('herdr', ['tab', 'list'], { encoding: 'utf8', timeout: 5000 })
        if (proc.status === 0 && proc.stdout) {
          const parsed = JSON.parse(proc.stdout)
          tabs = parsed.result?.tabs || []
        }
      } catch {
        tabs = []
      }
      const plan = planCursorSubagentTabReap({
        registry,
        panes,
        tabs,
        now,
        orphanGraceMs: DEFAULT_ORPHAN_GRACE_MS,
        isLogviewAlive: (metaPath) => logviewAliveForMeta(metaPath),
      })
      if (!plan.shouldReap) {
        this.lastCursorSubagentReap = now
        return plan
      }
      const result = applyCursorSubagentTabReap(plan, { registry })
      this.lastCursorSubagentReap = now
      if (result.closed > 0) {
        await this.emit('cursor_subagent_tabs_reaped', {
          closed: result.closed,
          reasons: plan.closes.map((c) => ({ tabId: c.tabId, reason: c.reason })),
        }, false)
      }
      return { ...plan, ...result }
    } catch (error) {
      return { shouldReap: false, reason: 'error', error: String(error?.message || error) }
    }
  }

  async inspectHerdrAgentPresence() {
    const waitingReason = 'Harness worker needs human input'
    const paneSnapshot = this.config.display === 'herdr' ? createPaneSnapshot() : null
    for (const [key, worker] of [...this.workers]) {
      if (worker.type !== 'herdr' || !worker.paneId || !worker.agentName) continue
      if (!paneExists(worker.paneId, paneSnapshot)) continue
      const runState = await readJson(runStateFile(key), {})
      const terminal = ['complete', 'blocked', 'failed'].includes(runState.status)
        || runState.nextAction === 'release-claim'
      const tail = readPaneTail(worker.paneId, 60, paneSnapshot)
      const paneStatus = getPaneAgentStatus(worker.paneId, paneSnapshot)
      const waiting = detectPaneWaiting(tail, paneStatus)
      if (!terminal) {
        if (waiting) {
          reportHarnessAgent(worker.paneId, worker.agentName, 'blocked', waiting.reason, paneSnapshot)
          if (waiting.kind === 'prompt' || waiting.kind === 'blocked') {
            await this.input('context', waitingReason, {
              kind: waiting.kind,
              paneStatus,
              phase: runState.phase,
              nextAction: runState.nextAction,
              tail: tail.slice(-2000),
            }, key)
          }
        } else {
          let message = runState.childPid
            ? `${runState.phase || 'coding'} (agent pid ${runState.childPid})`
            : (runState.phase || runState.nextAction || 'orchestrator running')
          if (detectPaneMergeLockWait(tail)) {
            message = 'waiting for merge lock (another context is integrating)'
          }
          reportHarnessAgent(worker.paneId, worker.agentName, 'working', message, paneSnapshot)
          if (worker.tabId) {
            const taskId = (worker.featureIds && worker.featureIds[0]) || worker.context || key
            const retry = Math.max(1, Number(runState.attempt) || 1)
            const nextLabel = buildWorkerTabLabel({
              taskId,
              role: roleFromPhase(runState.phase || 'coding'),
              project: projectId,
              retry,
            })
            if (nextLabel !== worker.tabLabel) {
              renameWorkerTab(worker.tabId, nextLabel)
              worker.tabLabel = nextLabel
            }
          }
        }
      }
    }
  }

  async inspectStuckWorkers() {
    const paneSnapshot = this.config.display === 'herdr' ? createPaneSnapshot() : null
    const scrollMap = listPaneScroll(paneSnapshot)
    const prevScroll = this._paneScrollSample || new Map()
    this._paneScrollSample = scrollMap
    const lock = mergeLockHolder(repo)
    const lockAlive = lock.busy && lock.owner ? processAlive(Number(lock.owner)) : false
    const healthByContext = {}

    for (const [key, worker] of [...this.workers]) {
      const runState = await readJson(runStateFile(key), {})
      const now = Date.now()
      const heartbeatEpoch = Number(runState.heartbeatEpoch || 0)
      const runStateAgeMs = heartbeatEpoch > 0 ? now - heartbeatEpoch * 1000 : 0
      let lastAgentOutputAgeMs = null
      if (runState.lastAgentOutputAt) {
        const ts = Date.parse(runState.lastAgentOutputAt)
        const startedMs = worker.startedAt ? Date.parse(worker.startedAt) : NaN
        // Ignore timestamps from a prior run — they make MCP-warmup look instantly overdue.
        if (Number.isFinite(ts) && (!Number.isFinite(startedMs) || ts >= startedMs)) {
          lastAgentOutputAgeMs = now - ts
        }
      }
      const childAlive = Boolean(runState.childPid && processAlive(runState.childPid))
      let health
      let paneTail = ''

      if (worker.type === 'herdr' && worker.paneId && paneExists(worker.paneId, paneSnapshot)) {
        const scroll = scrollMap.get(worker.paneId) ?? 0
        const prev = prevScroll.get(worker.paneId)
        const scrollDelta = prev == null ? 0 : scroll - prev
        const tail = readPaneTail(worker.paneId, 60, paneSnapshot)
        paneTail = tail
        const paneStatus = getPaneAgentStatus(worker.paneId, paneSnapshot)
        health = assessLive({
          runStateAgeMs,
          childAlive,
          paneStatus,
          scrollDelta,
          tailText: tail,
          lastAgentOutputAgeMs,
          runStatus: runState.status || '',
          mergeHolderAlive: lockAlive,
          thresholds: { agentOutputStuckMs: this.config.stuckTimeoutMs },
        })
      } else {
        // Background workers: fall back to log/heartbeat age
        const stuck = await isWorkerStuck({
          logFile: worker.logFile,
          runState,
          thresholdMs: this.config.stuckTimeoutMs,
        })
        health = stuck
          ? { verdict: 'stuck', tailClass: 'unknown', reason: 'log/heartbeat stale', recycle: true }
          : { verdict: 'healthy', tailClass: 'unknown', reason: 'log/heartbeat fresh', recycle: false }
      }

      healthByContext[key] = {
        ...health,
        phase: runState.phase || null,
        childPid: runState.childPid || null,
        lastAgentOutputAt: runState.lastAgentOutputAt || null,
      }

      const prevHealth = this.state.workerHealth?.[key]
      if (!prevHealth || prevHealth.verdict !== health.verdict || prevHealth.tailClass !== health.tailClass) {
        await this.emit('worker_health', { context: key, ...health }, health.verdict === 'stuck')
        if (health.verdict === 'done' && worker.type === 'herdr') {
          await this.reapFinishedHarnessTabs({ force: true })
        }
      }

      if (!isWorkerStuckByHealth(health)) continue

      await this.emit('worker_stuck', {
        context: key,
        logFile: worker.logFile,
        phase: runState.phase,
        health,
      }, true)
      if (worker.type === 'herdr') {
        if (paneTail) await persistWorkerPaneTail(worker.logFile, paneTail)
        this.applyWorkerStop(worker)
      } else {
        this.applyWorkerStop(worker, 'SIGTERM')
        setTimeout(() => this.applyWorkerStop(worker, 'SIGKILL'), 5000)
      }
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

    const mergeInfo = lock.busy
      ? { owner: lock.owner || null, host: lock.host || null, holderAlive: lockAlive }
      : null
    await this.save({
      workerHealth: healthByContext,
      mergeLock: mergeInfo,
    })
  }

  async inspectHerdrWorkers() {
    const paneSnapshot = this.config.display === 'herdr' ? createPaneSnapshot() : null
    for (const [key, worker] of [...this.workers]) {
      if (worker.type !== 'herdr') continue
      const runState = await readJson(runStateFile(key), {})
      const terminal = ['complete', 'blocked', 'failed'].includes(runState.status)
        || runState.nextAction === 'release-claim'
      const gone = !paneExists(worker.paneId, paneSnapshot)
      const tail = gone ? '' : readPaneTail(worker.paneId, 80, paneSnapshot)
      const ownerAlive = Boolean(runState.ownerPid && processAlive(runState.ownerPid))
      const childAlive = processAlive(runState.childPid)
      const startedMs = worker.startedAt ? Date.parse(worker.startedAt) : 0
      const warmedUp = startedMs > 0 && Date.now() - startedMs > 45_000
      // Nested agent early-exit (verdict received → SIGTERM) leaves childPid dead while
      // the orchestrator is still applying the ledger. Never treat that as an orphan.
      const orphanShell = !terminal && !gone && !ownerAlive && (
        detectPaneOrchestratorExited(tail)
        || (runState.childPid && !childAlive)
        || (warmedUp && !childAlive && paneShowsIdleShell(tail))
        || (warmedUp && !runState.status && !runState.heartbeat)
      )
      // Herdr panes often keep a live shell after the orchestrator exits, so
      // "pane still exists" is not enough. Treat terminal Run State, a dead
      // child, or an idle shell with no run state as done — close the tab
      // immediately (finished agents must not linger), then finalize.
      if (!gone && !terminal && !orphanShell) continue
      if (!gone) {
        if (worker.agentName) {
          const state = terminal && runState.status === 'complete' ? 'done' : 'idle'
          reportHarnessAgent(worker.paneId, worker.agentName, state, runState.status || 'finished', paneSnapshot)
        }
        closeWorkerDisplay(worker.paneId, worker.tabId)
      } else if (worker.tabId) {
        closeWorkerDisplay(null, worker.tabId)
      }
      await this.trackClose(this.workerClosed(key, terminal ? 0 : 1, tail).catch((error) => this.crash(error)))
    }
  }

  async finalizeWorkerRecord(key, worker) {
    this.workers.delete(key)
    this.cleanupWorkerResources(worker)
    if (worker.type === 'herdr') {
      await this.reapFinishedHarnessTabs({ force: true })
    }
  }

  async workerClosed(key, code, capturedTail) {
    const worker = this.workers.get(key)
    if (!worker) return
    await this.releaseWorkerAdmission(worker.governorReservationId)
    if (this.stopping) {
      if (worker.log) {
        await new Promise((done) => { worker.log.once('finish', done); worker.log.end() })
      }
      this.workers.delete(key)
      this.cleanupWorkerResources(worker)
      if (worker.type === 'herdr') await this.reapFinishedHarnessTabs({ force: true })
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
      prevTailClass: this.state.workerHealth?.[key]?.tailClass,
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
      herdrRole: 'goal-review',
      herdrTaskId: 'goal-review',
      herdrRetry: Math.max(1, Number(queued?.attempts) || 1),
      startedEvent: 'goal_review_started',
      phase: 'goal-review',
    })
  }

  async summary(snapshot, cap) {
    const now = Date.now()
    if (now - this.lastSummary < this.config.summaryMinutes * 60_000) return
    this.lastSummary = now
    const contexts = []
    for (const context of snapshot.claims) {
      const runState = await readJson(runStateFile(context), {})
      contexts.push({ context, status: runState.status, phase: runState.phase, attempt: runState.attempt, nextAction: runState.nextAction })
    }
    await this.emit('progress', { ...snapshot.counts, workers: this.workers.size, capacity: cap, contexts })
  }

  /**
   * Hybrid empty-fleet recovery: clear mechanical blockers (ghost runs, dead locks)
   * when the fleet is empty but work remains. Admission below re-admits when slots allow.
   */
  async repairEmptyFleetActionable({ external, snapshot }) {
    const active = this.workers.size + external
    if (active > 0) return { repaired: false, ghosts: [], recoverable: null, external }

    const fleet = await fleetForWakeTriage(this.state)
    if (!isEmptyFleetActionable(null, fleet)) {
      return { repaired: false, ghosts: fleet.ghostClaims || [], recoverable: null, external }
    }

    const ghosts = fleet.ghostClaims || []
    const staleLocks = clearStaleGeneratorLocks(repo)
    const recovery = planRuntimeRecovery({
      active,
      fleet,
      ghostClaims: ghosts,
      staleLocks,
      crashCounts: this.state.crashCounts,
      snapshotCounts: snapshot?.counts || this.state.progress || {},
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
      await this.emit(event.kind, {
        ...event.detail,
        ghostContexts: event.detail.ghostContexts || ghostContexts,
        staleLocks: event.detail.staleLocks || staleLocks.map((row) => row.lock),
      }, event.immediate)
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
    await this.rehydrateHerdrWorkers()
    await this.inspectHerdrAgentPresence()
    await this.inspectHerdrWorkers()
    await this.reapFinishedHarnessTabs()
    await this.inspectStuckWorkers()
    let { external, recoverable } = await this.inspectClaims()
    const preSnapshot = await this.snapshot()
    const emptyRepair = await this.repairEmptyFleetActionable({ external, snapshot: preSnapshot })
    if (emptyRepair.recoverable) {
      external = emptyRepair.external
      recoverable = emptyRepair.recoverable
    }
    const active = this.workers.size + external
    const cap = await capacity(this.config, active)
    const snapshot = await this.snapshot()
    await this.summary(snapshot, cap)
    await this.save({ capacity: cap, progress: snapshot.counts })
    try {
      const { maybeCompactControlJournal } = await importLib('control-journal.mjs')
      await maybeCompactControlJournal(root, { minTail: 100, lease: this.lease() })
    } catch {}
    if (this.state.status === 'paused' || this.state.status === 'needs_input') return
    let slots = cap.available
    const { attempts: retryAttempts } = drainRetryQueue(this.state.retryQueue, slots)
    for (const { context, retry } of retryAttempts) {
      // Rehydrated herdr workers (or an external live orchestrator) already own
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
      // a later tick can force-resume; rehydrate already ran above.
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
      while (!this.stopping && this.state.status !== 'stopped' && this.state.status !== 'complete') {
        this.tickDirty = false
        try {
          await this.tick()
        } catch (error) {
          // Keep the supervisor alive through transient herdr/git/fs failures.
          // A thrown tick used to fall into finally and close every live herdr pane.
          try {
            await this.emit('supervisor_tick_failed', { error: error.message || String(error) }, true)
            await this.save({ lastError: error.message || String(error) })
          } catch {}
        }
        if (options.once === 'true') break
        const delay = nextTickDelay({ pollMs: this.config.pollMs, dirty: this.tickDirty })
        await this.waitForNextTick(delay)
      }
      this.stopping = true
      await this.save({ status: this.state.status })
    } finally {
      this.stopping = true
      this.stopTickWatchers()
      // Herdr workers outlive the supervisor process — never close their panes
      // here. inspectHerdrWorkers closes panes only when Run State is terminal
      // or the shell is idle. Background children still get SIGTERM.
      for (const worker of this.workers.values()) {
        if (worker.type === 'herdr') continue
        try { worker.child?.stdout?.destroy?.() } catch {}
        try { worker.child?.stderr?.destroy?.() } catch {}
        this.applyWorkerStop(worker, 'SIGTERM')
      }
      const deadline = Date.now() + 5000
      while ([...this.workers.values()].some((worker) => worker.type !== 'herdr') && Date.now() < deadline) {
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
    // SIGINT / unexpected SIGTERM: keep herdr orchestrators for rehydrate.
    // Explicit `harness-control stop`: tear down panes, process trees, and
    // worktree runtimes (tsx/next/compose) so they cannot exhaust host RAM.
    for (const worker of this.workers.values()) {
      if (worker.type === 'herdr' && !operatorStop) continue
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
    const isHerdr = worker.display === 'herdr' || worker.type === 'herdr'
    const paneOk = isHerdr && worker.paneId ? paneExists(worker.paneId) : null
    workers[context] = {
      ...worker,
      context,
      type: worker.display === 'herdr' ? 'herdr' : (worker.type || worker.display || 'background'),
      live: resolveWorkerLive(worker, { processAlive, runState, paneExists: paneOk }),
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
      type: saved.display === 'herdr' ? 'herdr' : 'background',
      childPid: runState.childPid || null,
      ownedResources: {
        port: saved.port,
        worktree: saved.worktree,
        processGroup: processGroupForWorker(saved, runState),
      },
    }
    : {
      type: runState.childPid ? 'background' : 'herdr',
      paneId: null,
      tabId: null,
      childPid: runState.childPid || runState.ownerPid || null,
      port: runState.port,
      worktree: runState.worktree,
      ownedResources: {
        port: runState.port,
        worktree: runState.worktree,
        processGroup: processGroupForWorker({ type: runState.childPid ? 'background' : 'herdr' }, runState),
      },
    }
  const signal = options.signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM'
  const stopPlan = planWorkerStop(worker, { signal })
  if (stopPlan.kind === 'close_display') {
    closeWorkerDisplay(stopPlan.paneId, stopPlan.tabId)
    if (stopPlan.alsoTerminatePid) terminateProcessTree(stopPlan.alsoTerminatePid, signal)
  } else if (stopPlan.kind === 'terminate_tree') {
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
      }
    } catch {
      return {}
    }
  })()
  return {
    id: target.id,
    root: target.repo,
    state: current,
    eventsTip,
    events,
    ghostClaims,
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

async function reapCursorSubagentsCmd() {
  const supervisor = new Supervisor(baseConfig())
  const result = await supervisor.reapCursorSubagentTabs({ force: true })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
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
  if (commandName === 'reap-cursor-subagents') return reapCursorSubagentsCmd()
  if (commandName === 'run') {
    const supervisor = new Supervisor(baseConfig())
    process.on('SIGINT', () => supervisor.stop('SIGINT'))
    process.on('SIGTERM', () => supervisor.stop('SIGTERM'))
    return supervisor.run()
  }
  fatal(`unknown command: ${commandName}`)
}

await main()
