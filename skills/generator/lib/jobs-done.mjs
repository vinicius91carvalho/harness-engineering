/**
 * Detect Work Items / Goal Review work that is already done.
 * Source of truth: Execution Ledger (+ optional evidence). feature_list.json
 * progress flags may lag (flag drift) and must not alone reopen integrated work.
 */

import { existsSync, readFileSync } from 'node:fs'
import { progressOf } from './completion-contract.mjs'

/**
 * @returns {{ id: string, implementation: boolean, qa: boolean, integration: boolean }[]}
 */
export function ledgerProgressRows(catalog, ledger) {
  if (!Array.isArray(catalog)) return []
  return catalog.map((item) => {
    const p = progressOf(item, ledger)
    return {
      id: String(item.id),
      implementation: p.implementation === true,
      qa: p.qa === true,
      integration: p.integration === true,
      blocked: p.blocked === true,
      retries: Number(p.retries || 0),
    }
  })
}

export function integratedIds(catalog, ledger) {
  return ledgerProgressRows(catalog, ledger)
    .filter((row) => row.integration)
    .map((row) => row.id)
}

export function incompleteIds(catalog, ledger) {
  return ledgerProgressRows(catalog, ledger)
    .filter((row) => !row.integration && !row.blocked)
    .map((row) => row.id)
}

/** True when a Goal Review defect is only complaining about feature_list flag drift. */
export function isFeatureListFlagDriftDefect(text) {
  const t = String(text || '')
  if (!/feature_list\.json/i.test(t)) return false
  if (!/integration\s*=\s*false|not integrated|non-integrated|integration:false/i.test(t)) return false
  // Real product/compose defects that happen to mention feature_list are kept.
  if (/compose|docker|http|curl|playwright|typescript|tsc|build fail|404|500|ECONNREFUSED/i.test(t)
    && !/Execution Ledger fully integrated/i.test(t)) {
    return false
  }
  return true
}

/** Pull AC-NNN ids mentioned in defect / summary text. */
export function acceptanceIdsFromText(text) {
  const ids = String(text || '').match(/\bAC-\d+\b/g) || []
  return [...new Set(ids)]
}

/**
 * Drop flag-drift-only defects when the ledger already shows those WIs integrated.
 * Keeps real black-box / compose / test failures.
 *
 * When real defects remain, derive acceptanceCheckIds from those defect texts
 * (not the agent all-AC dump). Ledger-integrated WIs with proven product/runtime
 * defects stay reopenable — flag drift filtering must not drop them.
 */
const PRODUCT_SUMMARY_RE = /\b(fail|failed|failure|defect|broken|unreachable|ECONNREFUSED|compose|docker|http|expected\b.+\bobserved)\b/i

export function filterGoalReviewFlagDrift({
  defects = [],
  acceptanceCheckIds = [],
  summary = '',
  catalog,
  ledger,
} = {}) {
  const keptDefects = (defects || []).filter((d) => !isFeatureListFlagDriftDefect(d))
  const strippedDrift = (defects || []).length > 0 && keptDefects.length < (defects || []).length
  let keptIds = acceptanceCheckIds || []
  if (strippedDrift && keptDefects.length === 0) {
    // Summary still looks like a real product fail — keep AC ids / do not
    // treat as flag-drift-only empty (orchestrator would mute into GR-retry).
    if (PRODUCT_SUMMARY_RE.test(String(summary || ''))) {
      const fromSummary = acceptanceIdsFromText(summary)
      keptIds = fromSummary.length ? fromSummary : (acceptanceCheckIds || [])
    } else {
      keptIds = []
    }
  } else if (keptDefects.length > 0) {
    const fromDefects = keptDefects.flatMap((d) => acceptanceIdsFromText(d))
    if (fromDefects.length) {
      keptIds = fromDefects
    }
    // else keep caller acceptanceCheckIds — real defects without AC tags still need reopen via operator guidance
  }
  return { defects: keptDefects, acceptanceCheckIds: keptIds, strippedDrift }
}

/**
 * Compact ledger summary for Goal Review prompts (jobs already done).
 */
export function formatJobsDoneForPrompt(catalog, ledger, { ledgerPath = null } = {}) {
  const rows = ledgerProgressRows(catalog, ledger)
  const done = rows.filter((r) => r.integration)
  const open = rows.filter((r) => !r.integration)
  const lines = [
    'JOBS-ALREADY-DONE DETECTION (authoritative):',
    `- Execution Ledger${ledgerPath ? ` at ${ledgerPath}` : ''} is the only source of truth for implementation/qa/integration.`,
    '- feature_list.json progress flags may lag (flag drift). Never reopen or fail Goal Review solely because feature_list shows integration=false when the ledger (and/or harness-evidence INTEGRATION_QA verdict) already shows the Work Item integrated.',
    `- Integrated Work Items (${done.length}/${rows.length}): ${done.map((r) => r.id).join(', ') || '(none)'}`,
  ]
  if (open.length) {
    lines.push(`- Not yet integrated (${open.length}): ${open.map((r) => r.id).join(', ')}`)
  } else {
    lines.push('- Queue is fully integrated in the ledger. Goal Review must black-box verify the Project Goal on compose/HTTP — do not invent incomplete-queue defects from feature_list.')
  }
  return lines.join('\n')
}

/** Read ledger JSON if present. */
export function readLedgerFile(ledgerPath) {
  if (!ledgerPath || !existsSync(ledgerPath)) return { version: 1, items: {} }
  try {
    return JSON.parse(readFileSync(ledgerPath, 'utf8'))
  } catch {
    return { version: 1, items: {} }
  }
}
