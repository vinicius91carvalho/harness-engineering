#!/usr/bin/env node
import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
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
if (!commandName) fatal('usage: harness-control.mjs {start|run|status|capacity|events|ack|respond|quota|pause|resume|stop} --repo <path> ...')

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
const { isProviderQuotaLimited } = await importLib('verdict.mjs')
const { computeCapacity } = await importLib('capacity.mjs')
const { scopeClaims, runStateFile: runStatePath } = await importLib('project-keys.mjs')
const { readWorkerResult } = await importLib('worker-result.mjs')
const { cleanupBrowserOrphans } = await importLib('browser-cleanup.mjs')
const { isWorkerStuck, stuckThresholdMs } = await importLib('stuck-worker.mjs')
const { interpretWorkerOutcome } = await importLib('worker-outcome.mjs')
const { planWorkerClosedActions } = await importLib('worker-lifecycle.mjs')
const { drainRetryQueue, applyRetryResumeOutcome, shouldFinalizePendingGoal } = await importLib('supervisor-tick.mjs')
const { pruneOrphanPendingInputs, isCrashBoundContext } = await importLib('supervisor-claims.mjs')
const { selectClaim, resumeClaim, releaseClaim } = await importLib('claim-lease.mjs')
const { integrationBranchName, integrationBranchRef } = await importLib('integration-branch.mjs')
const { resolveDisplayMode, spawnAgent, closePane, readPaneTail, getPaneAgentStatus, paneExists, reportHarnessAgent, detectPaneWaiting, getFocusedWorkspaceId, listHarnessWorkerTabs, closeDanglingShellPanes, closeAllDanglingHarnessShells } =
  await import(pathToFileURL(join(supervisorLib, 'herdr-spawn.mjs')).href)
const orchestrator = join(generatorDir, 'orchestrator.mjs')
const reconciler = join(generatorDir, 'reconcile.mjs')

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

const commonRaw = git(['rev-parse', '--git-common-dir']).stdout.trim()
const commonGit = isAbsolute(commonRaw) ? commonRaw : resolve(repo, commonRaw)
const herdrLayoutLock = join(commonGit, 'harness-control', 'herdr-layout.lock')
const projectPrefix = git(['rev-parse', '--show-prefix']).stdout.trim().replace(/\/$/, '')
const projectId = projectPrefix ? projectPrefix.replace(/[^a-zA-Z0-9_-]/g, '_') : 'root'
const root = projectPrefix ? join(commonGit, 'harness-control', projectId) : join(commonGit, 'harness-control')
const stateFile = join(root, 'state.json')
const eventFile = join(root, 'events.jsonl')
const responseDir = join(root, 'responses')
const cursorDir = join(root, 'cursors')
const quotaFile = join(root, 'quota.json')
const controlFile = join(root, 'control.json')
const logDir = join(root, 'logs')
const supervisorLog = join(root, 'supervisor.log')
const supervisorLock = join(root, 'supervisor.lock')
const supervisorOwner = join(supervisorLock, 'owner.json')

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
  try {
    return (await readFile(eventFile, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch { return [] }
}

function consumerFile() {
  const consumer = options.consumer || ''
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(consumer)) fatal('--consumer must contain 1-64 letters, digits, underscores, or hyphens')
  return join(cursorDir, `${consumer}.json`)
}

function processAlive(pid) {
  if (!Number(pid)) return false
  try { process.kill(Number(pid), 0); return true } catch { return false }
}

async function acquireSupervisorLock(token, pid, status, leaseSeconds) {
  await mkdir(root, { recursive: true })
  for (;;) {
    try {
      await mkdir(supervisorLock)
      await atomicJson(supervisorOwner, { token, pid, host: hostname(), status, heartbeatEpoch: Math.floor(Date.now() / 1000) })
      return
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    const owner = await readJson(supervisorOwner, {})
    if (owner.token === token) {
      await atomicJson(supervisorOwner, { ...owner, pid, host: hostname(), status, heartbeatEpoch: Math.floor(Date.now() / 1000) })
      return
    }
    const age = Math.floor(Date.now() / 1000) - Number(owner.heartbeatEpoch || 0)
    // A hard-killed supervisor's pid can be reused by an unrelated process, so pid-alive alone
    // must not count as live: also require the heartbeat (refreshed every tick) to be fresh.
    const live = owner.host === hostname() ? (age < leaseSeconds && (processAlive(owner.pid) || owner.status === 'starting')) : age < leaseSeconds
    if (live) fatal(`supervisor lease is owned by ${owner.host || 'unknown'} pid ${owner.pid || 'unknown'}`)
    const stale = `${supervisorLock}.stale.${randomUUID()}`
    try { await rename(supervisorLock, stale) } catch { continue }
    await rm(stale, { recursive: true, force: true })
  }
}

async function updateSupervisorLock(token, status = 'running', pid = process.pid) {
  const owner = await readJson(supervisorOwner, {})
  if (owner.token !== token) {
    if (status === 'stopping') return
    fatal('supervisor lease was lost')
  }
  await atomicJson(supervisorOwner, { ...owner, pid, host: hostname(), status, heartbeatEpoch: Math.floor(Date.now() / 1000) })
}

async function releaseSupervisorLock(token) {
  const owner = await readJson(supervisorOwner, {})
  if (owner.token !== token) return
  const released = `${supervisorLock}.released.${randomUUID()}`
  try { await rename(supervisorLock, released) } catch { return }
  await rm(released, { recursive: true, force: true })
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

function baseConfig() {
  return {
    host: workerHost(),
    display: resolveDisplayMode(options),
    maxWorkers: Math.max(1, Math.floor(number('max-workers', 4))),
    quotaWorkers: Math.max(0, Math.floor(number('quota-workers', 2))),
    cpuPerWorker: Math.max(0.25, number('cpu-per-worker', 2)),
    // ponytail: workers are thin clients of a *remote* model (observed ~250MB
    // RSS steady; occasional local-build spikes ride on the machine's swap), so
    // 1GB/worker with a 1GB reserve still leaves ~4x headroom while avoiding the
    // old 2GB reserve + 2GB/worker gate that idled typical dev boxes at 0 slots.
    // freeMb is re-read every tick and maxWorkers caps a single subproject, so
    // this self-limits and can't runaway-OOM. Raise --memory-per-worker-mb or
    // --reserve-memory-mb for a genuinely heavyweight local-build host.
    memoryPerWorkerMb: Math.max(128, number('memory-per-worker-mb', 1024)),
    reserveMemoryMb: Math.max(0, number('reserve-memory-mb', 1024)),
    maxLoadRatio: Math.max(0.1, number('max-load-ratio', 0.85)),
    quotaCooldownSeconds: Math.max(1, number('quota-cooldown-seconds', 300)),
    summaryMinutes: Math.max(1, number('summary-minutes', 20)),
    stuckTimeoutMs: Math.max(60_000, number('stuck-timeout-ms', stuckThresholdMs())),
    pollMs: Math.max(250, number('poll-ms', 2000)),
    supervisorLeaseSeconds: Math.max(10, number('supervisor-lease-seconds', 30)),
  }
}

async function capacity(config, active = 0) {
  return computeCapacity(config, quotaFile, active)
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
    this.state = null
    this.workers = new Map()
    this.stopping = false
    this.lastSummary = 0
    this.finalizing = new Set()
    this.pendingGoalResult = null
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
        agentName: worker.agentName || null,
        display: worker.type || 'background',
        context: worker.context, featureIds: worker.featureIds,
        worktree: worker.worktree, port: worker.port, logFile: worker.logFile, startedAt: worker.startedAt,
      }])),
    }
    await atomicJson(stateFile, this.state)
    await updateSupervisorLock(this.leaseToken, this.stopping ? 'stopping' : this.state.status)
  }

  async emit(kind, data = {}, immediate = false) {
    const events = await readEvents()
    const id = (events.at(-1)?.id || 0) + 1
    const event = { id, runId: this.state.runId, at: new Date().toISOString(), kind, immediate, ...data }
    await mkdir(root, { recursive: true })
    await appendFile(eventFile, `${JSON.stringify(event)}\n`)
    return event
  }

  async input(scope, reason, detail, context = null, choices = ['retry', 'pause', 'abort']) {
    const existing = Object.values(this.state.pendingInputs || {}).find((item) => item.status === 'pending' && item.scope === scope && item.context === context && item.reason === reason)
    if (existing) return existing
    const event = await this.emit('input_required', { scope, context, reason, detail, choices }, true)
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
    await acquireSupervisorLock(this.leaseToken, process.pid, 'running', this.config.supervisorLeaseSeconds)
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
      const clean = git(['status', '--porcelain'], true).stdout.trim() === ''
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
  }

  async snapshot() {
    const queue = await readJson(join(repo, 'feature_list.json'), [])
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
      } else if (processAlive(runState.ownerPid) || processAlive(runState.childPid)) {
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
    if (this.workers.has(key)) return
    const args = [orchestrator, '--host', this.config.host, '--repo', repo, '--workdir', claim.worktree,
      '--context', claim.context, '--port', String(claim.port), '--features', claim.featureIds.join(',')]
    if (guidance) args.push('--guidance', guidance)
    const logFile = join(logDir, `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}.log`)
    // Deterministic CI hook: skip the real orchestrator and close as if the worker
    // reported a provider usage limit. Avoids macOS races where stderr is lost before close.
    if (process.env.HARNESS_TEST_SUPERVISOR_QUOTA === '1') {
      const quotaTail = "ERROR: You've hit your usage limit. Try again at Jul 9th, 2026 12:17 AM.\n"
      await mkdir(logDir, { recursive: true })
      await writeFile(logFile, quotaTail)
      this.workers.set(key, {
        type: 'background', child: null, log: null, logFile,
        context: claim.context, featureIds: claim.featureIds,
        worktree: claim.worktree, port: claim.port, startedAt: new Date().toISOString(),
      })
      await this.emit('worker_started', { context: claim.context, featureIds: claim.featureIds, pid: null })
      await this.save()
      await this.trackClose(this.workerClosed(key, 1, quotaTail).catch((error) => this.crash(error)))
      return
    }
    if (this.config.display === 'herdr') {
      const agentName = `worker-${claim.project || projectId}-${key}`
      const { paneId } = spawnAgent(agentName, [process.execPath, ...args], { cwd: claim.worktree, layoutLockDir: herdrLayoutLock })
      reportHarnessAgent(paneId, agentName, 'working', 'orchestrator starting')
      this.workers.set(key, {
        type: 'herdr', paneId, agentName, logFile, context: claim.context, featureIds: claim.featureIds,
        worktree: claim.worktree, port: claim.port, startedAt: new Date().toISOString(),
      })
      await this.emit('worker_started', { context: claim.context, featureIds: claim.featureIds, paneId, display: 'herdr' })
      await this.save()
      return
    }
    const child = spawn(process.execPath, args, { cwd: claim.worktree, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const log = createWriteStream(logFile, { flags: 'w' })
    let tail = ''
    const collect = (chunk) => { const text = String(chunk); log.write(text); tail = `${tail}${text}`.slice(-64_000) }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    child.on('error', (error) => collect(`${error.stack || error.message}\n`))
    this.workers.set(key, { type: 'background', child, log, logFile, context: claim.context, featureIds: claim.featureIds, worktree: claim.worktree, port: claim.port, startedAt: new Date().toISOString() })
    await this.emit('worker_started', { context: claim.context, featureIds: claim.featureIds, pid: child.pid })
    await this.save()
    child.on('close', (code) => this.trackClose(this.workerClosed(key, code, tail).catch((error) => this.crash(error))))
  }

  async completeGoal(result) {
    this.pendingGoalResult = null
    await this.emit('run_completed', { summary: result.summary }, true)
    await this.save({ status: 'complete', completedAt: new Date().toISOString() })
  }

  async inspectHerdrAgentPresence() {
    const waitingReason = 'Harness worker needs human input'
    try {
      const workspaceId = getFocusedWorkspaceId()
      closeAllDanglingHarnessShells(workspaceId)
      const keep = new Set([...this.workers.values()].filter((worker) => worker.type === 'herdr' && worker.paneId).map((worker) => worker.paneId))
      for (const tab of listHarnessWorkerTabs(workspaceId)) closeDanglingShellPanes(tab.tab_id, keep)
    } catch {}
    for (const [key, worker] of [...this.workers]) {
      if (worker.type !== 'herdr' || !worker.paneId || !worker.agentName) continue
      if (!paneExists(worker.paneId)) continue
      const runState = await readJson(runStateFile(key), {})
      const terminal = ['complete', 'blocked', 'failed'].includes(runState.status)
        || runState.nextAction === 'release-claim'
      const tail = readPaneTail(worker.paneId, 60)
      const paneStatus = getPaneAgentStatus(worker.paneId)
      const waiting = detectPaneWaiting(tail, paneStatus)
      if (!terminal) {
        if (waiting) {
          reportHarnessAgent(worker.paneId, worker.agentName, 'blocked', waiting.reason)
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
          const message = runState.childPid
            ? `${runState.phase || 'coding'} (agent pid ${runState.childPid})`
            : (runState.phase || runState.nextAction || 'orchestrator running')
          reportHarnessAgent(worker.paneId, worker.agentName, 'working', message)
        }
      }
    }
  }

  async inspectStuckWorkers() {
    for (const [key, worker] of [...this.workers]) {
      const runState = await readJson(runStateFile(key), {})
      if (worker.type === 'herdr') {
        if (!paneExists(worker.paneId)) continue
        // Never kill on herdr blocked alone — harness reports blocked for merge locks and
        // between pi/codex turns. Trust orchestrator heartbeat and pane exit instead.
        if (!(await isWorkerStuck({ logFile: worker.logFile, runState, thresholdMs: this.config.stuckTimeoutMs }))) continue
      } else {
        if (!(await isWorkerStuck({ logFile: worker.logFile, runState, thresholdMs: this.config.stuckTimeoutMs }))) continue
      }
      await this.emit('worker_stuck', { context: key, logFile: worker.logFile, phase: runState.phase }, true)
      if (worker.type === 'herdr') closePane(worker.paneId)
      else try { worker.child.kill('SIGTERM') } catch {}
      if (worker.type !== 'herdr') {
        setTimeout(() => { try { worker.child.kill('SIGKILL') } catch {} }, 5000)
      }
      this.state.retryQueue ||= {}
      this.state.retryQueue[key] = {
        guidance: 'Supervisor detected a stuck worker with no recent log or heartbeat activity; resume after confirming the worktree is healthy',
        attempts: this.state.retryQueue[key]?.attempts || 0,
      }
      await this.save()
    }
  }

  async inspectHerdrWorkers() {
    for (const [key, worker] of [...this.workers]) {
      if (worker.type !== 'herdr') continue
      if (paneExists(worker.paneId)) continue
      const tail = readPaneTail(worker.paneId)
      const runState = await readJson(runStateFile(key), {})
      const terminal = ['complete', 'blocked', 'failed'].includes(runState.status)
        || runState.nextAction === 'release-claim'
      await this.trackClose(this.workerClosed(key, terminal ? 0 : 1, tail).catch((error) => this.crash(error)))
    }
  }

  async workerClosed(key, code, capturedTail) {
    const worker = this.workers.get(key)
    if (!worker) return
    if (this.stopping) {
      if (worker.log) {
        await new Promise((done) => { worker.log.once('finish', done); worker.log.end() })
      }
      this.workers.delete(key)
      cleanupBrowserOrphans({ port: worker.port, workdir: worker.worktree })
      return
    }
    if (worker.log) {
      await new Promise((done) => { worker.log.once('finish', done); worker.log.end() })
    }
    let tail = capturedTail
    try { tail = (await readFile(worker.logFile, 'utf8')).slice(-64_000) || tail } catch {}
    const persisted = await readWorkerResult(runStateFile(key))
    const runState = await readJson(runStateFile(key), {})
    const queue = await readJson(join(repo, 'feature_list.json'), [])
    const result = interpretWorkerOutcome({
      key,
      exitCode: code,
      tail,
      persisted,
      runState,
      featureIds: worker.featureIds,
      queue,
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
        this.workers.delete(key)
        cleanupBrowserOrphans({ port: worker.port, workdir: worker.worktree })
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
      case 'blocked_input':
        await this.input(plan.scope, plan.reason, plan.detail, plan.context)
        break
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
        this.workers.delete(key)
        cleanupBrowserOrphans({ port: worker.port, workdir: worker.worktree })
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
    this.workers.delete(key)
    cleanupBrowserOrphans({ port: worker.port, workdir: worker.worktree })
    await this.save()
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
        this.state.retryQueue[request.context] = { guidance: response.guidance || 'Retry after user review' }
        delete this.state.crashCounts?.[request.context]
        await this.save()
      } else if (response.action === 'retry') {
        await this.save({ status: 'running' })
      } else if (response.action === 'amend') {
        await atomicJson(controlFile, { status: 'paused', at: new Date().toISOString() })
        await this.save({ status: 'paused' })
      }
    }
  }

  async maybeGoalReview(snapshot, active, available) {
    if (!snapshot.queue.length || snapshot.counts.integrated !== snapshot.counts.total || active > 0 || available < 1 || this.workers.has('goal-review')) return false
    const goalStateName = projectPrefix ? `${projectId}--goal-review.json` : 'goal-review.json'
    const goalState = await readJson(join(commonGit, 'harness-runs', goalStateName), {})
    const head = git(['rev-parse', integrationBranchName(repo)], true).stdout.trim()
    const clean = git(['status', '--porcelain'], true).stdout.trim() === ''
    if (goalState.status === 'complete' && goalState.reviewedHead === head && clean) {
      await this.save({ status: 'complete' })
      return true
    }
    const worktree = await integrationCheckout()
    const claim = { context: 'goal-review', worktree, port: 5170, featureIds: [] }
    const args = [orchestrator, '--host', this.config.host, '--repo', repo, '--workdir', worktree,
      '--mode', 'goal-review', '--context', 'goal-review', '--port', '5170']
    const logFile = join(logDir, `goal-review-${Date.now()}.log`)
    if (this.config.display === 'herdr') {
      const agentName = `worker-${projectId}-goal-review`
      const { paneId } = spawnAgent(agentName, [process.execPath, ...args], { cwd: worktree, layoutLockDir: herdrLayoutLock })
      reportHarnessAgent(paneId, agentName, 'working', 'goal review starting')
      this.workers.set('goal-review', { type: 'herdr', paneId, agentName, logFile, ...claim, startedAt: new Date().toISOString() })
      await this.emit('goal_review_started', { paneId, display: 'herdr' })
      await this.save()
      return true
    }
    const child = spawn(process.execPath, args,
      { cwd: worktree, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const log = createWriteStream(logFile, { flags: 'w' })
    let tail = ''
    const collect = (chunk) => { const text = String(chunk); log.write(text); tail = `${tail}${text}`.slice(-64_000) }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    child.on('error', (error) => collect(`${error.stack || error.message}\n`))
    this.workers.set('goal-review', { type: 'background', child, log, logFile, ...claim, startedAt: new Date().toISOString() })
    child.on('close', (code) => this.trackClose(this.workerClosed('goal-review', code, tail).catch((error) => this.crash(error))))
    await this.emit('goal_review_started')
    await this.save()
    return true
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

  async tick() {
    const control = await readJson(controlFile, {})
    const mayResume = control.status === 'running' && ['paused', 'interrupted'].includes(this.state.status)
    if ((['paused', 'stopped'].includes(control.status) || mayResume) && control.status !== this.state.status) {
      await this.save({ status: control.status })
    }
    await this.processResponses()
    if (this.stopping || this.state.status === 'stopped' || this.state.status === 'complete') return
    await this.inspectHerdrAgentPresence()
    await this.inspectHerdrWorkers()
    await this.inspectStuckWorkers()
    const { external, recoverable } = await this.inspectClaims()
    const active = this.workers.size + external
    const cap = await capacity(this.config, active)
    const snapshot = await this.snapshot()
    await this.summary(snapshot, cap)
    await this.save({ capacity: cap, progress: snapshot.counts })
    if (this.state.status === 'paused' || this.state.status === 'needs_input') return
    let slots = cap.available
    const { attempts: retryAttempts } = drainRetryQueue(this.state.retryQueue, slots)
    for (const { context, retry } of retryAttempts) {
      if (slots < 1) break
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
      }
    }
    if (shouldFinalizePendingGoal(this.state.retryQueue, this.pendingGoalResult)) {
      await this.completeGoal(this.pendingGoalResult)
      return
    }
    if (this.pendingGoalResult) return
    if (await this.maybeGoalReview(snapshot, active, slots)) return
    for (const item of recoverable) {
      if (slots < 1) break
      if (await this.resumeClaim(item.context)) slots--
    }
    for (; slots > 0; slots--) {
      const claim = await this.claim()
      if (!claim) break
      await this.spawnWorker(claim)
    }
  }

  async run() {
    try {
      await this.initialize()
      await this.processResponses()
      if (this.stopping || this.state.status === 'paused' || this.state.status === 'stopped') {
        this.stopping = true
        await this.save({ status: this.state.status })
        return
      }
      const validation = exec(process.execPath, [reconciler, repo, '--check'], repo, true)
      if (validation.status !== 0) {
        await this.input('goal', 'Planning or reconciliation required', { error: (validation.stderr || validation.stdout).trim() }, null, ['amend', 'abort'])
        this.stopping = true
        await this.save({ status: 'needs_input' })
        return
      }
      while (!this.stopping && this.state.status !== 'stopped' && this.state.status !== 'complete') {
        await this.tick()
        if (options.once === 'true') break
        await new Promise((done) => setTimeout(done, this.config.pollMs))
      }
      this.stopping = true
      await this.save({ status: this.state.status })
    } finally {
      this.stopping = true
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
    for (const worker of this.workers.values()) {
      if (worker.type === 'herdr') closePane(worker.paneId)
      else try { worker.child.kill('SIGTERM') } catch {}
    }
    await this.emit('supervisor_stopped', { signal }, true)
    const control = await readJson(controlFile, {})
    await this.save({ status: control.status === 'stopped' ? 'stopped' : 'interrupted', lastSignal: signal })
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
  const clean = git(['status', '--porcelain'], true).stdout.trim() === ''
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
  const token = randomUUID()
  await acquireSupervisorLock(token, null, 'starting', leaseSeconds)
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
    await updateSupervisorLock(token, 'starting', child.pid)
    const latest = await readJson(stateFile, {})
    await atomicJson(stateFile, { ...latest, repo, supervisorPid: child.pid, supervisorHost: hostname() })
    process.stdout.write(`${JSON.stringify({ started: true, pid: child.pid, stateFile, eventFile })}\n`)
  } catch (error) {
    await releaseSupervisorLock(token)
    throw error
  }
}

async function respond() {
  const id = Number(options.event)
  if (!id || !options.action) fatal('--event and --action are required')
  const events = await readEvents()
  const request = events.find((event) => event.id === id && event.kind === 'input_required')
  if (!request) fatal(`unknown Input Request ${id}`)
  if (!request.choices.includes(options.action)) fatal(`action must be one of: ${request.choices.join(', ')}`)
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

async function setStatus(status) {
  const state = await readJson(stateFile, null)
  if (!state) fatal('no supervisor state')
  await atomicJson(controlFile, { status, at: new Date().toISOString() })
  if (status === 'stopped' && state.supervisorHost === hostname() && processAlive(state.supervisorPid)) process.kill(state.supervisorPid, 'SIGTERM')
  process.stdout.write(`${JSON.stringify({ status })}\n`)
}

async function main() {
  if (commandName === 'start') return start()
  if (commandName === 'status') return process.stdout.write(`${JSON.stringify(await readJson(stateFile, { status: 'not_started' }), null, 2)}\n`)
  if (commandName === 'capacity') return process.stdout.write(`${JSON.stringify(await capacity(baseConfig(), Number(options.active || 0)), null, 2)}\n`)
  if (commandName === 'events') {
    const cursor = options.consumer ? await readJson(consumerFile(), {}) : {}
    const after = Math.max(Number(options.after || 0), Number(cursor.eventId || 0))
    return process.stdout.write(`${JSON.stringify((await readEvents()).filter((event) => event.id > after), null, 2)}\n`)
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
  if (commandName === 'run') {
    const supervisor = new Supervisor(baseConfig())
    process.on('SIGINT', () => supervisor.stop('SIGINT'))
    process.on('SIGTERM', () => supervisor.stop('SIGTERM'))
    return supervisor.run()
  }
  fatal(`unknown command: ${commandName}`)
}

await main()
