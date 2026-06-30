#!/usr/bin/env node
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
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
if (!['claude', 'codex', 'opencode'].includes(options.host)) fail('--host must be claude, codex, or opencode')
if (!options.workdir) fail('--workdir is required')

options.workdir = resolve(options.workdir)
options.repo = resolve(options.repo || options.workdir)
const claimScript = options['claim-script'] || resolve(dirname(fileURLToPath(import.meta.url)), 'claim.sh')
const wanted = (options.features || '').split(',').filter(Boolean)
const commands = {
  claude: (prompt) => ['claude', ['-p', prompt]],
  codex: (prompt) => ['codex', ['exec', prompt]],
  opencode: (prompt) => ['opencode', ['run', prompt]],
}
const reconcileScript = resolve(dirname(fileURLToPath(import.meta.url)), 'reconcile.mjs')

function command(program, args, cwd = options.workdir, allowFailure = false) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8' })
  if (!allowFailure && result.status !== 0) fail((result.stderr || result.stdout || `${program} failed`).trim())
  return result
}

function git(args, cwd = options.workdir, allowFailure = false) {
  return command('git', args, cwd, allowFailure)
}

const commonGitRaw = git(['rev-parse', '--git-common-dir']).stdout.trim()
const commonGit = isAbsolute(commonGitRaw) ? commonGitRaw : resolve(options.workdir, commonGitRaw)
const runDir = join(commonGit, 'harness-runs')
const context = options.context || 'goal-review'
const stateFile = join(runDir, `${context.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)
const leaseToken = randomUUID()
let child = null
let state = {}
let heartbeatTimer

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
    if (child?.pid) child.kill('SIGTERM')
    const value = {
      ...state, context, leaseToken, ownerHost: hostname(), ownerPid: null, childPid: null,
      status: 'interrupted', lastResult: `orchestrator received ${signal}`,
      heartbeat: new Date().toISOString(), heartbeatEpoch: Math.floor(Date.now() / 1000),
    }
    const temporary = `${stateFile}.tmp.${process.pid}`
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
  const candidates = [trimmed, ...trimmed.split('\n').reverse()]
  const start = trimmed.indexOf('{'), end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1))
  for (const candidate of candidates) {
    try { const parsed = JSON.parse(candidate); if (parsed && typeof parsed === 'object') return parsed } catch {}
  }
  return null
}

async function evidence(id, attempt, kind, detail) {
  const dir = join(runDir, 'evidence', context.replace(/[^a-zA-Z0-9_-]/g, '_'))
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${String(id).replace(/[^a-zA-Z0-9_-]/g, '_')}-${attempt}-${kind.toLowerCase()}.log`)
  await writeFile(file, detail)
  return file
}

async function runAgent(kind, prompt, id, attempt, cwd = options.workdir) {
  const specFile = join(cwd, 'project_specs.xml')
  try { await readFile(specFile) } catch (error) { fail(`cannot reference project_specs.xml: ${error.message}`) }
  const referencedPrompt = `${prompt}\n\nBefore acting, read ${specFile} and verify that the repository contains every structure and file it requires. Handle missing scaffold artifacts according to your role.`
  const [program, args] = commands[options.host](referencedPrompt)
  await writeState({ phase: kind.toLowerCase(), currentFeatureId: id, attempt, childPid: null })
  return await new Promise((resolveRun) => {
    child = spawn(program, args, {
      cwd,
      env: {
        ...process.env,
        PORT: String(options.port),
        FRONTEND_PORT: String(options.port),
        BACKEND_PORT: String(Number(options.port) + 1000),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = '', timedOut = false
    const registered = writeState({ childPid: child.pid }).catch((error) => child.kill('SIGTERM') || fail(error.message))
    child.stdout.on('data', (data) => { stdout = `${stdout}${data}`.slice(-1_000_000) })
    child.stderr.on('data', (data) => { stderr = `${stderr}${data}`.slice(-1_000_000) })
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, Number(process.env.HARNESS_AGENT_TIMEOUT_MS || 1_800_000))
    child.on('close', async (code) => {
      clearTimeout(timeout)
      await registered
      const detail = (stderr || stdout || '').trim()
      const parsed = parseObject(stdout || stderr)
      const diagnostic = parsed
        ? `${JSON.stringify(parsed, null, 2)}\n`
        : `${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ''}`.slice(-16_000)
      const artifact = await evidence(id, attempt, kind, diagnostic)
      child = null
      await writeState({ childPid: null, evidence: artifact })
      resolveRun({ ok: code === 0 && !timedOut, code, detail, parsed, artifact, timedOut })
    })
    child.on('error', async (error) => {
      clearTimeout(timeout)
      child = null
      await writeState({ childPid: null, lastResult: error.message })
      resolveRun({ ok: false, detail: error.message, parsed: null })
    })
  })
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

function featurePrompt(kind, feature, attempt, repairPlan = null, workdir = options.workdir) {
  const base = `WORKDIR=${workdir}\nPORT=${options.port}\nWork Item id=${feature.id} context=${feature.context}\n` +
    `Acceptance Checks=${(feature.acceptance_checks || []).join(',')}\nDescription=${feature.description || ''}\n`
  if (kind === 'CODING') return `You are the coding-agent. Implement exactly this Work Item, then stop.\n${base}` +
    `${repairPlan ? `Follow this Repair Plan from the orchestrator:\n${JSON.stringify(repairPlan)}\n` : ''}` +
    'Read the exact queue entry and Workflow Journal. Bring up the app on the assigned ports, implement the smallest complete fix, run black-box behavior tests, set only this item implementation=true after success, update the journal concisely, and commit. Return one JSON object: {"id":"...","implementation":true|false,"notes":"..."}.'
  if (kind === 'QA') return `You are the qa-agent. Independently test exactly this Work Item in its isolated worktree.\n${base}` +
    'Use a real browser for UI or real HTTP for API behavior. On pass set qa=true. On any defect set implementation=false and qa=false. Update the journal concisely and commit. Return only JSON: {"id":"...","qa":true|false,"implementation":true|false,"defects":["expected ...; observed ...; evidence ..."]}.'
  if (kind === 'INTEGRATION_QA') return `You are the qa-agent performing Integrated Verification on latest main.\n${base}` +
    'Run the mapped Acceptance Checks and core smoke behavior at real external boundaries. On pass set integration=true for this Work Item. On any defect set implementation=false, qa=false, integration=false. Update the journal concisely and commit. Return only JSON: {"id":"...","integration":true|false,"implementation":true|false,"defects":["expected ...; observed ...; evidence ..."]}.'
  if (kind === 'REPAIR_PLAN') return `Act as the orchestrator repair planner. Do not modify files. Diagnose the QA Defect Report against the Work Item and repository.\n${base}` +
    `Defect Report=${JSON.stringify(repairPlan)}\nReturn only concise JSON: {"summary":"...","rootCause":"...","actions":["..."],"validation":["..."]}.`
  if (kind === 'MERGE') return `You are resolving integration conflicts for one verified Checkpoint.\n${base}` +
    'Resolve only the current Git conflicts. Keep Work Items append-only; a newer Defect Report overrides older true flags. Run affected black-box checks, commit, and return only JSON: {"resolved":true|false,"notes":"..."}.'
}

async function block(feature, attempt, reason, defects = []) {
  await stopApp(options.workdir)
  const queue = await updateFeature(options.workdir, feature.id, {
    implementation: false, qa: false, integration: false, retries: Math.max(Number(feature.retries || 0), attempt),
  })
  const file = await journal(options.workdir, 'Blocked Work Item', {
    Attempt: `${attempt}/3`, WorkItem: feature.id, Outcome: reason, Defects: defects,
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
    Attempt: `${attempt}/3`, WorkItem: feature.id,
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
  for (let tries = 0; tries < 600; tries++) {
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
    Attempt: `${attempt}/3`, WorkItem: feature.id, Outcome: 'isolated QA passed', NextAction: 'Integrated Verification',
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
    const current = (await readFeatures(integrationDir)).list.find((item) => String(item.id) === String(feature.id))
    if (verified.ok && current?.implementation === true && current?.qa === true && current?.integration === true) {
      const file = await journal(integrationDir, 'Integrated Verification passed', {
        Attempt: `${attempt}/3`, WorkItem: feature.id, AcceptanceChecks: feature.acceptance_checks || [],
        Outcome: 'passed on integrated main', Evidence: verified.artifact, NextAction: 'next Ready Work Item',
      })
      commitPaths(integrationDir, [file], `verify(harness): integrate ${feature.id}`)
      git(['merge', '--no-edit', 'main'], options.workdir)
      await writeState({ phase: 'integrated', nextAction: 'next-work-item', lastResult: 'Integrated Verification passed' })
      return { passed: true }
    }

    const defects = verified.parsed?.defects?.length ? verified.parsed.defects : [verified.detail.slice(-2000) || 'Integrated Verification failed']
    await updateFeature(integrationDir, feature.id, { implementation: false, qa: false, integration: false, retries: attempt })
    const file = await journal(integrationDir, 'Integrated Verification defect', {
      Attempt: `${attempt}/3`, WorkItem: feature.id, Defects: defects, Evidence: verified.artifact, NextAction: 'Repair Plan',
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
  const initial = await readFeatures()
  const selected = wanted.map((id) => initial.list.find((feature) => String(feature.id) === id))
  if (selected.some((feature) => !feature)) fail(`unknown Work Item id in --features: ${wanted.join(',')}`)
  const results = []

  for (const original of selected) {
    let current = (await readFeatures()).list.find((item) => String(item.id) === String(original.id))
    if (current.integration === true) { results.push({ id: current.id, status: 'passed' }); continue }
    const resumingCurrent = String(state.currentFeatureId) === String(current.id)
    let attempt = resumingCurrent ? Number(state.attempt || current.retries + 1 || 1) : Number(current.retries || 0) + 1
    let repairPlan = resumingCurrent ? state.repairPlan : null
    let operationalFailures = 0

    if (attempt > 3) { results.push(await block(current, 3, 'Attempt budget already exhausted')); break }
    if (resumingCurrent && state.nextAction === 'repair-plan' && state.defectReport) {
      repairPlan = await planRepair(current, attempt, state.defectReport)
      attempt++
    }
    while (attempt <= 3) {
      current = (await readFeatures()).list.find((item) => String(item.id) === String(original.id))
      if (current.implementation !== true) {
        await writeState({ currentFeatureId: current.id, attempt, nextAction: 'coding', repairPlan })
        const coded = await runAgent('CODING', featurePrompt('CODING', current, attempt, repairPlan), current.id, attempt)
        current = (await readFeatures()).list.find((item) => String(item.id) === String(original.id))
        if (!coded.ok || current.implementation !== true) {
          operationalFailures++
          if (operationalFailures >= 3) { results.push(await block(current, attempt, 'coding agent failed three times', [coded.detail])); break }
          continue
        }
        operationalFailures = 0
        await writeState({ appPid: await appPid(options.workdir) })
      }

      if (current.qa !== true) {
        await writeState({ nextAction: 'qa', phase: 'qa' })
        const checked = await runAgent('QA', featurePrompt('QA', current, attempt), current.id, attempt)
        current = (await readFeatures()).list.find((item) => String(item.id) === String(original.id))
        if (!checked.ok && !checked.parsed) {
          operationalFailures++
          if (operationalFailures >= 3) { results.push(await block(current, attempt, 'QA agent failed three times', [checked.detail])); break }
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
          if (attempt >= 3) { results.push(await block(current, attempt, 'QA failed after Attempt 3', defectReport.defects)); break }
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
      if (attempt >= 3) { results.push(await block(current, attempt, 'Integrated Verification failed after Attempt 3', integrated.defects)); break }
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
  const dirtyBefore = git(['status', '--porcelain'], options.workdir).stdout.trim()
  if (dirtyBefore) fail('Goal Review requires a clean integrated main checkout')
  const headBefore = git(['rev-parse', 'HEAD'], options.workdir).stdout.trim()
  if (state.status === 'complete' && state.phase === 'complete' && state.reviewedHead === headBefore) {
    return { goal: true, reused: true, summary: state.lastResult, defects: [] }
  }
  await writeState({ status: 'running', phase: 'goal-review', nextAction: 'goal-review', attempt: 1 })
  heartbeatTimer = setInterval(() => writeState().catch(() => {}), 15_000)
  const prompt = 'You are the independent Goal Review agent. Read project_specs.xml, especially Project Goal and every stable Acceptance Check. On integrated main, exercise every check and cross-feature primary journeys through a real browser or real HTTP. Do not trust existing flags. Do not modify product code. Return only JSON: {"goal":true|false,"summary":"...","acceptanceCheckIds":["AC-..."],"defects":["expected ...; observed ...; evidence ..."]}.'
  const reviewed = await runAgent('GOAL_REVIEW', prompt, 'goal', 1)
  const verdict = reviewed.parsed
  const dirtyAfter = git(['status', '--porcelain'], options.workdir).stdout.trim()
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
