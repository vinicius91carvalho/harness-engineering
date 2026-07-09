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
  listTabPanes,
} from '../skills/supervisor/lib/herdr-spawn.mjs'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const tmp = mkdtempSync(join(tmpdir(), 'herdr-spawn-test-'))
const bin = join(tmp, 'bin')
const log = join(tmp, 'herdr.log')
const stateFile = join(tmp, 'herdr-state.json')
mkdirSync(bin, { recursive: true })

function seedState(state) {
  writeFileSync(stateFile, JSON.stringify(state))
}

function resetLog() {
  writeFileSync(log, '')
}

const baseTab = { tab_id: '1-1', label: '1', pane_count: 1, workspace_id: '1', number: 1 }
const basePane = { pane_id: '1-1', tab_id: '1-1', workspace_id: '1', focused: true, agent_status: 'unknown' }

seedState({ tabs: [baseTab], panes: [basePane], seq: 0 })

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

// --- resolveDisplayMode ---------------------------------------------------

assert(resolveDisplayMode({}) === 'herdr', 'HERDR_ENV=1 with herdr on PATH auto-selects herdr panes')
assert(resolveDisplayMode({ display: 'herdr' }) === 'herdr', '--display herdr opts into pane spawning when herdr is on PATH')
assert(resolveDisplayMode({ display: 'background' }) === 'background', '--display background always forces background, even with HERDR_ENV=1')

process.env.HARNESS_DISPLAY = 'background'
assert(resolveDisplayMode({}) === 'background', 'HARNESS_DISPLAY=background forces background, even with HERDR_ENV=1')
delete process.env.HARNESS_DISPLAY

process.env.HARNESS_DISPLAY = 'herdr'
assert(resolveDisplayMode({}) === 'herdr', 'HARNESS_DISPLAY=herdr forces herdr when available')
delete process.env.HARNESS_DISPLAY

{
  const withoutHerdr = process.env.PATH
  process.env.PATH = '/usr/bin:/bin'
  assert(resolveDisplayMode({}) === 'background', 'auto herdr requires herdr on PATH even with HERDR_ENV=1')
  assert(resolveDisplayMode({ display: 'herdr' }) === 'background', 'explicit --display herdr falls back to background when herdr is missing')
  assert(resolveDisplayMode({ display: 'background' }) === 'background', '--display background is unaffected by herdr availability')
  process.env.PATH = withoutHerdr
}

{
  const withoutHerdrEnv = process.env.HERDR_ENV
  delete process.env.HERDR_ENV
  assert(resolveDisplayMode({}) === 'background', 'no auto herdr outside a herdr workspace (HERDR_ENV unset)')
  process.env.HERDR_ENV = withoutHerdrEnv
}

// --- tab labeling ----------------------------------------------------------

assert(nextHarnessWorkerTabLabel([]) === 'harness-workers', 'first harness tab label')
assert(nextHarnessWorkerTabLabel([{ label: 'harness-workers' }]) === 'harness-workers-2', 'second harness tab label')

// --- pane waiting / BUSY gating (no regressions) ---------------------------

assert(detectPaneWaiting('BUSY\nBUSY\nBUSY\nBUSY\nBUSY\nBUSY\nBUSY\nBUSY', 'unknown') === null, 'merge lock busy spam is normal orchestrator wait')
assert(detectPaneWaiting('', 'idle') === null, 'herdr idle is not a supervisor stop condition')
assert(detectPaneWaiting('coding...', 'unknown') === null, 'active output is not waiting')
assert(detectPaneWaiting('', 'blocked')?.kind === 'blocked', 'herdr blocked means human input')

// --- resolveHarnessWorkerTab creates a fresh tab ----------------------------

const firstTab = resolveHarnessWorkerTab('1')
assert(firstTab.tabId === '1-2', 'creates harness-workers tab when none exist')
assert(firstTab.created === true, 'first harness tab is newly created')
assert(firstTab.rootPaneId === '1-r2', 'tab create exposes root pane for first worker')

// --- spawnAgent overflows to a new tab when the current one is full --------

seedState({
  tabs: [
    baseTab,
    { tab_id: '1-2', label: 'harness-workers', pane_count: 4, workspace_id: '1', number: 2 },
  ],
  panes: [basePane, { pane_id: '1-r2', tab_id: '1-2', workspace_id: '1', agent_status: 'working' }],
  seq: 0,
})
resetLog()

const { paneId, tabId } = spawnAgent('worker-core-test', ['node', '-e', 'console.log(1)'], { cwd: '/tmp/worktree' })
assert(tabId === '1-3', 'spawn opens overflow harness tab when current tab is full')
assert(paneId === '1-r3', 'first worker on a new tab reuses root pane via pane run')
assert(getPaneAgentStatus(paneId) === 'working', 'getPaneAgentStatus reads pane state')
assert(paneExists(paneId) === true, 'paneExists is true for live pane')
assert(getPaneAgentStatus('1-9') === 'gone', 'missing pane reports gone')
assert(readPaneTail(paneId).includes('worker output'), 'readPaneTail returns pane text')

const overflowLog = spawnSync('cat', [log], { encoding: 'utf8', env }).stdout
assert(overflowLog.includes('1-r3'), 'first worker on new tab runs in root pane via pane run')
assert(overflowLog.includes('harness: worker-core-test starting'), 'pane run prints harness start banner')
assert(overflowLog.includes('PATH='), 'pane run forwards supervisor PATH into the worker pane')
assert(overflowLog.includes('HARNESS_HERDR_PANE=') && overflowLog.includes('HARNESS_DISPLAY='), 'pane run injects herdr display env')

closePane(paneId)

// --- each worker gets its own unique, dedicated pane -----------------------

const sharedTabId = '1-4'
seedState({
  tabs: [
    baseTab,
    { tab_id: sharedTabId, label: 'harness-workers-3', pane_count: 1, workspace_id: '1', number: 4 },
  ],
  panes: [basePane, { pane_id: `${sharedTabId}-r1`, tab_id: sharedTabId, workspace_id: '1', agent_status: 'working' }],
  seq: 10,
})
resetLog()

const workerA = spawnAgent('worker-a', ['node', '-e', 'console.log(1)'], { cwd: '/tmp/worktree' })
const workerB = spawnAgent('worker-b', ['node', '-e', 'console.log(2)'], { cwd: '/tmp/worktree' })
assert(workerA.tabId === sharedTabId && workerB.tabId === sharedTabId, 'both workers land on the same not-yet-full tab')
assert(workerA.paneId !== workerB.paneId, 'spawnAgent twice creates two different paneIds')
assert(workerA.paneId !== `${sharedTabId}-r1` && workerB.paneId !== `${sharedTabId}-r1`, 'new workers never reuse an existing worker pane')

const panesAfterTwoWorkers = listTabPanes(sharedTabId).map((pane) => pane.pane_id)
assert(panesAfterTwoWorkers.includes(workerA.paneId), 'worker A pane is still present')
assert(panesAfterTwoWorkers.includes(workerB.paneId), 'worker B pane is still present')
assert(new Set(panesAfterTwoWorkers).size === panesAfterTwoWorkers.length, 'no duplicate/shared panes on the tab')

const sharedLog = spawnSync('cat', [log], { encoding: 'utf8', env }).stdout
assert(sharedLog.includes('harness: worker-a starting'), 'worker A gets its own start banner')
assert(sharedLog.includes('harness: worker-b starting'), 'worker B gets its own start banner')

// --- dangling shells are closed, never reclaimed for a new worker ----------

const danglingTabId = '1-5'
const danglingRoot = `${danglingTabId}-r1`
const danglingExtra = `${danglingTabId}-extra`
seedState({
  tabs: [
    baseTab,
    { tab_id: danglingTabId, label: 'harness-workers-4', pane_count: 2, workspace_id: '1', number: 5 },
  ],
  panes: [
    basePane,
    { pane_id: danglingRoot, tab_id: danglingTabId, workspace_id: '1', agent_status: 'working' },
    { pane_id: danglingExtra, tab_id: danglingTabId, workspace_id: '1', agent_status: 'idle' },
  ],
  seq: 20,
})
resetLog()

const workerC = spawnAgent('worker-dangling-cleanup', ['node', '-e', 'console.log(3)'], { cwd: '/tmp/worktree' })
const remaining = listTabPanes(workerC.tabId).map((pane) => pane.pane_id)
assert(!remaining.includes(danglingExtra), 'dangling shell pane is closed before a new worker pane is split')
assert(remaining.includes(danglingRoot), 'existing worker pane is preserved, never treated as dangling')
assert(
  remaining.includes(workerC.paneId) && workerC.paneId !== danglingRoot && workerC.paneId !== danglingExtra,
  'new worker gets its own unique pane, never a reclaimed dangling shell',
)

// --- legacy spawnInPane still works -----------------------------------------

const { paneId: legacyPane } = spawnInPane('node -e "console.log(1)"', 'worker-legacy')
assert(typeof legacyPane === 'string' && legacyPane.length > 0, 'spawnInPane still works for legacy callers')

console.log('ok - herdr spawn helpers auto-select herdr, resolve tab capacity, and give every worker a unique pane')
