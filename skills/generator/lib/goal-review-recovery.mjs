/**
 * Zero-token Goal Review failure recovery planners.
 * Used when GR closes blocked (dirty gate) or goal:false with evidence ACs —
 * so supervisors reopen product WIs instead of only re-queuing Goal Review.
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseVerdict } from './worker-outcome.mjs'

const DIRTY_CHECKOUT_RE = /Goal Review must be read-only|checkout changed/i
const AC_ID_RE = /\bAC-\d{3,}\b/g
const PROSE_FAIL_RE = /\b(fail|failed|failure|defect|broken|expected\b.+\bobserved|unreachable|error)\b/i

/** Canonical goal-scoped Input Request reason for unmapped product defects. */
export const UNMAPPED_DEFECTS_REASON = 'Goal Review product defects with no mappable Work Items'

/** @param {string|object} defect */
export function isDirtyCheckoutDefect(defect) {
  const text = typeof defect === 'string' ? defect : String(defect?.message || defect || '')
  return DIRTY_CHECKOUT_RE.test(text)
}

/**
 * Pull AC-NNN ids from result fields.
 * @param {object} result
 * @param {{ includeSummary?: boolean, includeGuidance?: boolean }} [opts]
 */
export function extractAcceptanceCheckIds(result = {}, {
  includeSummary = true,
  includeGuidance = true,
} = {}) {
  const ids = new Set()
  for (const id of result.acceptanceCheckIds || []) {
    const s = String(id || '').trim().toUpperCase()
    if (/^AC-\d{3,}$/.test(s)) ids.add(s)
  }
  const blobs = [
    ...(result.defects || []).map((d) => (typeof d === 'string' ? d : String(d?.message || ''))),
  ]
  if (includeSummary) blobs.push(String(result.summary || ''))
  if (includeGuidance) blobs.push(String(result.guidance || ''))
  for (const text of blobs) {
    for (const match of String(text).matchAll(AC_ID_RE)) {
      ids.add(match[0].toUpperCase())
    }
  }
  return [...ids]
}

/**
 * Catalog rows whose acceptance_checks intersect the given AC ids.
 * @param {Array<object>} catalog
 * @param {string[]} acceptanceCheckIds
 */
export function workItemsForAcceptanceChecks(catalog = [], acceptanceCheckIds = []) {
  const want = new Set((acceptanceCheckIds || []).map((id) => String(id).toUpperCase()))
  if (!want.size) return []
  return (Array.isArray(catalog) ? catalog : []).filter((item) => {
    const checks = item.acceptance_checks || item.acceptanceChecks || []
    return checks.some((id) => want.has(String(id).toUpperCase()))
  })
}

/**
 * Search multiple project catalogs (monorepo). Each entry:
 * `{ projectId, path, items: Feature[] }`
 * @returns {Array<object & { projectId: string, projectPath: string }>}
 */
export function workItemsForAcceptanceChecksAcrossProjects(projectCatalogs = [], acceptanceCheckIds = []) {
  const out = []
  for (const entry of projectCatalogs || []) {
    const items = workItemsForAcceptanceChecks(entry.items || entry.catalog || [], acceptanceCheckIds)
    for (const item of items) {
      out.push({
        ...item,
        projectId: entry.projectId || entry.id || 'root',
        projectPath: entry.path ?? entry.projectPath ?? '',
      })
    }
  }
  return out
}

/** Parse Goal Review evidence log / agent text into a verdict-shaped object. */
export function parseGoalReviewEvidenceLog(text = '') {
  const parsed = parseVerdict(text)
  if (parsed && typeof parsed === 'object' && ('goal' in parsed || parsed.blocked || parsed.defects)) {
    return parsed
  }
  return null
}

/**
 * When result.json is dirt-only (or empty ACs) but the evidence artifact has
 * product defects / AC ids, merge evidence into a recovery-friendly result.
 * Dirty-masked closes always merge evidence product defects even if the agent
 * also left a partial product defect list in result.json.
 */
export function enrichResultFromEvidence(result = {}, evidenceText = '') {
  const evidence = parseGoalReviewEvidenceLog(evidenceText)
  if (!evidence) return result
  const base = result && typeof result === 'object' ? { ...result } : {}
  const baseDefects = Array.isArray(base.defects) ? base.defects : []
  const evidenceDefects = Array.isArray(evidence.defects) ? evidence.defects : []
  const productFromEvidence = evidenceDefects.filter((d) => !isDirtyCheckoutDefect(d))
  const baseProduct = baseDefects.filter((d) => !isDirtyCheckoutDefect(d))
  const dirty = baseDefects.some(isDirtyCheckoutDefect) || Boolean(base.blocked)

  const normalizeAcIds = (ids) => [...new Set(
    (ids || [])
      .map((id) => String(id || '').trim().toUpperCase())
      .filter((id) => /^AC-\d{3,}$/.test(id)),
  )]
  const explicitBase = normalizeAcIds(base.acceptanceCheckIds)
  const explicitEvidence = normalizeAcIds(evidence.acceptanceCheckIds)
  const baseIds = extractAcceptanceCheckIds(base)
  const evidenceIds = extractAcceptanceCheckIds(evidence)
  const evidenceAddsIds = evidenceIds.some((id) => !baseIds.includes(id))
  const baseProductKeys = new Set(baseProduct.map((d) => String(d).slice(0, 200)))
  const evidenceAddsDefects = productFromEvidence.some((d) => !baseProductKeys.has(String(d).slice(0, 200)))
  // Clean product fail with ACs already present — keep base only when evidence
  // adds nothing new (still merge when evidence names extra ACs/defects).
  if (!dirty && baseProduct.length > 0 && baseIds.length > 0 && !evidenceAddsIds && !evidenceAddsDefects) {
    // CauseFlow root 2026-07-17 AC-018: result.json often has product defects +
    // summary mentioning "AC-018" but omits acceptanceCheckIds[]. Mining fills
    // baseIds so we early-return here — then planGoalReviewCloseRecovery
    // (includeSummary:false) sees no explicit ACs and escalates unmapped_defects
    // even though the evidence log has acceptanceCheckIds:["AC-018"]. Always
    // materialize explicit evidence ids (else mined baseIds) onto the result.
    if (!explicitBase.length && (explicitEvidence.length || baseIds.length)) {
      return {
        ...base,
        acceptanceCheckIds: explicitEvidence.length ? explicitEvidence : baseIds,
        enrichedFromEvidence: true,
      }
    }
    return base
  }

  const mergedProduct = []
  const seen = new Set()
  for (const d of [...baseProduct, ...productFromEvidence]) {
    const key = String(d).slice(0, 200)
    if (seen.has(key)) continue
    seen.add(key)
    mergedProduct.push(d)
  }
  const mergedDefects = [
    ...baseDefects.filter(isDirtyCheckoutDefect),
    ...(mergedProduct.length ? mergedProduct : evidenceDefects),
  ]
  const mergedIds = [
    ...new Set([
      ...extractAcceptanceCheckIds(base),
      ...extractAcceptanceCheckIds(evidence),
    ]),
  ]

  return {
    ...base,
    goal: typeof evidence.goal === 'boolean' ? evidence.goal : base.goal,
    blocked: base.blocked || evidence.blocked || dirty,
    summary: evidence.summary || base.summary || '',
    defects: mergedDefects.length ? mergedDefects : baseDefects,
    acceptanceCheckIds: mergedIds.length ? mergedIds : (evidence.acceptanceCheckIds || base.acceptanceCheckIds || []),
    enrichedFromEvidence: true,
  }
}

/**
 * Find newest goal_review evidence log under .git/harness-evidence/<projectId>/.
 * Prefer logs not newer than resultMtimeMs (avoid picking a later unrelated retry).
 * @returns {string|null} file path
 */
export function findLatestGoalReviewEvidenceLog(commonGit, projectId = 'root', {
  resultMtimeMs = null,
} = {}) {
  const root = join(commonGit, 'harness-evidence', projectId || 'root')
  if (!existsSync(root)) return null
  let best = null
  let bestMtime = -1
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let names = []
    try { names = readdirSync(dir) } catch { continue }
    for (const name of names) {
      const full = join(dir, name)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!/goal_review/i.test(name) || !/\.log$/i.test(name)) continue
      if (resultMtimeMs != null && Number.isFinite(resultMtimeMs) && st.mtimeMs > resultMtimeMs + 2_000) {
        continue
      }
      if (st.mtimeMs >= bestMtime) {
        bestMtime = st.mtimeMs
        best = full
      }
    }
  }
  // No unbounded fallback to newer logs — wrong-run evidence is worse than none.
  return best
}

export function readLatestGoalReviewEvidence(commonGit, projectId = 'root', {
  resultPath = null,
} = {}) {
  let resultMtimeMs = null
  // When caller binds to a result.json, refuse unbounded newest-log enrich if
  // the result file is missing or unreadable (wrong-run risk).
  if (resultPath) {
    if (!existsSync(resultPath)) return { file: null, text: '', verdict: null }
    try {
      resultMtimeMs = statSync(resultPath).mtimeMs
    } catch {
      return { file: null, text: '', verdict: null }
    }
  }
  const file = findLatestGoalReviewEvidenceLog(commonGit, projectId, { resultMtimeMs })
  if (!file) return { file: null, text: '', verdict: null }
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { text = '' }
  return { file, text, verdict: parseGoalReviewEvidenceLog(text) }
}

/**
 * Classify a Goal Review close payload into a recovery kind.
 * @returns {null|{kind:string, acceptanceCheckIds:string[], defects:string[], summary:string, guidance:string, dirtyBlocked:boolean}}
 */
export function planGoalReviewCloseRecovery(result = {}) {
  if (!result || result.goal === true) return null
  const defects = Array.isArray(result.defects)
    ? result.defects.map((d) => (typeof d === 'string' ? d : String(d?.message || d || ''))).filter(Boolean)
    : []
  const dirtyBlocked = Boolean(result.blocked) && defects.some(isDirtyCheckoutDefect)
  const productDefects = defects.filter((d) => !isDirtyCheckoutDefect(d))
  const summary = String(result.summary || '').trim()

  // Prefer an explicit acceptanceCheckIds array when present — do not mine
  // extra AC-NNN tokens from summary/guidance/defect prose (Control Host notes
  // like "AC-025 integrated; AC-026 still owed" or "after AC-025 IV green"
  // must not reopen AC-025 — CauseFlow root 2026-07-17).
  const explicitIds = (result.acceptanceCheckIds || [])
    .map((id) => String(id || '').trim().toUpperCase())
    .filter((id) => /^AC-\d{3,}$/.test(id))
  const acceptanceCheckIds = explicitIds.length
    ? [...new Set(explicitIds)]
    : extractAcceptanceCheckIds({
      acceptanceCheckIds: [],
      defects: (dirtyBlocked && productDefects.length === 0) ? [] : productDefects,
    }, { includeSummary: false, includeGuidance: false })

  if (acceptanceCheckIds.length > 0) {
    const useDefects = productDefects.length ? productDefects : defects
    return {
      kind: 'evidence_reopen',
      acceptanceCheckIds,
      defects: useDefects,
      summary,
      dirtyBlocked,
      guidance: buildEvidenceReopenGuidance({
        summary,
        defects: useDefects,
        acceptanceCheckIds,
        dirtyBlocked,
      }),
    }
  }

  // Product defects / failing summary without AC-NNN tags — wake operator; do not
  // silently re-queue Goal Review as if dirt-only.
  if (productDefects.length > 0 || (result.goal === false && PROSE_FAIL_RE.test(summary))) {
    const useDefects = productDefects.length ? productDefects : (summary ? [summary] : defects)
    return {
      kind: 'unmapped_defects',
      acceptanceCheckIds: [],
      defects: useDefects,
      summary,
      dirtyBlocked,
      guidance: buildEvidenceReopenGuidance({
        summary,
        defects: useDefects,
        acceptanceCheckIds: [],
        dirtyBlocked,
      }),
    }
  }

  if (dirtyBlocked) {
    return {
      kind: 'dirt_retry',
      acceptanceCheckIds: [],
      defects,
      summary,
      dirtyBlocked: true,
      guidance:
        'Goal Review blocked on harness side-channel checkout dirt (.harness probes / journals). '
        + 'checkout-dirt.mjs ignores those paths — retry Goal Review read-only; do not reopen WIs for dirt alone.',
    }
  }

  if (result.blocked) {
    return {
      kind: 'blocked_input',
      acceptanceCheckIds: [],
      defects,
      summary,
      dirtyBlocked: false,
      guidance: summary || 'Goal Review blocked',
    }
  }

  if (result.goal === false && defects.length > 0) {
    return {
      kind: 'unmapped_defects',
      acceptanceCheckIds: [],
      defects,
      summary,
      dirtyBlocked: false,
      guidance: buildEvidenceReopenGuidance({ summary, defects, acceptanceCheckIds: [], dirtyBlocked: false }),
    }
  }

  return null
}

export function buildEvidenceReopenGuidance({
  summary = '',
  defects = [],
  acceptanceCheckIds = [],
  dirtyBlocked = false,
} = {}) {
  const lines = [
    dirtyBlocked
      ? 'Goal Review evidence named product defects but close was masked by harness dirty-checkout (side-channel). Reopen/repair named ACs; do not only re-queue Goal Review.'
      : 'Goal Review failed with product defects — repair named Work Items with implement coding (Repair Plan; not VERIFY-FIRST zero-diff), then Goal Review.',
  ]
  if (summary) lines.push(`Summary: ${summary}`)
  if (acceptanceCheckIds.length) lines.push(`Acceptance checks: ${acceptanceCheckIds.join(', ')}`)
  for (const defect of defects.slice(0, 8)) {
    lines.push(`Defect: ${defect}`)
  }
  return lines.join('\n')
}

function contextForItem(item) {
  return item.context || item.category || String(item.id || '') || null
}

/**
 * Pure reopen plan from catalog(+optional monorepo catalogs) + ledger + recovery.
 */
export function planEvidenceReopen({
  catalog = [],
  projectCatalogs = null,
  ledger = null,
  ledgersByProject = null,
  acceptanceCheckIds = [],
  defects = [],
  summary = '',
  dirtyBlocked = false,
  guidance = '',
  homeProjectId = 'root',
} = {}) {
  const text = guidance || buildEvidenceReopenGuidance({
    summary, defects, acceptanceCheckIds, dirtyBlocked,
  })
  const perContextGuidance = {}
  const contexts = new Set()
  const reopenLocal = []
  const reopenForeign = []
  const mappedLocal = []
  const mappedForeign = []
  /** @type {Array<{projectId:string,projectPath:string,id:string,context:string|null}>} */
  const foreignMappedRows = []

  const localItems = workItemsForAcceptanceChecks(catalog, acceptanceCheckIds)
  const homeCoveredAcs = new Set()
  for (const item of localItems) {
    const id = String(item.id)
    mappedLocal.push(id)
    for (const ac of item.acceptance_checks || item.acceptanceChecks || []) {
      homeCoveredAcs.add(String(ac || '').toUpperCase())
    }
    const progress = ledger?.items?.[id] || {}
    if (progress.integration === true) reopenLocal.push(id)
    const ctx = contextForItem(item)
    if (ctx) {
      contexts.add(ctx)
      perContextGuidance[ctx] = text
    }
  }

  if (Array.isArray(projectCatalogs) && projectCatalogs.length) {
    const cross = workItemsForAcceptanceChecksAcrossProjects(projectCatalogs, acceptanceCheckIds)
    for (const item of cross) {
      const pid = item.projectId || 'root'
      if (pid === homeProjectId) continue
      // Home catalog already owns these ACs — do not reopen sibling projects that
      // happen to reuse WI-AC-NNN / AC-NNN ids from an older completed plan
      // (CauseFlow root 2026-07-17: GR reopen flipped core/web WI-AC-025/026).
      const itemAcs = (item.acceptance_checks || item.acceptanceChecks || [])
        .map((ac) => String(ac || '').toUpperCase())
        .filter(Boolean)
      if (itemAcs.length && itemAcs.every((ac) => homeCoveredAcs.has(ac))) continue
      const ctx = contextForItem(item)
      mappedForeign.push(`${pid}:${item.id}`)
      foreignMappedRows.push({
        projectId: pid,
        projectPath: item.projectPath || '',
        id: String(item.id),
        context: ctx,
      })
      const foreignLedger = ledgersByProject?.[pid] || null
      const progress = foreignLedger?.items?.[item.id] || {}
      if (progress.integration === true) {
        reopenForeign.push({
          projectId: pid,
          projectPath: item.projectPath || '',
          id: String(item.id),
          context: ctx,
        })
      }
      if (ctx) {
        contexts.add(`${pid}:${ctx}`)
        perContextGuidance[`${pid}:${ctx}`] = text
      }
    }
  }

  const uniqueLocal = [...new Set(reopenLocal)]
  const trulyUnmapped = acceptanceCheckIds.length > 0
    && mappedLocal.length === 0
    && mappedForeign.length === 0
  return {
    reopenIds: uniqueLocal,
    reopenForeign,
    foreignMappedRows,
    contexts: [...contexts],
    perContextGuidance,
    clearGoalReviewRetry: uniqueLocal.length > 0 || reopenForeign.length > 0 || contexts.size > 0,
    guidance: text,
    mappedLocal,
    mappedForeign,
    unmapped: trulyUnmapped,
    repairInFlight: !trulyUnmapped
      && uniqueLocal.length === 0
      && reopenForeign.length === 0
      && (mappedLocal.length > 0 || mappedForeign.length > 0),
  }
}

export function recoveryFingerprint(result = {}) {
  const ids = extractAcceptanceCheckIds(result).join(',')
  const defects = (Array.isArray(result.defects) ? result.defects : [])
    .map((d) => String(d)).join('\n')
  const summary = String(result.summary || '')
  const digest = createHash('sha1')
    .update(`${result.blocked ? 1 : 0}|${result.goal}|${ids}|${summary}|${defects}`)
    .digest('hex')
    .slice(0, 16)
  return digest
}

/**
 * True when a Work Item has a green INTEGRATION_QA evidence log newer than
 * `afterMtimeMs` (Goal Review result time). Prevents stale GR recovery from
 * reopening a WI that just integrated (CauseFlow root 2026-07-17: AC-025 IV
 * green at T, recoverStale reopened from older GR evidence at T+1s).
 */
export function hasNewerGreenIntegrationQa(commonGit, projectId, workItemId, afterMtimeMs = 0) {
  if (!commonGit || !workItemId) return false
  const root = join(commonGit, 'harness-evidence', projectId || 'root')
  if (!existsSync(root)) return false
  const want = String(workItemId)
  const re = new RegExp(`^${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+-integration_qa-`, 'i')
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let names = []
    try { names = readdirSync(dir) } catch { continue }
    for (const name of names) {
      const full = join(dir, name)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!re.test(name) || !/\.log$/i.test(name)) continue
      if (!(st.mtimeMs > Number(afterMtimeMs || 0))) continue
      let text = ''
      try { text = readFileSync(full, 'utf8') } catch { continue }
      const verdict = parseVerdict(text)
      if (verdict && verdict.integration === true) return true
    }
  }
  return false
}

/**
 * Whether a persisted goal-review.result.json still needs zero-token recovery.
 */
export function shouldRecoverStaleGoalReviewResult(result = {}, {
  catalog = [],
  projectCatalogs = null,
  ledger = null,
  ledgersByProject = null,
  homeProjectId = 'root',
  evidenceText = '',
  lastFailure = null,
  now = Date.now(),
  debounceMs = 15_000,
  unmappedDebounceMs = 15 * 60_000,
  hasPendingUnmappedInput = false,
  hasGoalReviewRetry = false,
  commonGit = null,
  resultMtimeMs = null,
  evidenceMtimeMs = null,
} = {}) {
  const enriched = evidenceText
    ? enrichResultFromEvidence(result, evidenceText)
    : result
  const recovery = planGoalReviewCloseRecovery(enriched)
  if (!recovery) return null
  if (
    recovery.kind !== 'evidence_reopen'
    && recovery.kind !== 'unmapped_defects'
    && recovery.kind !== 'dirt_retry'
  ) return null

  const fp = recoveryFingerprint(enriched)
  if (lastFailure?.fingerprint === fp && lastFailure?.at) {
    const age = now - Date.parse(lastFailure.at)
    const window = recovery.kind === 'unmapped_defects' || lastFailure.unmapped
      ? unmappedDebounceMs
      : debounceMs
    if (Number.isFinite(age) && age >= 0 && age < window) return null
  }

  if (recovery.kind === 'dirt_retry') {
    // Worker-close may have crashed before seeding retryQueue['goal-review'].
    if (hasGoalReviewRetry) return null
    // Premature while any WI is still open — finish repair/INTEGRATION first.
    // Otherwise recoverStale emits goal_review_retry every debounce window and
    // briefs "GR failed" on side-channel dirt while oss-golden-path is mid-QA
    // (CauseFlow root 2026-07-17).
    const items = ledger?.items && typeof ledger.items === 'object' ? Object.values(ledger.items) : []
    if (items.some((row) => row && row.integration !== true)) return null
    return { recovery, plan: null, enriched, fingerprint: fp }
  }

  if (recovery.kind === 'unmapped_defects') {
    // Pending goal input already covers the operator wake — don't re-spam.
    // Do not latch forever on unmappedEscalated (operator may clear input).
    if (hasPendingUnmappedInput) return null
    return { recovery, plan: null, enriched, fingerprint: fp }
  }

  const plan = planEvidenceReopen({
    catalog,
    projectCatalogs,
    ledger,
    ledgersByProject,
    acceptanceCheckIds: recovery.acceptanceCheckIds,
    defects: recovery.defects,
    summary: recovery.summary,
    dirtyBlocked: recovery.dirtyBlocked,
    guidance: recovery.guidance,
    homeProjectId,
  })
  // Prefer GR evidence mtime (or result.at) — not result.json mtime. Rewriting
  // result.json after a successful IV would otherwise make afterMs newer than
  // the IV log and false-reopen the just-integrated WI (CauseFlow root AC-025).
  const atMs = Date.parse(String(enriched?.at || result?.at || ''))
  const afterMs = [
    Number.isFinite(evidenceMtimeMs) ? evidenceMtimeMs : null,
    Number.isFinite(atMs) ? atMs : null,
    Number.isFinite(resultMtimeMs) ? resultMtimeMs : null,
    0,
  ].find((n) => n != null && Number.isFinite(n))
  const reopenIds = commonGit
    ? plan.reopenIds.filter((id) => !hasNewerGreenIntegrationQa(commonGit, homeProjectId, id, afterMs))
    : plan.reopenIds
  const reopenForeign = commonGit
    ? plan.reopenForeign.filter((row) => !hasNewerGreenIntegrationQa(
      commonGit,
      row.projectId || homeProjectId,
      row.id,
      afterMs,
    ))
    : plan.reopenForeign
  if (reopenIds.length || reopenForeign.length) {
    return {
      recovery,
      plan: { ...plan, reopenIds, reopenForeign },
      enriched,
      fingerprint: fp,
    }
  }
  // Every mapped reopen was superseded by newer green INTEGRATION_QA evidence.
  if ((plan.reopenIds.length || plan.reopenForeign.length) && commonGit) return null
  // Mapped ACs but nothing left to reopen — repair already in progress.
  if (plan.repairInFlight || plan.mappedLocal.length || plan.mappedForeign.length) return null
  // Named ACs with no catalog hit anywhere — escalate as unmapped.
  if (hasPendingUnmappedInput) return null
  return { recovery: { ...recovery, kind: 'unmapped_defects' }, plan, enriched, fingerprint: fp }
}
