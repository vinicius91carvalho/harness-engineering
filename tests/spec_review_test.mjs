#!/usr/bin/env node
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
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
    { id: 'AC-001', kind: 'acceptance_check', title: 'AC-001', summary: 'Publish works', body: 'POST /notes returns 201. Include </script><script>globalThis.injected=true</script> safely.' },
  ],
}
writeFileSync(join(harness, 'project_specs.draft.json'), `${JSON.stringify(draft, null, 2)}\n`)

const render = run(['render', tmp])
assert(render.status === 0, 'render succeeds')
const htmlPath = render.stdout.trim()
assert(existsSync(htmlPath), 'html file exists')
const html = readFileSync(htmlPath, 'utf8')
assert(html.includes('Specification review'), 'html contains title')
assert(html.includes('AC-001'), 'html lists acceptance check')
assert(!html.includes('</script><script>globalThis.injected=true'), 'inline script data escapes script terminators')
assert(html.includes('\\u003c/script\\u003e'), 'rendered script data keeps escaped spec text')
assert(html.includes('Submit and continue'), 'html has submit CTA')
assert(html.includes('function submitFeedback'), 'html defines submitFeedback')
assert(html.includes('/feedback'), 'html posts feedback to review server')
assert(!html.includes('Export feedback'), 'html no longer asks for manual export download')
assert(html.includes('function updateComment'), 'html defines updateComment')
assert(!/function updateComment\([^)]*\)\s*\{[^}]*\brender\(\)/s.test(html), 'updateComment does not full-render (keeps textarea open while typing)')
assert(html.includes('paintCardChrome'), 'html updates card chrome in place while commenting')
assert(html.includes('openIds'), 'html preserves open card state across full renders')
assert(!html.includes('harness_e2e'), 'rendered review html does not ship e2e automation')

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
assert(!finalize.stdout.includes('registered project'), 'non-git finalize skips project registration')
assert(!finalize.stdout.includes('pinned integration branch'), 'non-git finalize skips integration-branch pin')
assert(!existsSync(join(tmp, '.harness', 'projects.json')), 'non-git finalize writes no registry')

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

// Finalize inside a git repo registers the project and pins the integration branch
function git(dir, args) {
  return spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
}

function seedConfirmedDraft(projectDir) {
  const dir = join(projectDir, '.harness')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'project_specs.draft.json'), `${JSON.stringify(draft, null, 2)}\n`)
  writeFileSync(join(dir, 'spec-review-feedback.json'), `${JSON.stringify({
    revision: 1,
    items: [
      { id: 'project_goal', confirmed: true, comment: '' },
      { id: 'AC-001', confirmed: true, comment: '' },
    ],
  }, null, 2)}\n`)
}

const gitTmp = mkdtempSync(join(tmpdir(), 'spec-review-git-'))
git(gitTmp, ['init', '-b', 'main'])
git(gitTmp, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'])
mkdirSync(join(gitTmp, '.harness'), { recursive: true })
writeFileSync(join(gitTmp, '.harness', 'projects.json'), `${JSON.stringify({
  projects: [{ id: 'frontend', path: 'apps/frontend', description: 'Customer web application' }],
  note: 'keep me',
}, null, 2)}\n`)
const gitProject = join(gitTmp, 'apps', 'web')
seedConfirmedDraft(gitProject)
const gitFinalize = run(['finalize', gitProject])
assert(gitFinalize.status === 0, `git finalize succeeds\n${gitFinalize.stderr}`)
assert(existsSync(join(gitProject, 'project_specs.xml')), 'git finalize writes project_specs.xml')
const registry = JSON.parse(readFileSync(join(gitTmp, '.harness', 'projects.json'), 'utf8'))
assert(registry.note === 'keep me', 'registry preserves unknown fields')
assert(registry.projects.some((p) => p.id === 'frontend' && p.description === 'Customer web application'), 'registry preserves existing entries')
assert(registry.projects.some((p) => p.id === 'apps_web' && p.path === 'apps/web'), 'registry upserts finalized project entry')
assert(gitFinalize.stdout.includes('registered project apps_web'), 'finalize prints registration')
const pin = readFileSync(join(gitTmp, '.harness', 'integration-branch'), 'utf8')
assert(pin === 'plan/demo\n', `integration-branch pin written, got ${JSON.stringify(pin)}`)
assert(git(gitTmp, ['rev-parse', '--verify', 'refs/heads/plan/demo']).status === 0, 'plan/demo branch created at HEAD')
assert(gitFinalize.stdout.includes('pinned integration branch plan/demo'), 'finalize prints pin')

const badRegistryTmp = mkdtempSync(join(tmpdir(), 'spec-review-bad-registry-'))
git(badRegistryTmp, ['init', '-b', 'main'])
git(badRegistryTmp, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'])
mkdirSync(join(badRegistryTmp, '.harness'), { recursive: true })
writeFileSync(join(badRegistryTmp, '.harness', 'projects.json'), 'not-json\n')
seedConfirmedDraft(badRegistryTmp)
const badRegistryFinalize = run(['finalize', badRegistryTmp])
assert(badRegistryFinalize.status !== 0, 'finalize fails when registry write fails')
assert(badRegistryFinalize.stderr.includes('registry or integration pin failed'), 'finalize reports registry failure')
assert(existsSync(join(badRegistryTmp, '.harness', 'project_specs.draft.json')), 'draft kept when registry fails')
assert(!existsSync(join(badRegistryTmp, 'project_specs.xml')), 'project_specs.xml not written when registry fails')

const pinnedTmp = mkdtempSync(join(tmpdir(), 'spec-review-pinned-'))
git(pinnedTmp, ['init', '-b', 'main'])
git(pinnedTmp, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'])
mkdirSync(join(pinnedTmp, '.harness'), { recursive: true })
writeFileSync(join(pinnedTmp, '.harness', 'integration-branch'), 'integration\n')
seedConfirmedDraft(pinnedTmp)
const pinnedFinalize = run(['finalize', pinnedTmp])
assert(pinnedFinalize.status === 0, `pinned finalize succeeds\n${pinnedFinalize.stderr}`)
assert(readFileSync(join(pinnedTmp, '.harness', 'integration-branch'), 'utf8') === 'integration\n', 'existing pin left untouched')
assert(!pinnedFinalize.stdout.includes('pinned integration branch'), 'finalize does not re-pin')
const rootRegistry = JSON.parse(readFileSync(join(pinnedTmp, '.harness', 'projects.json'), 'utf8'))
assert(rootRegistry.projects.some((p) => p.id === 'root' && p.path === ''), 'git-root finalize registers root project')

// Localhost submit: open blocks until POST /feedback, then exits with status code
const openTmp = mkdtempSync(join(tmpdir(), 'spec-review-open-'))
const openHarness = join(openTmp, '.harness')
mkdirSync(openHarness, { recursive: true })
writeFileSync(join(openHarness, 'project_specs.draft.json'), `${JSON.stringify(draft, null, 2)}\n`)
const child = spawn('node', [script, 'open', openTmp, '--no-browser', '--timeout-ms', '20000'], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (c) => { out += c })
const origin = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`no origin from open\n${out}`)), 5000)
  const check = () => {
    const m = out.match(/http:\/\/127\.0\.0\.1:\d+/)
    if (m) {
      clearTimeout(t)
      resolve(m[0])
    }
  }
  child.stdout.on('data', check)
  check()
})
const servedHtml = readFileSync(join(openHarness, 'spec-review.html'), 'utf8')
const token = servedHtml.match(/const REVIEW_TOKEN = "([^"]+)";/)?.[1]
assert(token, 'open writes a review session token into served html')
assert(!servedHtml.includes('harness_e2e'), 'open review html does not ship e2e automation by default')
const rejectedPost = await fetch(`${origin}/feedback`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'https://example.invalid' },
  body: JSON.stringify({
    revision: 1,
    items: [
      { id: 'project_goal', confirmed: true, comment: '' },
      { id: 'AC-001', confirmed: true, comment: '' },
    ],
  }),
})
assert(rejectedPost.status === 403, 'POST /feedback rejects missing review token')
const post = await fetch(`${origin}/feedback`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-harness-review-token': token },
  body: JSON.stringify({
    revision: 1,
    items: [
      { id: 'project_goal', confirmed: true, comment: '' },
      { id: 'AC-001', confirmed: true, comment: '' },
    ],
  }),
})
assert(post.ok, 'POST /feedback succeeds')
const code = await new Promise((resolve) => child.on('exit', resolve))
assert(code === 0, `open exits 0 after confirmed submit, got ${code}`)
assert(existsSync(join(openHarness, 'spec-review-feedback.json')), 'feedback file written by submit')
try { unlinkSync(join(openHarness, 'spec-review-feedback.json')) } catch {}

console.log('ok - spec review render, status, finalize, and localhost submit')
