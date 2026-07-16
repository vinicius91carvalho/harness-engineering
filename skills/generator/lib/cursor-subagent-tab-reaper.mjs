/**
 * Reap finished Cursor Task / Subagent herdr mirror tabs.
 *
 * Cursor CLI hooks spawn `cursor-sub-*` tabs with herdr-subagent-logview.py.
 * Those tabs are NOT harness `worker-<project>-*` panes, so the finished-tab
 * reaper never closes them. Transcripts often omit `turn_ended`, so logview
 * and the stop hook leave "working" zombies. This module plans closes from
 * registry + live pane signals for the supervisor tick (and ops CLI).
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'

export const DEFAULT_CURSOR_SUBAGENT_REGISTRY = join(homedir(), '.cursor', 'herdr-subagent-registry.json')
export const DEFAULT_ORPHAN_GRACE_MS = 120_000
export const DEFAULT_IDLE_AFTER_START_MS = 90_000

/**
 * @param {string} agentName
 */
export function isCursorSubagentAgent(agentName) {
  const name = String(agentName || '')
  return name.startsWith('cursor-sub-') || name.includes('cursor-sub-')
}

/**
 * @param {object} pane - herdr pane list row
 */
export function paneLooksLikeCursorSubagent(pane) {
  if (!pane || typeof pane !== 'object') return false
  if (isCursorSubagentAgent(pane.agent || pane.agent_name)) return true
  const label = String(pane.label || '')
  if (/generalPurpose|Diagnose |Verify scaffold|cursor-sub/i.test(label)) {
    // Prefer agent match; label alone is weak. Require cursor-sub agent OR
    // emoji Task-style labels that Cursor hooks set.
    if (label.includes('🧮') || /generalPurpose:/.test(label)) return true
  }
  return false
}

/**
 * @param {string} [startedAt] ISO timestamp
 * @param {number} [now]
 */
export function entryAgeMs(startedAt, now = Date.now()) {
  if (!startedAt) return Number.POSITIVE_INFINITY
  const t = Date.parse(startedAt)
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY
  return Math.max(0, now - t)
}

/**
 * Decide whether one registry entry should be closed.
 * @param {object} entry
 * @param {object} [opts]
 * @param {object|null} [opts.pane] live pane for root_pane_id / tab
 * @param {boolean} [opts.logviewAlive]
 * @param {boolean} [opts.transcriptFinished] turn_ended or idle-complete
 * @param {number} [opts.now]
 * @param {number} [opts.orphanGraceMs]
 * @param {number} [opts.idleAfterStartMs]
 */
export function shouldCloseCursorSubagentEntry(entry, {
  pane = null,
  logviewAlive = null,
  transcriptFinished = false,
  now = Date.now(),
  orphanGraceMs = DEFAULT_ORPHAN_GRACE_MS,
  idleAfterStartMs = DEFAULT_IDLE_AFTER_START_MS,
} = {}) {
  if (!entry || typeof entry !== 'object') return { close: false, reason: 'no-entry' }
  if (transcriptFinished) return { close: true, reason: 'transcript_finished' }

  const cwd = String(pane?.cwd || pane?.foreground_cwd || '')
  if (/\(deleted\)/i.test(cwd)) return { close: true, reason: 'cwd_deleted' }

  const status = String(pane?.agent_status || '')
  const age = entryAgeMs(entry.started_at, now)

  if (logviewAlive === false && age >= idleAfterStartMs) {
    return { close: true, reason: 'logview_dead' }
  }

  if (['done', 'idle'].includes(status) && age >= idleAfterStartMs) {
    return { close: true, reason: `agent_status_${status}` }
  }

  // No live pane / tab gone — drop registry residue.
  if (pane === null && age >= orphanGraceMs) {
    return { close: true, reason: 'missing_pane_orphan' }
  }

  return { close: false, reason: 'live' }
}

/**
 * Plan closes for registry entries + stray cursor-sub panes.
 * @param {object} input
 * @param {Record<string, object>} input.registry
 * @param {object[]} input.panes
 * @param {object[]} [input.tabs]
 * @param {(metaPath: string) => boolean|null} [input.isLogviewAlive]
 * @param {(entry: object) => boolean|null} [input.isTranscriptFinished]
 * @param {number} [input.now]
 */
export function planCursorSubagentTabReap({
  registry = {},
  panes = [],
  tabs = [],
  isLogviewAlive = () => null,
  isTranscriptFinished = () => null,
  now = Date.now(),
  orphanGraceMs = DEFAULT_ORPHAN_GRACE_MS,
  idleAfterStartMs = DEFAULT_IDLE_AFTER_START_MS,
} = {}) {
  const panesById = new Map(panes.map((p) => [p.pane_id, p]))
  const panesByTab = new Map()
  for (const pane of panes) {
    if (!pane?.tab_id) continue
    const list = panesByTab.get(pane.tab_id) || []
    list.push(pane)
    panesByTab.set(pane.tab_id, list)
  }
  const tabById = new Map((tabs || []).map((t) => [t.tab_id, t]))

  const closes = []
  const keepRegistryIds = new Set()

  for (const [id, entry] of Object.entries(registry || {})) {
    if (!entry || typeof entry !== 'object') continue
    const pane = panesById.get(entry.root_pane_id)
      || (panesByTab.get(entry.tab_id) || [])[0]
      || null
    const logviewAlive = typeof isLogviewAlive === 'function'
      ? isLogviewAlive(entry.meta_path || '')
      : null
    const finished = typeof isTranscriptFinished === 'function'
      ? isTranscriptFinished(entry)
      : null
    const decision = shouldCloseCursorSubagentEntry(entry, {
      pane,
      logviewAlive,
      transcriptFinished: finished === true,
      now,
      orphanGraceMs,
      idleAfterStartMs,
    })
    if (decision.close) {
      closes.push({
        registryId: id,
        tabId: entry.tab_id,
        agent: entry.agent,
        reason: decision.reason,
        metaPath: entry.meta_path,
      })
    } else {
      keepRegistryIds.add(id)
    }
  }

  // Stray cursor-sub panes not in registry (hook crash / registry prune lag).
  const registeredTabs = new Set(
    Object.values(registry || {}).map((e) => e?.tab_id).filter(Boolean),
  )
  for (const pane of panes) {
    if (!isCursorSubagentAgent(pane.agent || pane.agent_name)) continue
    if (registeredTabs.has(pane.tab_id)) continue
    const ageProxy = DEFAULT_IDLE_AFTER_START_MS
    const fakeEntry = { started_at: new Date(now - ageProxy).toISOString() }
    const decision = shouldCloseCursorSubagentEntry(fakeEntry, {
      pane,
      logviewAlive: false,
      now,
      orphanGraceMs,
      idleAfterStartMs,
    })
    if (decision.close || ['done', 'idle', 'unknown'].includes(String(pane.agent_status || ''))) {
      closes.push({
        registryId: null,
        tabId: pane.tab_id,
        agent: pane.agent,
        reason: decision.close ? decision.reason : 'stray_cursor_sub',
        metaPath: null,
      })
    } else if (/\(deleted\)/i.test(String(pane.cwd || ''))) {
      closes.push({
        registryId: null,
        tabId: pane.tab_id,
        agent: pane.agent,
        reason: 'cwd_deleted',
        metaPath: null,
      })
    }
  }

  // Deduplicate by tabId.
  const byTab = new Map()
  for (const row of closes) {
    if (!row.tabId) continue
    if (!byTab.has(row.tabId)) byTab.set(row.tabId, row)
  }

  return {
    shouldReap: byTab.size > 0,
    closes: [...byTab.values()],
    keepRegistryIds,
    tabLabels: Object.fromEntries(
      [...byTab.keys()].map((id) => [id, tabById.get(id)?.label || null]),
    ),
  }
}

export function loadCursorSubagentRegistry(path = DEFAULT_CURSOR_SUBAGENT_REGISTRY) {
  if (!path || !existsSync(path)) return {}
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  } catch {
    return {}
  }
}

export function writeCursorSubagentRegistry(registry, path = DEFAULT_CURSOR_SUBAGENT_REGISTRY) {
  if (!path) return
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`)
  try {
    renameSync(tmp, path)
  } catch {
    writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`)
    try { unlinkSync(tmp) } catch { /* ignore */ }
  }
}

export function removeMetaFile(metaPath) {
  if (!metaPath) return
  try { unlinkSync(metaPath) } catch { /* ignore */ }
}

export function tabCloseErrorMeansGone(error) {
  return /tab[_ -]?not[_ -]?found|no such tab|tab .*not found|not found.*tab|unknown tab/i.test(String(error || ''))
}

/**
 * Detect a live logview process for a meta path.
 * @param {string} metaPath
 * @param {string} [psStdout] optional injected `ps -ef` / `ps -eo args` for tests
 */
export function logviewAliveForMeta(metaPath, psStdout = null) {
  if (!metaPath) return null
  const needle = metaPath
  let out = psStdout
  if (out == null) {
    const proc = spawnSync('ps', ['-eo', 'args='], { encoding: 'utf8' })
    if (proc.status !== 0) return null
    out = proc.stdout || ''
  }
  return out.split('\n').some((line) => (
    line.includes('herdr-subagent-logview') && line.includes(needle)
  ))
}

/**
 * Tail-check transcript for turn_ended (best-effort).
 */
export function transcriptHasTurnEnded(entry) {
  const metaPath = entry?.meta_path
  if (!metaPath || !existsSync(metaPath)) return null
  let meta
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  } catch {
    return null
  }
  const tdir = meta.transcripts_dir
  if (!tdir || !existsSync(tdir)) return null
  // Cheap: scan newest jsonl under tdir for turn_ended near EOF is expensive;
  // callers usually pass finished from logview. Here only check meta hint.
  return null
}

/**
 * Apply a reap plan via herdr CLI. Fail-open on herdr errors.
 * @param {object} plan from planCursorSubagentTabReap
 * @param {object} [opts]
 * @param {typeof spawnSync} [opts.run]
 * @param {string} [opts.registryPath]
 */
export function applyCursorSubagentTabReap(plan, {
  run = spawnSync,
  registryPath = DEFAULT_CURSOR_SUBAGENT_REGISTRY,
  registry = null,
} = {}) {
  if (!plan?.closes?.length) {
    return { closed: 0, errors: [] }
  }
  const errors = []
  let closed = 0
  let nextRegistry = registry ? { ...registry } : loadCursorSubagentRegistry(registryPath)

  for (const row of plan.closes) {
    let prune = !row.tabId
    if (row.tabId) {
      const result = run('herdr', ['tab', 'close', row.tabId], {
        encoding: 'utf8',
        timeout: 10_000,
      })
      if (result.status !== 0) {
        const error = result.stderr || result.stdout || 'close failed'
        errors.push({ tabId: row.tabId, error })
        prune = tabCloseErrorMeansGone(error)
      } else {
        closed += 1
        prune = true
      }
    }
    if (prune && row.metaPath) removeMetaFile(row.metaPath)
    if (prune && row.registryId && nextRegistry[row.registryId]) {
      delete nextRegistry[row.registryId]
    }
  }

  writeCursorSubagentRegistry(nextRegistry, registryPath)
  return { closed, errors, registry: nextRegistry }
}
