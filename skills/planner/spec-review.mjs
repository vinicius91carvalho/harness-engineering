#!/usr/bin/env node
/**
 * Interactive spec review loop for planner/setup.
 * Draft lives in .harness/project_specs.draft.json until the user confirms every item.
 *
 * `open` serves the review on localhost, blocks until the browser POSTs feedback,
 * writes .harness/spec-review-feedback.json, then exits:
 *   0 = ready to finalize
 *   2 = comments need planner revision
 *   1 = incomplete / error
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { parseProjectSpecification } from '../generator/lib/project-specification.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = join(__dirname, 'assets', 'spec_review.html')
const DRAFT = 'project_specs.draft.json'
const FEEDBACK = 'spec-review-feedback.json'
const HTML_OUT = 'spec-review.html'
const STATE = 'spec-review-state.json'
const DONE = 'spec-review-done.json'

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
    done: join(dir, DONE),
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

function statusExitCode(report) {
  if (report.ready) return 0
  if (report.needs_revision.length) return 2
  return 1
}

function buildHtml(projectDir, { reviewOrigin = '' } = {}) {
  const p = paths(projectDir)
  const draft = loadDraft(projectDir)
  const feedback = loadFeedback(projectDir)
  let template = readFileSync(TEMPLATE, 'utf8')
  const initialFeedback = feedback?.items ?? []
  return template
    .replaceAll('__PROJECT_NAME__', escapeHtml(draft.project_name ?? 'Project specification'))
    .replaceAll('__REVISION__', String(draft.revision ?? 1))
    .replaceAll('__ITEMS_DATA__', JSON.stringify(draft.items))
    .replaceAll('__INITIAL_FEEDBACK__', JSON.stringify(initialFeedback))
    .replaceAll('__FEEDBACK_PATH__', escapeHtml(p.feedback))
    .replaceAll('__HTML_PATH__', escapeHtml(p.html))
    .replaceAll('__REVIEW_ORIGIN__', JSON.stringify(reviewOrigin))
}

function cmdRender(projectDir) {
  const p = paths(projectDir)
  const html = buildHtml(projectDir, { reviewOrigin: '' })
  mkdirSync(p.dir, { recursive: true })
  writeFileSync(p.html, html, 'utf8')
  writeJson(p.state, {
    revision: loadDraft(projectDir).revision ?? 1,
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

function printStatus(report, { json = false } = {}) {
  if (json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  if (report.ready) {
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
}

function cmdStatus(projectDir, { json = false } = {}) {
  const report = reviewStatus(projectDir)
  printStatus(report, { json })
  process.exit(statusExitCode(report))
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
  for (const file of [p.draft, p.feedback, p.html, p.state, p.done]) {
    if (existsSync(file)) unlinkSync(file)
  }
  console.log(target)
}

function which(bin) {
  const result = spawnSync('which', [bin], { encoding: 'utf8' })
  if (result.status !== 0) return null
  return result.stdout.trim() || null
}

function openBrowser(url) {
  // Prefer a Chromium app window so window.close() after submit actually works.
  // xdg-open / plain tabs usually ignore window.close().
  const chromiumBins = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']
  for (const bin of chromiumBins) {
    const path = which(bin)
    if (!path) continue
    try {
      const child = spawn(path, [`--app=${url}`, '--new-window', '--no-first-run'], {
        stdio: 'ignore',
        detached: true,
      })
      child.unref()
      return true
    } catch {
      // try next binary
    }
  }
  const platform = process.platform
  const openers = platform === 'darwin' ? ['open'] : platform === 'win32' ? ['cmd', '/c', 'start', ''] : ['xdg-open']
  const args = platform === 'win32' ? [...openers, url] : [...openers, url]
  const result = spawnSync(args[0], args.slice(1), { stdio: 'ignore' })
  return result.status === 0
}

function readRequestBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'access-control-allow-origin': '*',
  })
  res.end(payload)
}

async function cmdOpen(projectDir, { timeoutMs = 0, noBrowser = false } = {}) {
  const p = paths(projectDir)
  const draft = loadDraft(projectDir)
  mkdirSync(p.dir, { recursive: true })

  let settle
  const done = new Promise((resolveDone) => {
    settle = resolveDone
  })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type',
      })
      res.end()
      return
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const origin = `http://127.0.0.1:${server.address().port}`
      const html = buildHtml(projectDir, { reviewOrigin: origin })
      writeFileSync(p.html, html, 'utf8')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }

    if (req.method === 'POST' && url.pathname === '/feedback') {
      try {
        const raw = await readRequestBody(req)
        const feedback = JSON.parse(raw)
        const shapeError = validateFeedbackShape(feedback, draft)
        if (shapeError) {
          sendJson(res, 400, { ok: false, error: shapeError })
          return
        }
        feedback.exported_at = feedback.exported_at || new Date().toISOString()
        writeJson(p.feedback, feedback)
        writeJson(p.state, {
          revision: draft.revision ?? 1,
          submitted_at: new Date().toISOString(),
          html: p.html,
          feedback: p.feedback,
          mode: 'localhost-submit',
        })
        const report = reviewStatus(projectDir)
        const exitCode = statusExitCode(report)
        writeJson(p.done, {
          revision: draft.revision ?? 1,
          submitted_at: new Date().toISOString(),
          exitCode,
          ready: report.ready,
          needs_revision: report.needs_revision,
          missing: report.missing,
        })
        sendJson(res, 200, {
          ok: true,
          ready: report.ready,
          exitCode,
          missing: report.missing,
          needs_revision: report.needs_revision,
          confirmed_count: report.confirmed_count,
          total: report.total,
        })
        // Let the response flush before shutting down the server.
        setImmediate(() => settle({ report }))
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message || String(error) })
      }
      return
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true })
      return
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  })

  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveListen())
  })

  const { port } = server.address()
  const origin = `http://127.0.0.1:${port}`
  writeFileSync(p.html, buildHtml(projectDir, { reviewOrigin: origin }), 'utf8')
  writeJson(p.state, {
    revision: draft.revision ?? 1,
    opened_at: new Date().toISOString(),
    html: p.html,
    feedback: p.feedback,
    origin,
  })
  console.log(origin)
  console.error(`spec-review: waiting for Submit and continue at ${origin}`)
  console.error('spec-review: use the Chromium app window opened for this URL; ignore older file:// or previous review tabs')

  if (!noBrowser) {
    const opened = openBrowser(origin)
    if (!opened) console.error(`spec-review: open the review URL manually: ${origin}`)
  }

  let timer = null
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      settle({ report: null, timedOut: true })
    }, timeoutMs)
  }

  const result = await done
  if (timer) clearTimeout(timer)
  await new Promise((resolveClose) => server.close(() => resolveClose()))

  if (result.timedOut) {
    console.error('spec-review: timed out waiting for feedback submit')
    process.exit(1)
  }

  printStatus(result.report)
  process.exit(statusExitCode(result.report))
}

function usage() {
  console.error(`usage: spec-review.mjs <command> <projectDir>

commands:
  render <projectDir>   write .harness/spec-review.html from draft
  open <projectDir>     serve review on localhost, open browser, block until submit
                        exit 0 when every item is confirmed with no open comments
                        exit 2 when comments request planner revisions
                        exit 1 when review is incomplete / timed out
  open --no-browser <projectDir>
  open --timeout-ms <ms> <projectDir>
  status <projectDir>   exit 0 / 2 / 1 from existing feedback file
  status --json <projectDir>
  finalize <projectDir> write project_specs.xml after successful review`)
  process.exit(1)
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  let projectDir = null
  let timeoutMs = 0
  let noBrowser = false
  let json = false
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === '--no-browser') noBrowser = true
    else if (arg === '--json') json = true
    else if (arg === '--timeout-ms') {
      timeoutMs = Number(rest[++i] || 0)
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
        console.error('invalid --timeout-ms')
        process.exit(1)
      }
    } else if (!arg.startsWith('-') && !projectDir) {
      projectDir = arg
    } else {
      console.error(`unknown argument: ${arg}`)
      usage()
    }
  }
  return { command, projectDir, timeoutMs, noBrowser, json }
}

function main() {
  const { command, projectDir, timeoutMs, noBrowser, json } = parseArgs(process.argv.slice(2))
  if (!command || !projectDir) usage()

  switch (command) {
    case 'render':
      cmdRender(projectDir)
      break
    case 'open':
      cmdOpen(projectDir, { timeoutMs, noBrowser })
      break
    case 'status':
      cmdStatus(projectDir, { json })
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
