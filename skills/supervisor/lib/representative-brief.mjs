/**
 * Pure helpers for Control Host-as-representative progress briefings.
 * Zero LLM tokens — desktop notify / ops cron narrate on behalf of the user.
 */

/**
 * @returns {{ brief: boolean, title: string, body: string, urgency: string, snapshot: object }}
 */
export function planProgressBrief({
  previous = null,
  progress = {},
  status = '',
  claims = [],
  pendingInputs = 0,
  remaining = null,
  now = Date.now(),
  minIntervalMs = 15 * 60_000,
} = {}) {
  const total = Number(progress.total || 0)
  const integrated = Number(progress.integrated || 0)
  const implemented = Number(progress.implemented || 0)
  const qa = Number(progress.qa || 0)
  const left = remaining != null
    ? Math.max(0, Number(remaining) || 0)
    : Math.max(0, total - integrated)

  const snapshot = {
    at: new Date(now).toISOString(),
    status: String(status || ''),
    total,
    integrated,
    implemented,
    qa,
    remaining: left,
    pendingInputs: Number(pendingInputs || 0),
    claimSummary: summarizeClaims(claims),
  }

  if (status === 'complete' || status === 'stopped') {
    if (previous?.status === status) {
      return { brief: false, title: '', body: '', urgency: 'low', snapshot }
    }
    return {
      brief: true,
      title: 'Harness complete',
      body: `${integrated}/${total} integrated — Goal Review / run finished`,
      urgency: 'normal',
      snapshot,
    }
  }

  const prev = previous && typeof previous === 'object' ? previous : null
  const progressChanged = !prev
    || prev.integrated !== integrated
    || prev.implemented !== implemented
    || prev.qa !== qa
    || prev.remaining !== left
    || prev.status !== status
    || prev.claimSummary !== snapshot.claimSummary

  const lastAt = prev?.at ? Date.parse(prev.at) : 0
  const intervalOk = !Number.isFinite(lastAt) || now - lastAt >= Math.max(60_000, Number(minIntervalMs) || 0)

  // Always brief on first sample or counter/claim change; otherwise heartbeat interval.
  if (!progressChanged && !intervalOk) {
    return { brief: false, title: '', body: '', urgency: 'low', snapshot }
  }
  if (!progressChanged && intervalOk && left <= 0) {
    return { brief: false, title: '', body: '', urgency: 'low', snapshot }
  }

  const parts = [
    `${integrated}/${total} integrated`,
    left > 0 ? `${left} remaining` : 'queue clear',
  ]
  if (snapshot.claimSummary) parts.push(snapshot.claimSummary)
  if (pendingInputs > 0) parts.push(`${pendingInputs} pending input(s)`)

  return {
    brief: true,
    title: left > 0 ? 'Harness progress' : 'Harness nearly done',
    body: parts.join(' · '),
    urgency: left > 0 ? 'low' : 'normal',
    snapshot,
  }
}

export function summarizeClaims(claims = []) {
  if (!Array.isArray(claims) || claims.length === 0) return ''
  return claims
    .slice(0, 4)
    .map((c) => {
      if (typeof c === 'string') return c
      const ctx = c.context || c.id || 'worker'
      const phase = c.phase || c.status || ''
      const tasks = Array.isArray(c.tasks) ? c.tasks.join(',') : (c.featureIds || []).join(',')
      return [ctx, phase, tasks].filter(Boolean).join('/')
    })
    .join('; ')
}

/**
 * Judgment wakes that require the representative (LLM or escalate), not mere progress.
 */
export function isJudgmentWake(event = {}) {
  const kind = String(event.kind || '')
  if ([
    'input_required',
    'worker_stuck',
    'worker_never_started',
    'worker_crash_loop',
    'worker_spawn_failed',
    'harness_issue',
    'goal_defects',
    'quota_wait',
    'supervisor_failed',
    'supervisor_tick_failed',
    'dead_runtime',
    'empty_fleet_actionable',
    'run_completed',
  ].includes(kind)) return true
  if (event.wakeTriage?.action === 'wake' && kind !== 'progress' && kind !== 'run_started') {
    return true
  }
  return false
}
