#!/usr/bin/env node
/**
 * Interactive spec review loop for planner/setup.
 * Draft lives in .harness/project_specs.draft.json until the user confirms every item.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parseProjectSpecification } from '../generator/lib/project-specification.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = join(__dirname, 'assets', 'spec_review.html')
const DRAFT = 'project_specs.draft.json'
const FEEDBACK = 'spec-review-feedback.json'
const HTML_OUT = 'spec-review.html'
const STATE = 'spec-review-state.json'

function harnessDir(projectDir) {
  return join(resolve(projectDir), '.harness')
}

function paths(projectDir) {
  const dir = harnessDir(projectDir)
  return {
    dir,
    draft: join(dir, DRAFT),
    feedback: join(dir, FEEDBACK),
    html: join(dir, HTML_OUT),
    state: join(dir, STATE),
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function loadDraft(projectDir) {
  const { draft } = paths(projectDir)
  if (!existsSync(draft)) {
    console.error(`missing ${draft}; planner must write a draft before review`)
    process.exit(1)
  }
  const data = readJson(draft)
  if (!data.xml_draft || typeof data.xml_draft !== 'string') {
    console.error('draft must include xml_draft (full specification XML string)')
    process.exit(1)
  }
  if (!Array.isArray(data.items) || data.items.length === 0) {
    console.error('draft must include a non-empty items array for review')
    process.exit(1)
  }
  return data
}

function loadFeedback(projectDir) {
  const { feedback } = paths(projectDir)
  if (!existsSync(feedback)) return null
  return readJson(feedback)
}

function validateFeedbackShape(feedback, draft) {
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

function cmdRender(projectDir) {
  const p = paths(projectDir)
  const draft = loadDraft(projectDir)
  const feedback = loadFeedback(projectDir)
  let template = readFileSync(TEMPLATE, 'utf8')
  const initialFeedback = feedback?.items ?? []
  template = template
    .replaceAll('__PROJECT_NAME__', escapeHtml(draft.project_name ?? 'Project specification'))
    .replaceAll('__REVISION__', String(draft.revision ?? 1))
    .replaceAll('__ITEMS_DATA__', JSON.stringify(draft.items))
    .replaceAll('__INITIAL_FEEDBACK__', JSON.stringify(initialFeedback))
    .replaceAll('__FEEDBACK_PATH__', escapeHtml(p.feedback))
    .replaceAll('__HTML_PATH__', escapeHtml(p.html))
  mkdirSync(p.dir, { recursive: true })
  writeFileSync(p.html, template, 'utf8')
  writeJson(p.state, {
    revision: draft.revision ?? 1,
    rendered_at: new Date().toISOString(),
    html: p.html,
    feedback: p.feedback,
  })
  console.log(p.html)
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function cmdStatus(projectDir, { json = false } = {}) {
  const report = reviewStatus(projectDir)
  if (json) {
    console.log(JSON.stringify(report, null, 2))
  } else if (report.ready) {
    console.log(`ready: all ${report.total} specification items confirmed`)
  } else if (report.needs_revision.length) {
    console.log(`needs_revision: ${report.needs_revision.length} item(s) have comments`)
    for (const row of report.needs_revision) {
      console.log(`  - ${row.id}: ${row.comment}`)
    }
  } else {
    console.log(`incomplete: ${report.missing.length} item(s) not confirmed`)
    for (const id of report.missing) console.log(`  - ${id}`)
  }
  process.exit(report.ready ? 0 : report.needs_revision.length ? 2 : 1)
}

function cmdFinalize(projectDir) {
  const report = reviewStatus(projectDir)
  if (!report.ready) {
    console.error('cannot finalize: specification review is not complete')
    if (report.needs_revision.length) {
      console.error(`needs_revision: ${report.needs_revision.length} item(s) have comments`)
      for (const row of report.needs_revision) console.error(`  - ${row.id}: ${row.comment}`)
    } else {
      console.error(`incomplete: ${report.missing.length} item(s) not confirmed`)
      for (const id of report.missing) console.error(`  - ${id}`)
    }
    process.exit(1)
  }
  const draft = loadDraft(projectDir)
  const feedback = loadFeedback(projectDir)
  const shapeError = validateFeedbackShape(feedback, draft)
  if (shapeError) {
    console.error(shapeError)
    process.exit(1)
  }
  try {
    parseProjectSpecification(draft.xml_draft)
  } catch (error) {
    console.error(`cannot finalize: invalid project specification: ${error.message}`)
    process.exit(1)
  }
  const root = resolve(projectDir)
  const target = join(root, 'project_specs.xml')
  writeFileSync(target, draft.xml_draft.endsWith('\n') ? draft.xml_draft : `${draft.xml_draft}\n`, 'utf8')
  const p = paths(projectDir)
  for (const file of [p.draft, p.feedback, p.html, p.state]) {
    if (existsSync(file)) unlinkSync(file)
  }
  console.log(target)
}

function cmdOpen(projectDir) {
  const p = paths(projectDir)
  if (!existsSync(p.html)) cmdRender(projectDir)
  const file = p.html
  const platform = process.platform
  const openers = platform === 'darwin' ? ['open'] : platform === 'win32' ? ['cmd', '/c', 'start', ''] : ['xdg-open']
  const args = platform === 'win32' ? [...openers, file] : [...openers, file]
  const result = spawnSync(args[0], args.slice(1), { stdio: 'inherit' })
  if (result.status !== 0) {
    console.log(file)
    process.exit(result.status ?? 1)
  }
}

function usage() {
  console.error(`usage: spec-review.mjs <command> <projectDir>

commands:
  render <projectDir>   write .harness/spec-review.html from draft
  open <projectDir>     render (if needed) and open the HTML review in a browser
  status <projectDir>   exit 0 when every item is confirmed with no open comments
                        exit 2 when comments request planner revisions
                        exit 1 when review is incomplete
  status --json <projectDir>
  finalize <projectDir> write project_specs.xml after successful review`)
  process.exit(1)
}

function main() {
  const [command, projectDir, ...rest] = process.argv.slice(2)
  if (!command || !projectDir) usage()

  switch (command) {
    case 'render':
      cmdRender(projectDir)
      break
    case 'open':
      cmdOpen(projectDir)
      break
    case 'status':
      cmdStatus(projectDir, { json: rest.includes('--json') })
      break
    case 'finalize':
      cmdFinalize(projectDir)
      break
    default:
      usage()
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
