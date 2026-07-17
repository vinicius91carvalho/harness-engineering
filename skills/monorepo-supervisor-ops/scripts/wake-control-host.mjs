#!/usr/bin/env node
/**
 * Control Host wake bridge — the user's representative without Cursor /loop.
 *
 * Duties:
 * 1. Progress briefings (desktop notify) when counters/claims move — keep the
 *    operator informed at zero LLM tokens.
 * 2. Judgment wakes (stuck, crash-loop, input_required, empty-fleet, …) —
 *    notify critically and optionally invoke the judgment agent to fix/escalate.
 * 3. Ack fold/absorb so the journal consumer stays caught up — but only after
 *    --invoke-agent produced a visible post-condition (see wake-ack.mjs).
 *
 * usage:
 *   node wake-control-host.mjs --repo /path [--notify] [--invoke-agent] [--brief]
 *   node wake-control-host.mjs --repo /path [--dry-run] [--catch-up]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const out = {
    repo: null,
    notify: false,
    brief: true,
    invokeAgent: process.env.HARNESS_WAKE_INVOKE === '1',
    dryRun: false,
    catchUp: false,
    consumer: process.env.HARNESS_WAKE_CONSUMER || 'control-host-wake',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--repo') out.repo = argv[++i]
    else if (a === '--notify') out.notify = true
    else if (a === '--brief') out.brief = true
    else if (a === '--no-brief') out.brief = false
    else if (a === '--invoke-agent') out.invokeAgent = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--catch-up') out.catchUp = true
    else if (a === '--consumer') out.consumer = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

function resolveControl() {
  const candidates = [
    process.env.HARNESS_CONTROL,
    join(here, '../../supervisor/scripts/harness-control.mjs'),
    join(here, '../../../harness-supervisor/scripts/harness-control.mjs'),
    `${process.env.HOME}/.agents/skills/supervisor/scripts/harness-control.mjs`,
    `${process.env.HOME}/.agents/skills/harness-supervisor/scripts/harness-control.mjs`,
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  throw new Error('harness-control.mjs not found; set HARNESS_CONTROL')
}

function resolveLib(name) {
  const candidates = [
    join(here, `../../supervisor/lib/${name}`),
    join(here, `../../../harness-supervisor/lib/${name}`),
    `${process.env.HOME}/.agents/skills/supervisor/lib/${name}`,
    `${process.env.HOME}/.agents/skills/harness-supervisor/lib/${name}`,
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

function run(node, args, env) {
  return spawnSync(node, args, { encoding: 'utf8', env, maxBuffer: 20 * 1024 * 1024 })
}

function notifyDesktop(title, body, urgency = 'critical') {
  const env = { ...process.env }
  if (!env.DBUS_SESSION_BUS_ADDRESS && env.XDG_RUNTIME_DIR) {
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${env.XDG_RUNTIME_DIR}/bus`
  }
  if (!env.DISPLAY) env.DISPLAY = ':0'
  try {
    spawnSync('notify-send', [`--urgency=${urgency}`, '-a', 'Harness', title, body], {
      stdio: 'ignore',
      env,
    })
  } catch { /* optional */ }
}

function gitCommonDir(repo) {
  const r = spawnSync('git', ['-C', repo, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' })
  if (r.status !== 0) return join(repo, '.git')
  const out = String(r.stdout || '').trim()
  return out.startsWith('/') ? out : resolve(repo, out)
}

function judgmentPrompt({ repo, wakes, statusSummary }) {
  const lines = wakes.map((e) => {
    const triage = e.wakeTriage || {}
    return `- #${e.id} ${e.kind}: ${triage.reason || e.reason || ''} ${JSON.stringify(e.detail || e).slice(0, 280)}`
  })
  return [
    'You are the Control Host — the human operator\'s representative for this harness run.',
    'Your job: keep work moving to completion, fix issues intelligently, escalate only when playbooks fail,',
    'and keep the operator informed (desktop notify already fired for this wake).',
    'Process supervisor + ops-remediate own mechanical admission/recovery — do not re-poll in a /loop.',
    `REPO=${repo}`,
    '',
    'Wake events requiring your judgment:',
    ...lines,
    '',
    statusSummary ? `Status snapshot:\n${statusSummary}` : '',
    '',
    'Playbook:',
    '1. ALWAYS open the latest Goal Review evidence under .git/harness-evidence/**/goal-review/',
    '   and .git/harness-runs/goal-review.result.json — bottom JSON verdict is pass/fail truth.',
    '2. If goal_review_failed / dirty-gate + AC defects: reopen named WIs (ledger flags false),',
    '   seed retryQueue[context] with expected/observed pairs, clear retryQueue[goal-review],',
    '   admit repair before another Goal Review. Harness .harness/wi-ac-* probe dirt is not product.',
    '3. Auto-fix when safe: respond --action retry with evidence-backed guidance; release dead locks;',
    '   recycle stuck/silent workers; prefer MERGE/IV-only retries for integration thrash.',
    '4. Escalate to the human with input_required / notify only when you cannot fix it.',
    '5. Do not stop while remaining WIs > 0 or needsGoalReviewRetry unless paused/complete or goal input blocks you.',
    'Exit when wakes are handled or escalated.',
  ].filter(Boolean).join('\n')
}

function readJsonSafe(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function claimRowsFromStatus(st) {
  const rows = []
  for (const [context, worker] of Object.entries(st.workers || {})) {
    rows.push({
      context,
      phase: st.workerHealth?.[context]?.phase || worker.phase,
      featureIds: worker.featureIds || worker.tasks,
    })
  }
  return rows
}

function fleetNeedsGoalReviewRetry(st) {
  const projects = st?.fleetSnapshot?.projects || []
  if (projects.some((p) => p.needsGoalReviewRetry)) return true
  return Boolean(st?.retryGoalReview || st?.retryQueue?.['goal-review'])
}

function loadStatus(control, repo, env) {
  const statusRun = run(process.execPath, [control, 'status', '--repo', repo, '--host', env.HARNESS_HOST || 'agent'], env)
  if (statusRun.status !== 0) return null
  try { return JSON.parse(statusRun.stdout) } catch { return null }
}

async function maybeProgressBrief({ args, repo, control, env, controlDir, st }) {
  const briefPath = resolveLib('representative-brief.mjs')
  if (!briefPath || !st) return { briefed: false }
  const { planProgressBrief } = await import(`file://${briefPath}`)
  const statePath = join(controlDir, 'representative-brief.json')
  const previous = readJsonSafe(statePath, null)
  const progress = st.progress || {}
  const remaining = Math.max(0, Number(progress.total || 0) - Number(progress.integrated || 0))
  const pendingInputs = Object.values(st.pendingInputs || {}).filter((i) => i.status === 'pending').length
  const plan = planProgressBrief({
    previous,
    progress,
    status: st.status,
    claims: claimRowsFromStatus(st),
    pendingInputs,
    remaining,
    needsGoalReviewRetry: fleetNeedsGoalReviewRetry(st),
    goalReviewFailed: st.lastGoalReviewFailure || null,
    now: Date.now(),
    minIntervalMs: Number(process.env.HARNESS_BRIEF_INTERVAL_MS || 15 * 60_000),
  })
  if (!args.dryRun) {
    writeFileSync(statePath, `${JSON.stringify(plan.snapshot, null, 2)}\n`)
  }
  if (plan.brief && (args.notify || args.brief)) {
    notifyDesktop(plan.title, plan.body, plan.urgency)
  }
  return { briefed: plan.brief, title: plan.title, body: plan.body }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.repo) {
    process.stdout.write(
      'usage: wake-control-host.mjs --repo <path> [--notify] [--brief|--no-brief] [--invoke-agent] [--dry-run] [--catch-up]\n',
    )
    process.exit(args.help ? 0 : 2)
  }
  const repo = resolve(args.repo)
  const control = resolveControl()
  const env = { ...process.env }
  const consumer = args.consumer
  const commonGitEarly = gitCommonDir(repo)
  const cursorDir = join(commonGitEarly, 'harness-control', 'cursors')
  const cursorPath = join(cursorDir, `${consumer}.json`)
  const controlDir = join(commonGitEarly, 'harness-control')
  mkdirSync(controlDir, { recursive: true })
  const logPath = join(controlDir, 'wake-control-host.jsonl')

  // Always load status for briefing + judgment context.
  let st = loadStatus(control, repo, env)
  const statusBefore = st

  // First run: seed cursor at journal tip (unless --catch-up).
  if (!args.catchUp && !existsSync(cursorPath)) {
    const tipRun = run(process.execPath, [control, 'events', '--repo', repo], env)
    if (tipRun.status !== 0) {
      process.stderr.write(tipRun.stderr || `events tip probe failed (exit ${tipRun.status})\n`)
      process.exit(tipRun.status || 2)
    }
    let tipId = 0
    try {
      const all = JSON.parse(tipRun.stdout || '[]')
      if (Array.isArray(all) && all.length) {
        tipId = Math.max(...all.map((e) => Number(e.id) || 0))
      }
    } catch { /* ignore */ }
    if (tipId > 0 && !args.dryRun) {
      const ack = run(process.execPath, [
        control, 'ack', '--repo', repo, '--consumer', consumer, '--event', String(tipId),
      ], env)
      if (ack.status !== 0) {
        process.stderr.write(ack.stderr || `seed ack failed (exit ${ack.status})\n`)
        process.exit(ack.status || 2)
      }
    }
    const brief = await maybeProgressBrief({ args, repo, control, env, controlDir, st })
    const seeded = {
      ok: true,
      woke: false,
      reason: 'seeded-cursor-at-tip',
      ackedThrough: tipId,
      brief,
    }
    appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...seeded })}\n`)
    process.stdout.write(`${JSON.stringify(seeded)}\n`)
    process.exit(0)
  }

  const eventsRun = run(process.execPath, [
    control, 'events', '--repo', repo, '--consumer', consumer,
  ], env)
  if (eventsRun.status !== 0) {
    process.stderr.write(eventsRun.stderr || `events exit ${eventsRun.status}\n`)
    process.exit(eventsRun.status || 2)
  }

  let events = []
  try {
    events = JSON.parse(eventsRun.stdout || '[]')
  } catch (error) {
    process.stderr.write(`events JSON parse failed: ${error.message}\n`)
    process.exit(2)
  }

  let classifyFn = (event) => event.wakeTriage || { action: event.immediate ? 'wake' : 'absorb', reason: 'attached-or-immediate' }
  let dedupeJudgmentWakes = (wakes) => wakes
  let isJudgmentWake = (event) => {
    const kind = String(event.kind || '')
    return !['progress', 'worker_started', 'worker_closed', 'worker_health', 'context_completed', 'host_remediation', 'supervisor_preflight'].includes(kind)
      && (event.wakeTriage?.action === 'wake' || event.immediate === true)
  }
  let planWakeAck = null
  let fleetSnapshotForWakeTriage = null
  const triagePath = resolveLib('wake-triage.mjs')
  const ackPath = resolveLib('wake-ack.mjs')
  if (ackPath) {
    try {
      const mod = await import(`file://${ackPath}`)
      planWakeAck = mod.planWakeAck
      fleetSnapshotForWakeTriage = mod.fleetSnapshotForWakeTriage
    } catch { /* optional */ }
  }
  if (triagePath) {
    try {
      const mod = await import(`file://${triagePath}`)
      const projectId = st?.projectId || st?.fleetSnapshot?.projects?.find((p) => p.id)?.id || 'root'
      const fleet = typeof fleetSnapshotForWakeTriage === 'function'
        ? fleetSnapshotForWakeTriage(st || {}, projectId)
        : (st?.fleetSnapshot?.projects?.find((p) => p.id === 'root')
          || st?.fleetSnapshot?.projects?.[0]
          || st?.fleetSnapshot
          || null)
      classifyFn = (event) => mod.classify(event, fleet)
      if (typeof mod.dedupeJudgmentWakes === 'function') dedupeJudgmentWakes = mod.dedupeJudgmentWakes
    } catch { /* attached */ }
  }
  const briefLib = resolveLib('representative-brief.mjs')
  if (briefLib) {
    try {
      const mod = await import(`file://${briefLib}`)
      isJudgmentWake = mod.isJudgmentWake
    } catch { /* fallback */ }
  }

  const classified = (Array.isArray(events) ? events : []).map((e) => ({
    ...e,
    wakeTriage: e.wakeTriage || classifyFn(e),
  }))
  const wakes = classified.filter((e) => e.wakeTriage.action === 'wake')
  const judgmentWakes = dedupeJudgmentWakes(wakes.filter((e) => isJudgmentWake(e)))
  const maxId = classified.length
    ? Math.max(...classified.map((e) => Number(e.id) || 0))
    : 0

  const brief = await maybeProgressBrief({ args, repo, control, env, controlDir, st })

  if (judgmentWakes.length === 0) {
    if (!args.dryRun && maxId > 0) {
      run(process.execPath, [
        control, 'ack', '--repo', repo, '--consumer', consumer, '--event', String(maxId),
      ], env)
    }
    const result = {
      ok: true,
      woke: false,
      reason: classified.length ? 'fold-absorb' : 'no-events',
      eventCount: classified.length,
      ackedThrough: maxId || null,
      brief,
    }
    appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...result })}\n`)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    process.exit(0)
  }

  const wakeSummary = judgmentWakes.map((e) => `${e.kind}#${e.id}`).join(', ')
  const statusSummary = st
    ? JSON.stringify({
      status: st.status,
      progress: st.progress,
      pendingInputs: Object.values(st.pendingInputs || {}).filter((i) => i.status === 'pending').length,
      lastRemediation: st.lastRemediation,
      lastGoalReviewFailure: st.lastGoalReviewFailure || null,
    }, null, 2)
    : ''

  const result = {
    ok: true,
    woke: true,
    reason: 'judgment-wake',
    wakes: judgmentWakes.map((e) => ({ id: e.id, kind: e.kind, reason: e.wakeTriage?.reason })),
    wakeSummary,
    dryRun: args.dryRun,
    brief,
  }

  // Chat ≠ wake: durable Control Host owns remediation. Notify that ops path
  // is handling it; escalate only if invoke-noop / playbook miss.
  if (args.notify || args.invokeAgent) {
    const body = args.invokeAgent
      ? `${wakeSummary}\nDurable Control Host is remediating (ops-remediate --invoke-agent). Cursor chat is optional overlay — escalate only if this wake repeats.`
      : wakeSummary
    notifyDesktop('Harness needs you (representative)', body, 'critical')
  }

  if (args.invokeAgent && !args.dryRun) {
    const agentBin = process.env.HARNESS_WAKE_AGENT || 'agent'
    const prompt = judgmentPrompt({ repo, wakes: judgmentWakes, statusSummary })
    const promptFile = join(controlDir, 'wake-control-host-prompt.txt')
    writeFileSync(promptFile, `${prompt}\n`)
    const invoked = spawnSync(agentBin, [
      '-p', '--force', '--trust', '--sandbox', 'disabled', prompt,
    ], {
      encoding: 'utf8',
      env,
      cwd: repo,
      timeout: Number(process.env.HARNESS_WAKE_AGENT_TIMEOUT_MS || 600_000),
      maxBuffer: 20 * 1024 * 1024,
    })
    result.invoke = {
      status: invoked.status,
      error: invoked.error?.message || null,
      promptFile,
      stdoutTail: String(invoked.stdout || '').slice(-2000),
      stderrTail: String(invoked.stderr || '').slice(-1000),
    }

    // Re-status after invoke; ack only when a post-condition is visible.
    const statusAfter = loadStatus(control, repo, env)
    st = statusAfter || st
    if (typeof planWakeAck === 'function') {
      const ackPlan = planWakeAck({
        invokeAgent: true,
        invokeStatus: invoked.status,
        invokeStdout: invoked.stdout || '',
        invokeStderr: invoked.stderr || '',
        wakes: judgmentWakes,
        statusBefore,
        statusAfter,
      })
      result.ackPlan = ackPlan
      if (!args.dryRun && maxId > 0 && ackPlan.ack) {
        run(process.execPath, [
          control, 'ack', '--repo', repo, '--consumer', consumer, '--event', String(maxId),
        ], env)
        result.ackedThrough = maxId
      } else {
        result.ackedThrough = null
        result.ackDeferred = true
        if (ackPlan.reason === 'invoke-noop' && args.notify) {
          notifyDesktop(
            'Harness wake deferred (agent noop)',
            `${wakeSummary}\nJudgment agent exited 0 without visible reopen/retry/worker change — ack deferred for next ops tick.`,
            'critical',
          )
        }
      }
    } else {
      // Legacy fallback when wake-ack.mjs is not synced yet.
      const invokeFailed = result.invoke.status !== 0
      if (!args.dryRun && maxId > 0 && !invokeFailed) {
        run(process.execPath, [
          control, 'ack', '--repo', repo, '--consumer', consumer, '--event', String(maxId),
        ], env)
        result.ackedThrough = maxId
      } else {
        result.ackedThrough = null
        result.ackDeferred = true
      }
    }
  } else if (!args.dryRun && maxId > 0) {
    // Notify-only / dry path: ack so the consumer advances (no invoke to validate).
    run(process.execPath, [
      control, 'ack', '--repo', repo, '--consumer', consumer, '--event', String(maxId),
    ], env)
    result.ackedThrough = maxId
  }

  appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...result })}\n`)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.exit(0)
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exit(2)
})
