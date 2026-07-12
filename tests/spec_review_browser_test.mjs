#!/usr/bin/env node
/**
 * Browser E2E for spec-review:
 * - comment typing must not collapse the open card
 * - Submit and continue POSTs feedback to `open` localhost server
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const root = dirname(fileURLToPath(import.meta.url))
const script = join(root, '..', 'skills', 'planner', 'spec-review.mjs')

function assert(condition, message) {
  if (!condition) {
    console.error(`not ok - ${message}`)
    process.exit(1)
  }
}

function findChromium() {
  for (const candidate of [
    process.env.CHROMIUM_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ]) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

const chromiumPath = findChromium()
assert(chromiumPath, 'chromium/chrome binary required for spec-review browser E2E')

const tmp = mkdtempSync(join(tmpdir(), 'spec-review-browser-'))
const harness = join(tmp, '.harness')
mkdirSync(harness, { recursive: true })

writeFileSync(join(harness, 'project_specs.draft.json'), `${JSON.stringify({
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
}, null, 2)}\n`)

// --- Part A: typing must keep card open (static render) ---
const render = spawnSync('node', [script, 'render', tmp], { encoding: 'utf8' })
assert(render.status === 0, `render failed: ${render.stderr}`)
const htmlPath = render.stdout.trim()
const probePath = join(tmp, 'typing-e2e.html')
writeFileSync(probePath, `${readFileSync(htmlPath, 'utf8').replace(
  '</body>',
  `<pre id="e2e-result">pending</pre>
<script>
(() => {
  const out = document.getElementById('e2e-result');
  try {
    const card = document.querySelector('.card');
    card.querySelector('.card-head').click();
    const textarea = card.querySelector('textarea');
    const text = 'needs clearer URL matrix wording';
    textarea.value = '';
    for (const ch of text) {
      textarea.value += ch;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const bodyDisplay = getComputedStyle(card.querySelector('.card-body')).display;
    if (!card.classList.contains('open')) throw new Error('card closed after typing');
    if (bodyDisplay !== 'block') throw new Error('card-body hidden: ' + bodyDisplay);
    if (textarea.value !== text) throw new Error('textarea lost text');
    if (!document.getElementById('submit-btn')) throw new Error('missing submit button');
    out.textContent = 'E2E_OK typing';
  } catch (err) {
    out.textContent = 'E2E_FAIL ' + (err && err.message ? err.message : String(err));
  }
})();
</script>
</body>`,
)}`)

const dump = spawnSync(
  chromiumPath,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--allow-file-access-from-files', '--dump-dom', pathToFileURL(probePath).href],
  { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
)
assert(dump.status === 0, `typing dump-dom failed: ${dump.stderr || dump.stdout.slice(0, 300)}`)
const typingMarker = dump.stdout.match(/id="e2e-result">(?:E2E_OK typing|E2E_FAIL [^<]*)/)
assert(typingMarker && typingMarker[0].includes('E2E_OK typing'), `typing e2e failed: ${typingMarker?.[0] || 'missing marker'}`)

// --- Part B: same-origin submit via ?harness_e2e=submit-comment ---
const child = spawn('node', [script, 'open', tmp, '--no-browser', '--timeout-ms', '45000'], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stdout = ''
let stderr = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (chunk) => { stdout += chunk })
child.stderr.on('data', (chunk) => { stderr += chunk })

const origin = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timed out waiting for origin\n${stdout}\n${stderr}`)), 10000)
  let settled = false
  const tryMatch = () => {
    const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+/)
    if (match && !settled) {
      settled = true
      clearTimeout(timer)
      resolve(match[0])
    }
  }
  child.stdout.on('data', tryMatch)
  tryMatch()
  child.on('exit', (code) => {
    if (!settled) {
      clearTimeout(timer)
      reject(new Error(`open exited early code=${code}\n${stdout}\n${stderr}`))
    }
  })
})

const submitDump = spawnSync(
  chromiumPath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--virtual-time-budget=5000',
    '--dump-dom',
    `${origin}/?harness_e2e=submit-comment`,
  ],
  { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
)
assert(submitDump.status === 0, `submit dump-dom failed: ${submitDump.stderr || submitDump.stdout.slice(0, 300)}`)
const submitMarker = submitDump.stdout.match(/id="e2e-result">(?:E2E_OK submitted|E2E_FAIL [^<]*)/)
assert(submitMarker && submitMarker[0].includes('E2E_OK submitted'), `submit e2e failed: ${submitMarker?.[0] || 'missing marker'}\n${stderr}\n${submitDump.stdout.slice(0, 500)}`)

const exitCode = await new Promise((resolve) => {
  const t = setTimeout(() => resolve(child.exitCode ?? 99), 10000)
  if (child.exitCode != null) {
    clearTimeout(t)
    return resolve(child.exitCode)
  }
  child.on('exit', (code) => {
    clearTimeout(t)
    resolve(code)
  })
})
if (child.exitCode == null && !child.killed) {
  try { child.kill('SIGTERM') } catch {}
}

assert(exitCode === 2, `open should exit 2 when comments need revision, got ${exitCode}; stderr=${stderr}`)
const feedbackPath = join(harness, 'spec-review-feedback.json')
assert(existsSync(feedbackPath), 'feedback file written by submit')
const feedback = JSON.parse(readFileSync(feedbackPath, 'utf8'))
assert(feedback.items.some((row) => String(row.comment || '').includes('needs clearer')), 'comment persisted from browser submit')

console.log(`ok - spec review browser typing+submit (${typingMarker[0]}; ${submitMarker[0]}; open exit ${exitCode})`)
