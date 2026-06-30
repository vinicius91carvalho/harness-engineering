#!/usr/bin/env node
import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { availableParallelism, freemem, hostname, loadavg, totalmem } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
const defaultGenerator = resolve(dirname(scriptFile), '..', '..', 'generator')
const repo = resolve(options.repo || '.')
const generatorDir = resolve(options['generator-dir'] || defaultGenerator)
const claimScript = join(generatorDir, 'claim.sh')
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
const root = join(commonGit, 'harness-control')
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

async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return fallback }
}

async function atomicJson(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.tmp.${process.pid}.${randomUUID()}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temporary, file)
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
    const live = owner.host === hostname() ? processAlive(owner.pid) || (owner.status === 'starting' && age < leaseSeconds) : age < leaseSeconds
    if (live) fatal(`supervisor lease is owned by ${owner.host || 'unknown'} pid ${owner.pid || 'unknown'}`)
    const stale = `${supervisorLock}.stale.${randomUUID()}`
    try { await rename(supervisorLock, stale) } catch { continue }
    await rm(stale, { recursive: true, force: true })
  }
}

async function updateSupervisorLock(token, status = 'running', pid = process.pid) {
  const owner = await readJson(supervisorOwner, {})
  if (owner.token !== token) fatal('supervisor lease was lost')
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
  for (const host of ['codex', 'claude', 'opencode']) {
    if (exec('sh', ['-c', `command -v ${host}`], repo, true).status === 0) return host
  }
  fatal('no worker host found; pass --host claude|codex|opencode')
}

function baseConfig() {
  return {
    host: workerHost(),
    maxWorkers: Math.max(1, Math.floor(number('max-workers', 4))),
    quotaWorkers: Math.max(0, Math.floor(number('quota-workers', 2))),
    cpuPerWorker: Math.max(0.25, number('cpu-per-worker', 2)),
    memoryPerWorkerMb: Math.max(128, number('memory-per-worker-mb', 2048)),
    reserveMemoryMb: Math.max(0, number('reserve-memory-mb', 2048)),
    maxLoadRatio: Math.max(0.1, number('max-load-ratio', 0.85)),
    quotaCooldownSeconds: Math.max(1, number('quota-cooldown-seconds', 300)),
    summaryMinutes: Math.max(1, number('summary-minutes', 15)),
    pollMs: Math.max(250, number('poll-ms', 2000)),
    supervisorLeaseSeconds: Math.max(10, number('supervisor-lease-seconds', 30)),
  }
}

async function capacity(config, active = 0) {
  active = Math.max(0, Math.floor(active))
  const cores = availableParallelism()
  const cpuSlots = Math.max(0, Math.floor(cores / config.cpuPerWorker))
  const freeMb = Math.floor(freemem() / 1024 / 1024)
  const memorySlots = Math.max(0, Math.floor((freeMb - config.reserveMemoryMb) / config.memoryPerWorkerMb))
  const loadRatio = loadavg()[0] / Math.max(1, cores)
  const quota = await readJson(quotaFile, {})
  const now = Math.floor(Date.now() / 1000)
  const quotaPaused = Number(quota.pauseUntil || 0) > now
  const quotaSlots = quotaPaused ? 0 : Math.max(0, Math.floor(Number(quota.maxWorkers ?? config.quotaWorkers)))
  const limit = loadRatio >= config.maxLoadRatio ? 0 : Math.max(0, Math.min(config.maxWorkers, cpuSlots, memorySlots, quotaSlots))
  return {
    limit,
    available: Math.max(0, limit - active),
    active,
    cpu: { cores, loadRatio: Number(loadRatio.toFixed(2)), maxLoadRatio: config.maxLoadRatio, slots: cpuSlots },
    memory: { freeMb, totalMb: Math.floor(totalmem() / 1024 / 1024), reserveMb: config.reserveMemoryMb, perWorkerMb: config.memoryPerWorkerMb, slots: memorySlots },
    quota: { slots: quotaSlots, configuredSlots: config.quotaWorkers, pauseUntil: quota.pauseUntil || null },
    configuredMax: config.maxWorkers,
  }
}

function parseObject(text) {
  const trimmed = text.trim()
  const candidates = [trimmed, ...trimmed.split('\n').reverse()]
  const start = trimmed.indexOf('{'), end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1))
  for (const candidate of candidates) {
    try { const value = JSON.parse(candidate); if (value && typeof value === 'object') return value } catch {}
  }
  return null
}

async function mainCheckout() {
  const lines = git(['worktree', 'list', '--porcelain']).stdout.split('\n')
  let worktree = ''
  for (const line of lines) {
    if (line.startsWith('worktree ')) worktree = line.slice(9)
    if (line === 'branch refs/heads/main') return worktree
  }
  fatal('main must be checked out in a worktree')
}

class Supervisor {
  constructor(config) {
    this.config = config
    this.leaseToken = process.env.HARNESS_SUPERVISOR_TOKEN || randomUUID()
    this.state = null
    this.workers = new Map()
    this.stopping = false
    this.lastSummary = 0
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
        pid: worker.child.pid, context: worker.context, featureIds: worker.featureIds,
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
    this.state = {
      ...previous,
      runId: previous.runId || randomUUID(),
      repo,
      config: this.config,
      status: Object.values(previous.pendingInputs || {}).some((item) => item.status === 'pending' && item.scope === 'goal')
        ? 'needs_input' : paused ? 'paused' : 'running',
      pendingInputs: previous.pendingInputs || {},
      retryQueue: previous.retryQueue || {},
      startedAt: previous.startedAt || new Date().toISOString(),
    }
    await this.save()
    if (!previous.startedAt) await this.emit('run_started', { host: this.config.host, config: this.config })
  }

  async snapshot() {
    const queue = await readJson(join(repo, 'feature_list.json'), [])
    const claims = await readJson(join(commonGit, 'generator-claims.json'), {})
    const counts = { total: queue.length, implemented: 0, qa: 0, integrated: 0, blocked: 0 }
    for (const item of queue) {
      if (item.implementation === true) counts.implemented++
      if (item.qa === true) counts.qa++
      if (item.integration === true) counts.integrated++
    }
    counts.blocked = Object.values(claims).filter((claim) => claim.status === 'blocked').length
    return { counts, claims: Object.keys(claims), queue }
  }

  async inspectClaims() {
    const claims = await readJson(join(commonGit, 'generator-claims.json'), {})
    let external = 0
    const recoverable = []
    for (const [context, claim] of Object.entries(claims)) {
      if (this.workers.has(context)) continue
      const runState = await readJson(join(commonGit, 'harness-runs', `${context.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`), {})
      if (this.state.retryQueue?.[context]) continue
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
    const resumed = exec('bash', [claimScript, 'resume', repo, context, String(process.pid), force], repo, true)
    const claim = parseObject(resumed.stdout)
    if (claim) await this.spawnWorker(claim, guidance)
    return Boolean(claim)
  }

  async claim() {
    const result = exec('bash', [claimScript, 'select-claim', repo, 'all', '', String(process.pid)], repo, true)
    return result.status === 0 ? parseObject(result.stdout) : null
  }

  async spawnWorker(claim, guidance = '') {
    const key = claim.context
    if (this.workers.has(key)) return
    const args = [orchestrator, '--host', this.config.host, '--repo', repo, '--workdir', claim.worktree,
      '--context', claim.context, '--port', String(claim.port), '--features', claim.featureIds.join(','),
      '--claim-script', claimScript]
    if (guidance) args.push('--guidance', guidance)
    const child = spawn(process.execPath, args, { cwd: claim.worktree, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const logFile = join(logDir, `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}-${child.pid}.log`)
    const log = createWriteStream(logFile, { flags: 'w' })
    let tail = ''
    const collect = (chunk) => { const text = String(chunk); log.write(text); tail = `${tail}${text}`.slice(-64_000) }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    child.on('error', (error) => collect(`${error.stack || error.message}\n`))
    this.workers.set(key, { child, log, logFile, context: claim.context, featureIds: claim.featureIds, worktree: claim.worktree, port: claim.port, startedAt: new Date().toISOString() })
    await this.emit('worker_started', { context: claim.context, featureIds: claim.featureIds, pid: child.pid })
    await this.save()
    child.on('close', (code) => this.workerClosed(key, code, tail).catch((error) => this.crash(error)))
  }

  async workerClosed(key, code, capturedTail) {
    const worker = this.workers.get(key)
    if (!worker) return
    await new Promise((done) => { worker.log.once('finish', done); worker.log.end() })
    let tail = capturedTail
    try { tail = (await readFile(worker.logFile, 'utf8')).slice(-64_000) || tail } catch {}
    let result = parseObject(tail)
    if (!result) {
      const runState = await readJson(join(commonGit, 'harness-runs', `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`), {})
      if (key === 'goal-review' && runState.status === 'complete' && runState.phase === 'complete') {
        result = { goal: true, summary: runState.lastResult, durable: true }
      } else if (key === 'goal-review' && runState.status === 'complete' && runState.phase === 'defects-found') {
        const queue = await readJson(join(repo, 'feature_list.json'), [])
        result = { goal: false, reopened: queue.filter((item) => item.integration !== true).map((item) => item.id), summary: runState.lastResult, durable: true }
      } else if (runState.status === 'blocked') {
        result = { blocked: true, summary: runState.lastResult, durable: true }
      } else if (key !== 'goal-review' && runState.status === 'complete') {
        const queue = await readJson(join(repo, 'feature_list.json'), [])
        const selected = queue.filter((item) => worker.featureIds.includes(item.id))
        if (selected.length === worker.featureIds.length && selected.every((item) => item.integration === true)) {
          result = { total: selected.length, passed: selected.length, stuck: [], durable: true }
        }
      }
    }
    const rateLimited = /(?:\b429\b|rate.?limit|quota exceeded|too many requests)/i.test(tail)
    if (rateLimited) {
      const pauseUntil = Math.floor(Date.now() / 1000) + this.config.quotaCooldownSeconds
      const quota = await readJson(quotaFile, {})
      await atomicJson(quotaFile, { ...quota, pauseUntil, reason: 'worker reported provider rate limit' })
      await this.emit('quota_wait', { context: key, pauseUntil }, true)
    }
    if (result?.goal === true) {
      await this.emit('run_completed', { summary: result.summary }, true)
      await this.save({ status: 'complete', completedAt: new Date().toISOString() })
    } else if (result?.reopened?.length) {
      await this.emit('goal_defects', { reopened: result.reopened, defects: result.defects }, true)
    } else if (result?.blocked || result?.stuck?.length) {
      await this.input(key === 'goal-review' ? 'goal' : 'context', result.summary || result.stuck?.[0]?.reason || 'Execution blocked', result, key === 'goal-review' ? null : key)
    } else if (code === 0 && result?.stuck?.length === 0) {
      exec('bash', [claimScript, 'release', repo, key], repo, true)
      await this.emit('context_completed', { context: key, passed: result.passed, total: result.total })
    } else {
      const goal = key === 'goal-review'
      await this.input(goal ? 'goal' : 'context', `Worker exited with code ${code}`, { log: worker.logFile }, goal ? null : key)
    }
    this.workers.delete(key)
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
    const worktree = await mainCheckout()
    const claim = { context: 'goal-review', worktree, port: 5170, featureIds: [] }
    const child = spawn(process.execPath, [orchestrator, '--host', this.config.host, '--repo', repo, '--workdir', worktree,
      '--mode', 'goal-review', '--context', 'goal-review', '--port', '5170', '--claim-script', claimScript],
      { cwd: worktree, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const logFile = join(logDir, `goal-review-${Date.now()}-${child.pid}.log`)
    const log = createWriteStream(logFile, { flags: 'w' })
    let tail = ''
    const collect = (chunk) => { const text = String(chunk); log.write(text); tail = `${tail}${text}`.slice(-64_000) }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    child.on('error', (error) => collect(`${error.stack || error.message}\n`))
    this.workers.set('goal-review', { child, log, logFile, ...claim, startedAt: new Date().toISOString() })
    child.on('close', (code) => this.workerClosed('goal-review', code, tail).catch((error) => this.crash(error)))
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
      const runState = await readJson(join(commonGit, 'harness-runs', `${context.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`), {})
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
    const { external, recoverable } = await this.inspectClaims()
    const active = this.workers.size + external
    const cap = await capacity(this.config, active)
    const snapshot = await this.snapshot()
    await this.summary(snapshot, cap)
    await this.save({ capacity: cap, progress: snapshot.counts })
    if (this.state.status === 'paused' || this.state.status === 'needs_input') return
    if (await this.maybeGoalReview(snapshot, active, cap.available)) return
    let slots = cap.available
    for (const [context, retry] of Object.entries(this.state.retryQueue || {})) {
      if (slots < 1) break
      if (await this.resumeClaim(context, 'force', retry.guidance)) {
        delete this.state.retryQueue[context]
        slots--
        await this.save()
      }
    }
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
        if (options.once === 'true' && this.state.status === 'needs_input') break
        await new Promise((done) => setTimeout(done, this.config.pollMs))
      }
      this.stopping = true
      await this.save({ status: this.state.status })
    } finally {
      await releaseSupervisorLock(this.leaseToken)
    }
  }

  async crash(error) {
    await this.emit('supervisor_failed', { error: error.message }, true)
    await this.save({ status: 'needs_input', lastError: error.message })
  }

  async stop(signal) {
    this.stopping = true
    for (const worker of this.workers.values()) worker.child.kill('SIGTERM')
    await this.emit('supervisor_stopped', { signal }, true)
    const control = await readJson(controlFile, {})
    await this.save({ status: control.status === 'stopped' ? 'stopped' : 'interrupted', lastSignal: signal })
    await releaseSupervisorLock(this.leaseToken)
    process.exit(130)
  }
}

async function start() {
  await mkdir(root, { recursive: true })
  const current = await readJson(stateFile, {})
  const desired = await readJson(controlFile, {})
  const goalState = await readJson(join(commonGit, 'harness-runs', 'goal-review.json'), {})
  const head = git(['rev-parse', 'main'], true).stdout.trim()
  const statusResult = git(['status', '--porcelain'], true)
  const clean = statusResult.stdout.trim() === ''
  if (current.status === 'complete' && clean && goalState.reviewedHead === head) {
    return process.stdout.write(`${JSON.stringify({ started: false, status: 'complete', reviewedHead: head })}\n`)
  }
  if (current.status !== 'complete') process.stderr.write(`harness-control: start status=${current.status}\n`)
  if (!clean) process.stderr.write(`harness-control: start dirty=[${statusResult.stdout.trim()}]\n`)
  if (goalState.reviewedHead !== head) process.stderr.write(`harness-control: start reviewedHead mismatch (goal=${goalState.reviewedHead || 'none'}, head=${head})\n`)
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
