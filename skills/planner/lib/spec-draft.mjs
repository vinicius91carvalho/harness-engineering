import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const DRAFT = 'project_specs.draft.json'
const FEEDBACK = 'spec-review-feedback.json'
const HTML_OUT = 'spec-review.html'
const STATE = 'spec-review-state.json'
const DONE = 'spec-review-done.json'

export function harnessDir(projectDir) {
  return join(resolve(projectDir), '.harness')
}

export function paths(projectDir) {
  const dir = harnessDir(projectDir)
  return {
    dir,
    draft: join(dir, DRAFT),
    feedback: join(dir, FEEDBACK),
    html: join(dir, HTML_OUT),
    state: join(dir, STATE),
    done: join(dir, DONE),
  }
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

export function loadDraft(projectDir) {
  const { draft } = paths(projectDir)
  if (!existsSync(draft)) {
    throw new Error(`missing ${draft}; planner must write a draft before review`)
  }
  const data = readJson(draft)
  if (!data.xml_draft || typeof data.xml_draft !== 'string') {
    throw new Error('draft must include xml_draft (full specification XML string)')
  }
  if (!Array.isArray(data.items) || data.items.length === 0) {
    throw new Error('draft must include a non-empty items array for review')
  }
  return data
}

export function loadFeedback(projectDir) {
  const { feedback } = paths(projectDir)
  if (!existsSync(feedback)) return null
  return readJson(feedback)
}

export function validateFeedbackShape(feedback, draft) {
  if (!feedback || typeof feedback !== 'object') return 'feedback is not an object'
  if (feedback.revision != null && draft.revision != null && feedback.revision !== draft.revision) {
    return `feedback revision ${feedback.revision} does not match draft revision ${draft.revision}`
  }
  if (!Array.isArray(feedback.items)) return 'feedback.items must be an array'
  const ids = new Set(draft.items.map((item) => item.id))
  for (const row of feedback.items) {
    if (!ids.has(row.id)) return `unknown feedback item id: ${row.id}`
  }
  return null
}

export function reviewStatus(projectDir) {
  const draft = loadDraft(projectDir)
  const feedback = loadFeedback(projectDir)
  const itemIds = draft.items.map((item) => item.id)
  const byId = new Map((feedback?.items ?? []).map((row) => [row.id, row]))

  const missing = []
  const needsRevision = []
  const confirmed = []

  for (const id of itemIds) {
    const row = byId.get(id)
    if (!row) {
      missing.push(id)
      continue
    }
    const comment = String(row.comment ?? '').trim()
    if (comment && !row.confirmed) {
      needsRevision.push({ id, comment })
      continue
    }
    if (row.confirmed) {
      confirmed.push(id)
      continue
    }
    missing.push(id)
  }

  const ready = missing.length === 0 && needsRevision.length === 0
  return {
    ready,
    revision: draft.revision ?? 1,
    project_name: draft.project_name ?? '',
    missing,
    needs_revision: needsRevision,
    confirmed_count: confirmed.length,
    total: itemIds.length,
  }
}

export function statusExitCode(report) {
  if (report.ready) return 0
  if (report.needs_revision.length) return 2
  return 1
}
