#!/usr/bin/env node
/**
 * Host-level ops cron for harness supervisors.
 *
 * Unlike Cursor Agent `/loop` (chat may stay idle), this runs under systemd/cron,
 * calls harness-control fleet-snapshot (+ status for deep checks), writes a durable
 * verdict, always desktop-notifies when --notify is set, and exits non-zero on
 * hard alerts.
 *
 * usage:
 *   node ops-cron-check.mjs --repo /path/to/project [--project root] [--notify] [--json]
 * env:
 *   HARNESS_CONTROL   path to harness-control.mjs
 *   HARNESS_OPS_LOG   append JSONL log path (default: <git>/.git/harness-control/ops-cron.jsonl)
 *   HARNESS_OPS_SILENT_MS  agent silence threshold (default 600000 = 10m)
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, appendFileSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isWorkerSideChannelArtifact } from '../../generator/lib/worker-outcome.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const SILENT_MS = Math.max(60_000, Number(process.env.HARNESS_OPS_SILENT_MS || 600_000))

function parseArgs(argv) {
  const out = { repo: null, projects: null, notify: false, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--repo') out.repo = argv[++i]
    else if (a === '--project' || a === '--projects') out.projects = String(argv[++i] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    else if (a === '--notify') out.notify = true
    else if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

function die(message, code = 2) {
  process.stderr.write(`ops-cron-check: ${message}\n`)
  process.exit(code)
}

function gitCommonDir(repo) {
  const r = spawnSync('git', ['-C', repo, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' })
  if (r.status !== 0) die(`git common dir failed: ${r.stderr || r.stdout}`)
  const p = r.stdout.trim()
  return p.startsWith('/') ? p : resolve(repo, p)
}

function resolveControl(explicit) {
  if (explicit && existsSync(explicit)) return explicit
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
  die('harness-control.mjs not found; set HARNESS_CONTROL')
}

function runControl(control, args, env) {
  const r = spawnSync(process.execPath, [control, ...args], {
    encoding: 'utf8',
    env,
    maxBuffer: 20 * 1024 * 1024,
  })
  return r
}

function remainingFromProgress(progress = {}) {
  const total = Number(progress.total || 0)
  const integrated = Number(progress.integrated || 0)
  if (progress.remaining != null) return Math.max(0, Number(progress.remaining) || 0)
  return Math.max(0, total - integrated)
}

function ageMs(isoOrEpoch) {
  if (isoOrEpoch == null || isoOrEpoch === '') return null
  if (typeof isoOrEpoch === 'number') {
    const ms = isoOrEpoch > 1e12 ? isoOrEpoch : isoOrEpoch * 1000
    return Date.now() - ms
  }
  const t = Date.parse(String(isoOrEpoch))
  if (Number.isNaN(t)) return null
  return Date.now() - t
}

function readJsonSafe(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function deepAlertsForProject(project, { commonGit, status }) {
  const alerts = []
  const progress = project.progress || {}
  const remaining = remainingFromProgress(progress)
  const stuck = Array.isArray(project.stuck) ? project.stuck : []
  const statusName = String(project.status || status?.status || '')
  const complete = statusName === 'complete' || statusName === 'stopped'
  // Prefer fleet workers (includes liveClaimWorkers). Do not use `||` — workers=0
  // is valid and must not fall through to the primary repo's status.workers.
  const workers = Number(
    project.workers != null
      ? project.workers
      : (project.id === 'root' || !project.id
        ? Object.keys(status?.workers || {}).length
        : 0),
  )

  if (stuck.length > 0) {
    alerts.push({
      severity: 'error',
      code: 'stuck_workers',
      message: `${stuck.length} stuck worker(s): ${stuck.map((s) => s.context || s).join(', ')}`,
    })
  }
  if (project.emptyFleetActionable && remaining > 0) {
    alerts.push({
      severity: 'error',
      code: 'empty_fleet_actionable',
      message: `empty fleet with ${remaining} remaining WI(s)`,
    })
  }
  if (!project.supervisorLive && remaining > 0 && !complete && statusName !== 'paused') {
    alerts.push({
      severity: 'error',
      code: 'supervisor_dead_with_work',
      message: `supervisorLive=false while remaining=${remaining} status=${statusName || 'unknown'}`,
    })
  }
  if (project.needsGoalReviewRetry) {
    alerts.push({
      severity: 'warn',
      code: 'needs_goal_review_retry',
      message: 'needsGoalReviewRetry=true',
    })
  }
  if (Number(project.pendingInputs || 0) > 0) {
    alerts.push({
      severity: 'warn',
      code: 'pending_inputs',
      message: `${project.pendingInputs} pending input(s)`,
    })
  }
  if (project.pressureAdvice && remaining > 0 && workers === 0) {
    alerts.push({
      severity: 'warn',
      code: 'pressure',
      message: String(project.pressureAdvice),
    })
  }
  if (Array.isArray(project.recoveryReasons) && project.recoveryReasons.length > 0 && remaining > 0) {
    const reasonText = project.recoveryReasons.map((r) => {
      if (typeof r === 'string') return r
      if (r && typeof r === 'object') {
        return r.reason || r.kind || r.message || JSON.stringify(r)
      }
      return String(r)
    }).join('; ')
    alerts.push({
      severity: 'warn',
      code: 'recovery_reasons',
      message: reasonText,
    })
  }

  const indexLock = join(commonGit, 'index.lock')
  if (existsSync(indexLock)) {
    let age = null
    try { age = Date.now() - statSync(indexLock).mtimeMs } catch { /* ignore */ }
    alerts.push({
      severity: 'error',
      code: 'git_index_lock',
      message: `index.lock present${age != null ? ` age=${Math.round(age / 1000)}s` : ''} — merges will thrash`,
    })
  }

  const health = status?.workerHealth || {}
  const workerRows = status?.workers || {}
  for (const [context, worker] of Object.entries(workerRows)) {
    const h = health[context] || {}
    const phase = h.phase || 'unknown'
    const startedAge = ageMs(worker.startedAt)
    const outputAge = ageMs(h.lastAgentOutputAt)
    const logFile = worker.logFile
    let logBytes = null
    if (logFile && existsSync(logFile)) {
      try { logBytes = statSync(logFile).size } catch { /* ignore */ }
    }

    if (h.verdict === 'stuck' || h.recycle) {
      alerts.push({
        severity: 'error',
        code: 'stuck_worker',
        message: `${context} verdict=${h.verdict} reason=${h.reason || '?'}`,
      })
    }

    // Run-state repair thrash (index.lock / merge) while re-coding after QA green.
    // Root project uses bare `<context>.json`; nested projects use `<id>--<context>.json`.
    const projectKey = String(project.id || '').trim()
    const runCandidates = [
      join(commonGit, 'harness-runs', `${context}.json`),
      projectKey && !projectKey.includes('/')
        ? join(commonGit, 'harness-runs', `${projectKey}--${context}.json`)
        : null,
    ].filter(Boolean)
    let run = null
    for (const runPath of runCandidates) {
      run = readJsonSafe(runPath, null)
      if (run) break
    }

    // Side-channel freshness: Cursor agent often leaves harness-control worker
    // logs empty while still advancing .harness/wi-* / goal-review / runtime-
    // owned probes (and supervisor workers[].worktree when Run State omits it).
    let sideChannelFresh = false
    try {
      const evidencePath = run?.evidence
      if (evidencePath && existsSync(evidencePath)) {
        const eAge = Date.now() - statSync(evidencePath).mtimeMs
        if (eAge <= SILENT_MS) sideChannelFresh = true
      }
      const wt = run?.worktree || worker.worktree
      if (!sideChannelFresh && wt) {
        const harnessDir = join(wt, '.harness')
        if (existsSync(harnessDir)) {
          for (const name of readdirSync(harnessDir)) {
            if (!isWorkerSideChannelArtifact(name)) continue
            try {
              const a = Date.now() - statSync(join(harnessDir, name)).mtimeMs
              if (a <= SILENT_MS) { sideChannelFresh = true; break }
            } catch { /* skip */ }
          }
        }
      }
    } catch { /* ignore */ }

    // Silent coding/QA agent: no output for SILENT_MS (or never, after grace)
    const grace = Math.min(SILENT_MS, 180_000)
    if (['coding', 'qa', 'integration_qa'].includes(phase)) {
      const silent = sideChannelFresh
        ? false
        : (outputAge == null
          ? (startedAge != null && startedAge > grace)
          : outputAge > SILENT_MS)
      if (silent) {
        alerts.push({
          severity: 'warn',
          code: 'silent_agent',
          message: `${context} phase=${phase} lastAgentOutputAt=${h.lastAgentOutputAt || 'null'} startedAgeMs=${startedAge}`,
        })
      }
    }

    // Empty worker log alone is not stuck when run-state / probe artifacts move.
    if (logBytes === 0 && startedAge != null && startedAge > grace
      && !sideChannelFresh
      && !(outputAge != null && outputAge <= SILENT_MS)) {
      alerts.push({
        severity: 'warn',
        code: 'empty_worker_log',
        message: `${context} log empty for ${Math.round(startedAge / 1000)}s (${logFile})`,
      })
    }
    const repairText = JSON.stringify(run?.repairPlan || {})
    if (/index\.lock|stash failed|integration could not complete|integration merge\/checkpoint failure/i.test(repairText)) {
      alerts.push({
        severity: 'error',
        code: 'merge_thrash',
        message: `${context} retrying after merge/index.lock failure (phase=${run?.phase || phase} feature=${run?.currentFeatureId || worker.featureIds?.[0]})`,
      })
    }
  }

  const ok = !alerts.some((a) => a.severity === 'error')
  return {
    id: project.id,
    status: statusName,
    supervisorLive: Boolean(project.supervisorLive),
    workers,
    remaining,
    progress,
    stuckCount: stuck.length,
    emptyFleetActionable: Boolean(project.emptyFleetActionable),
    needsGoalReviewRetry: Boolean(project.needsGoalReviewRetry),
    pendingInputs: Number(project.pendingInputs || 0),
    workerPhases: Object.fromEntries(
      Object.entries(health).map(([ctx, h]) => [ctx, { phase: h.phase, verdict: h.verdict, lastAgentOutputAt: h.lastAgentOutputAt }]),
    ),
    alerts,
    ok,
  }
}

function notifyDesktop(title, body, urgency = 'normal') {
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
  } catch {
    /* optional */
  }
}

function humanSummary(evaluations, errors, warns) {
  const parts = evaluations.map((e) => {
    const integ = e.progress?.integrated ?? '?'
    const total = e.progress?.total ?? '?'
    return `${e.id} ${integ}/${total} w=${e.workers}`
  })
  if (errors.length) return `FAIL ${errors.map((a) => a.code).join(',')} · ${parts.join(' · ')}`
  if (warns.length) return `WARN ${warns.map((a) => a.code).join(',')} · ${parts.join(' · ')}`
  return `OK ${parts.join(' · ')}`
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.repo) {
    process.stdout.write(`usage: ops-cron-check.mjs --repo <path> [--project root] [--notify] [--json]\n`)
    process.exit(args.help ? 0 : 2)
  }
  const repo = resolve(args.repo)
  if (!existsSync(repo)) die(`repo not found: ${repo}`)

  const control = resolveControl(null)
  const env = { ...process.env }
  const commonGit = gitCommonDir(repo)

  const snap = runControl(control, ['fleet-snapshot', '--repo', repo], env)
  if (snap.status !== 0) {
    die(`fleet-snapshot failed (exit ${snap.status}): ${snap.stderr || snap.stdout}`, 2)
  }
  let fleet
  try {
    fleet = JSON.parse(snap.stdout)
  } catch (error) {
    die(`fleet-snapshot JSON parse failed: ${error.message}`, 2)
  }

  const projects = Array.isArray(fleet.projects) ? fleet.projects : []
  const filtered = args.projects?.length
    ? projects.filter((p) => args.projects.includes(p.id))
    : projects
  if (filtered.length === 0) die('no projects matched --project filter', 2)

  // Deep status for the primary repo (workers/phase/silence/merge thrash)
  const statusRun = runControl(control, ['status', '--repo', repo], env)
  let status = null
  if (statusRun.status === 0) {
    try { status = JSON.parse(statusRun.stdout) } catch { status = null }
  }

  const evaluations = filtered.map((project) => deepAlertsForProject(project, { commonGit, status }))
  const errors = evaluations.flatMap((e) => e.alerts.filter((a) => a.severity === 'error').map((a) => ({ project: e.id, ...a })))
  const warns = evaluations.flatMap((e) => e.alerts.filter((a) => a.severity === 'warn').map((a) => ({ project: e.id, ...a })))
  const ok = errors.length === 0
  const summary = humanSummary(evaluations, errors, warns)
  const verdict = {
    at: new Date().toISOString(),
    repo,
    control,
    ok,
    attention: !ok || warns.length > 0,
    summary,
    errorCount: errors.length,
    warnCount: warns.length,
    errors,
    warns,
    projects: evaluations,
  }

  const controlDir = join(commonGit, 'harness-control')
  mkdirSync(controlDir, { recursive: true })
  const lastPath = join(controlDir, 'ops-cron-last.json')
  const textPath = join(controlDir, 'ops-cron-status.txt')
  const logPath = process.env.HARNESS_OPS_LOG || join(controlDir, 'ops-cron.jsonl')
  writeFileSync(lastPath, `${JSON.stringify(verdict, null, 2)}\n`)
  writeFileSync(textPath, `${verdict.at} ${summary}\n${[...errors, ...warns].map((a) => `- ${a.severity} ${a.project} ${a.code}: ${a.message}`).join('\n')}\n`)
  appendFileSync(logPath, `${JSON.stringify(verdict)}\n`)

  // Always notify when --notify so the host proves the cron is alive.
  if (args.notify) {
    const urgency = !ok ? 'critical' : warns.length ? 'normal' : 'low'
    notifyDesktop(`Harness ${ok ? (warns.length ? 'warn' : 'ok') : 'FAIL'}`, summary, urgency)
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`)
  } else {
    process.stdout.write(`${summary}\n`)
    for (const a of [...errors, ...warns]) {
      process.stdout.write(`- ${a.severity} ${a.project} ${a.code}: ${a.message}\n`)
    }
    process.stdout.write(`wrote ${lastPath}\n`)
    process.stdout.write(`wrote ${textPath}\n`)
  }

  process.exit(ok ? 0 : 1)
}

main()
