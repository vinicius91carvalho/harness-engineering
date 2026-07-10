#!/usr/bin/env node
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { reviewStatus } from '../skills/planner/spec-review.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const script = join(root, '..', 'skills', 'planner', 'spec-review.mjs')
const tmp = mkdtempSync(join(tmpdir(), 'spec-review-test-'))

function assert(condition, message) {
  if (!condition) {
    console.error(`not ok - ${message}`)
    process.exit(1)
  }
}

function run(args) {
  return spawnSync('node', [script, ...args], { encoding: 'utf8' })
}

const harness = join(tmp, '.harness')
mkdirSync(harness, { recursive: true })

const draft = {
  version: 1,
  revision: 1,
  project_name: 'Demo',
  xml_draft: `<project_specification>
  <project_name>Demo</project_name>
  <project_goal>Users can publish notes.</project_goal>
  <acceptance_checks>
    <acceptance_check id="AC-001" context="notes" category="functional" depends_on="">
      <description>POST /notes returns 201.</description>
    </acceptance_check>
  </acceptance_checks>
</project_specification>`,
  items: [
    { id: 'project_goal', kind: 'section', title: 'Project Goal', summary: 'Ship notes', body: 'Users can publish notes.' },
    { id: 'AC-001', kind: 'acceptance_check', title: 'AC-001', summary: 'Publish works', body: 'POST /notes returns 201.' },
  ],
}
writeFileSync(join(harness, 'project_specs.draft.json'), `${JSON.stringify(draft, null, 2)}\n`)

const render = run(['render', tmp])
assert(render.status === 0, 'render succeeds')
const htmlPath = render.stdout.trim()
assert(existsSync(htmlPath), 'html file exists')
assert(readFileSync(htmlPath, 'utf8').includes('Specification review'), 'html contains title')
assert(readFileSync(htmlPath, 'utf8').includes('AC-001'), 'html lists acceptance check')

let status = run(['status', tmp])
assert(status.status === 1, 'status incomplete without feedback')

writeFileSync(join(harness, 'spec-review-feedback.json'), `${JSON.stringify({
  revision: 1,
  items: [
    { id: 'project_goal', confirmed: true, comment: '' },
    { id: 'AC-001', confirmed: false, comment: 'Mention reload persistence' },
  ],
}, null, 2)}\n`)

status = run(['status', tmp])
assert(status.status === 2, 'status needs revision when comments exist')
assert(reviewStatus(tmp).needs_revision.length === 1, 'reviewStatus reports comment')

writeFileSync(join(harness, 'spec-review-feedback.json'), `${JSON.stringify({
  revision: 1,
  items: [
    { id: 'project_goal', confirmed: true, comment: '' },
    { id: 'AC-001', confirmed: true, comment: '' },
  ],
}, null, 2)}\n`)

status = run(['status', tmp])
assert(status.status === 0, 'status ready when all confirmed')

const finalize = run(['finalize', tmp])
assert(finalize.status === 0, 'finalize succeeds')
assert(existsSync(join(tmp, 'project_specs.xml')), 'project_specs.xml written')
assert(!existsSync(join(harness, 'project_specs.draft.json')), 'draft removed after finalize')

const invalidHarness = join(tmp, 'invalid')
mkdirSync(join(invalidHarness, '.harness'), { recursive: true })
writeFileSync(join(invalidHarness, '.harness', 'project_specs.draft.json'), `${JSON.stringify({
  revision: 1,
  project_name: 'Bad',
  xml_draft: '<project_specification><project_name>Bad</project_name></project_specification>',
  items: [{ id: 'project_goal', kind: 'section', title: 'Project Goal', summary: 'Missing goal tag', body: 'Invalid draft.' }],
}, null, 2)}\n`)
writeFileSync(join(invalidHarness, '.harness', 'spec-review-feedback.json'), `${JSON.stringify({
  revision: 1,
  items: [{ id: 'project_goal', confirmed: true, comment: '' }],
}, null, 2)}\n`)
const invalidFinalize = run(['finalize', invalidHarness])
assert(invalidFinalize.status !== 0, 'finalize rejects invalid specification')
assert(invalidFinalize.stderr.includes('invalid project specification'), 'finalize reports validation error')

console.log('ok - spec review render, status, and finalize')
