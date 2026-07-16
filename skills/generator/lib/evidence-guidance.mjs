import { existsSync, readFileSync } from 'node:fs'
import { parseVerdict, VERDICT_BEGIN } from './worker-outcome.mjs'

const MAX_GUIDANCE_CHARS = 800
const MAX_DEFECT_LINES = 3

function parseEvidenceHeader(text = '') {
  const lines = String(text).split('\n')
  const meta = {}
  let bodyStart = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) { bodyStart = i + 1; break }
    const eq = line.indexOf('=')
    if (eq <= 0) { bodyStart = i; break }
    meta[line.slice(0, eq)] = line.slice(eq + 1)
  }
  const body = lines.slice(bodyStart).join('\n').trim()
  return { meta, body }
}

function resolveEvidencePath(evidencePathOrDigest) {
  if (!evidencePathOrDigest) return null
  if (typeof evidencePathOrDigest === 'string') return evidencePathOrDigest
  if (typeof evidencePathOrDigest === 'object') {
    return evidencePathOrDigest.path || evidencePathOrDigest.evidence || null
  }
  return null
}

/** Pull expected/observed pairs from harness defect strings (read-only). */
export function extractDefectPairs(defects = []) {
  const pairs = []
  for (const defect of defects.slice(0, MAX_DEFECT_LINES)) {
    const text = String(defect || '').trim()
    if (!text) continue
    const expected = text.match(/\bexpected\s+([^;]+)/i)?.[1]?.trim() || null
    const observed = text.match(/\bobserved\s+([^;]+)/i)?.[1]?.trim() || null
    if (expected || observed) {
      pairs.push({
        expected: expected || '(unspecified)',
        observed: observed || '(unspecified)',
        raw: text,
      })
    } else {
      pairs.push({ raw: text.slice(0, 240) })
    }
  }
  return pairs
}

/** Format defect pairs into a short guidance excerpt. */
export function formatDefectGuidance(pairs = [], { kind = null } = {}) {
  if (!pairs.length) return ''
  const lines = pairs.map((pair) => {
    if (pair.expected && pair.observed) {
      return `expected: ${pair.expected}; observed: ${pair.observed}`
    }
    return pair.raw
  })
  const prefix = kind ? `Evidence (${kind}): ` : 'Evidence: '
  return `${prefix}${lines.join(' | ')}`.slice(0, MAX_GUIDANCE_CHARS)
}

/**
 * Read-only excerpt from a create-only evidence artifact path or { path, digest }.
 * Never mutates the artifact (ADR-0014).
 */
export function evidenceGuidanceExcerpt(evidencePathOrDigest) {
  const path = resolveEvidencePath(evidencePathOrDigest)
  if (!path || !existsSync(path)) return ''

  let text
  try { text = readFileSync(path, 'utf8') } catch { return '' }
  if (!text.trim()) return ''

  const { meta, body } = parseEvidenceHeader(text)
  const verdict = parseVerdict(body)
  if (verdict && typeof verdict === 'object') {
    const pairs = extractDefectPairs(verdict.defects || [])
    if (pairs.length) return formatDefectGuidance(pairs, { kind: meta.kind || null })
    if (verdict.notes) return `Evidence (${meta.kind || 'verdict'}): ${String(verdict.notes).slice(0, 400)}`
    if (verdict.summary) return `Evidence (${meta.kind || 'verdict'}): ${String(verdict.summary).slice(0, 400)}`
  }

  const tail = body.includes(VERDICT_BEGIN)
    ? body.slice(body.lastIndexOf(VERDICT_BEGIN)).slice(0, 400)
    : body.slice(-400)
  return `Evidence excerpt: ${tail.trim()}`.slice(0, MAX_GUIDANCE_CHARS)
}

/** Attach evidence excerpts to supervisor retry / input guidance (read-only). */
export function enrichGuidanceWithEvidence(baseGuidance = '', detail = {}) {
  const parts = [String(baseGuidance || '').trim()].filter(Boolean)

  const defectPairs = extractDefectPairs(detail.defects || [])
  if (defectPairs.length) {
    const fromDefects = formatDefectGuidance(defectPairs)
    if (fromDefects && !parts.some((part) => part.includes(fromDefects.slice(0, 40)))) {
      parts.push(fromDefects)
    }
  }

  const evidencePath = detail.evidence
    || (String(detail.log || '').includes('harness-evidence') ? detail.log : null)
  if (evidencePath) {
    const excerpt = evidenceGuidanceExcerpt(evidencePath)
    if (excerpt && !parts.some((part) => part.includes(excerpt.slice(0, 40)))) {
      parts.push(excerpt)
    }
  }

  return parts.join('\n').slice(0, MAX_GUIDANCE_CHARS * 2)
}
