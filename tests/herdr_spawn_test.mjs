#!/usr/bin/env node
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  resolveDisplayMode,
  shellQuote,
  spawnAgent,
  spawnInPane,
  closePane,
  getPaneAgentStatus,
  isPaneDone,
  paneExists,
  readPaneTail,
  resolveHarnessWorkerTab,
  nextHarnessWorkerTabLabel,
  detectPaneWaiting,
  reportHarnessAgent,
  closeDanglingShellPanes,
} from '../skills/supervisor/lib/herdr-spawn.mjs'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const tmp = mkdtempSync(join(tmpdir(), 'herdr-spawn-test-'))
const bin = join(tmp, 'bin')
const log = join(tmp, 'herdr.log')
const stateFile = join(tmp, 'herdr-state.json')
mkdirSync(bin, { recursive: true })
writeFileSync(stateFile, JSON.stringify({
  tabs: [{ tab_id: '1-1', label: '1', pane_count: 1, workspace_id: '1', number: 1 }],
}))

copyFileSync(join(fixtures, 'herdr-mock.sh'), join(bin, 'herdr'))
copyFileSync(join(fixtures, 'herdr-mock-helper.mjs'), join(tmp, 'herdr-mock-helper.mjs'))
chmodSync(join(bin, 'herdr'), 0o755)

const env = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  HARNESS_TEST_HERDR_LOG: log,
  HARNESS_TEST_HERDR_STATE: stateFile,
  HARNESS_TEST_HERDR_HELPER: join(tmp, 'herdr-mock-helper.mjs'),
  HERDR_ENV: '1',
  HARNESS_HERDR_MAX_PANES_PER_TAB: '4',
}
process.env.PATH = env.PATH
process.env.HERDR_ENV = '1'
process.env.HARNESS_TEST_HERDR_LOG = log
process.env.HARNESS_TEST_HERDR_STATE = stateFile
process.env.HARNESS_TEST_HERDR_HELPER = env.HARNESS_TEST_HERDR_HELPER
process.env.HARNESS_HERDR_MAX_PANES_PER_TAB = '4'

function assert(condition, message) {
  if (!condition) {
    console.error(`not ok - ${message}`)
    process.exit(1)
  }
}

assert(resolveDisplayMode({}) === 'background', 'default display is background even inside herdr')
assert(resolveDisplayMode({ display: 'herdr' }) === 'herdr', '--display herdr opts into pane spawning when herdr is on PATH')

assert(nextHarnessWorkerTabLabel([]) === 'harness-workers', 'first harness tab label')
assert(nextHarnessWorkerTabLabel([{ label: 'harness-workers' }]) === 'harness-workers-2', 'second harness tab label')

assert(detectPaneWaiting('BUSY\nBUSY\nBUSY\nBUSY\nBUSY\nBUSY\nBUSY\nBUSY', 'unknown') === null, 'merge lock busy spam is normal orchestrator wait')
assert(detectPaneWaiting('', 'idle') === null, 'herdr idle is not a supervisor stop condition')
assert(detectPaneWaiting('coding...', 'unknown') === null, 'active output is not waiting')
assert(detectPaneWaiting('', 'blocked')?.kind === 'blocked', 'herdr blocked means human input')

const firstTab = resolveHarnessWorkerTab('1')
assert(firstTab.tabId === '1-2', 'creates harness-workers tab when none exist')
assert(firstTab.created === true, 'first harness tab is newly created')
assert(firstTab.rootPaneId === '1-r2', 'tab create exposes root pane for first worker')

writeFileSync(stateFile, JSON.stringify({
  tabs: [
    { tab_id: '1-1', label: '1', pane_count: 1, workspace_id: '1', number: 1 },
    { tab_id: '1-2', label: 'harness-workers', pane_count: 4, workspace_id: '1', number: 2 },
  ],
}))
writeFileSync(log, '')

const { paneId, tabId } = spawnAgent('worker-core-test', ['node', '-e', 'console.log(1)'], { cwd: '/tmp/worktree' })
assert(tabId === '1-3', 'spawn opens overflow harness tab when current tab is full')
assert(paneId === '1-r3', 'first worker on a new tab reuses root pane via pane run')
assert(getPaneAgentStatus(paneId) === 'working', 'getPaneAgentStatus reads pane state')
assert(paneExists(paneId) === true, 'paneExists is true for live pane')
assert(getPaneAgentStatus('1-9') === 'gone', 'missing pane reports gone')
assert(readPaneTail(paneId).includes('worker output'), 'readPaneTail returns pane text')
closePane(paneId)

const { paneId: legacyPane } = spawnInPane('node -e "console.log(1)"', 'worker-legacy')
assert(legacyPane === '1-4', 'spawnInPane still works for legacy callers')

const recorded = spawnSync('cat', [log], { encoding: 'utf8', env }).stdout
assert(recorded.includes('1-r3'), 'first worker on new tab runs in root pane via pane run')
assert(recorded.includes('harness: worker-core-test starting'), 'pane run prints harness start banner')

console.log('ok - herdr spawn helpers resolve display mode, tab capacity, and agent start')
