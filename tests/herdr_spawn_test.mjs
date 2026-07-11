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
  closeWorkerDisplay,
  getPaneAgentStatus,
  paneExists,
  readPaneTail,
  resolveHarnessWorkerTab,
  nextHarnessWorkerTabLabel,
  buildWorkerTabLabel,
  roleFromPhase,
  renameWorkerTab,
  detectPaneWaiting,
  detectPaneOrchestratorExited,
  detectPaneMergeLockWait,
  paneShowsIdleShell,
  closeStaleHarnessPanesForProject,
  listTabPanes,
  listHarnessWorkerTabs,
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
}
process.env.PATH = env.PATH
process.env.HERDR_ENV = '1'
process.env.HARNESS_TEST_HERDR_LOG = log
process.env.HARNESS_TEST_HERDR_STATE = stateFile
process.env.HARNESS_TEST_HERDR_HELPER = env.HARNESS_TEST_HERDR_HELPER

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

assert(nextHarnessWorkerTabLabel([]) === 'harness-workers', 'legacy first harness tab label')
assert(nextHarnessWorkerTabLabel([{ label: 'harness-workers' }]) === 'harness-workers-2', 'legacy second harness tab label')
assert(buildWorkerTabLabel({ taskId: 'WI-AC-025', role: 'qa', project: 'public-docs', retry: 1 }) === 'WI-AC-025 - qa - public-docs - r1', 'named worker tab label')
assert(roleFromPhase('INTEGRATION_QA') === 'integration-qa', 'phase maps to role')
assert(roleFromPhase('coding') === 'code', 'coding maps to code')
assert(roleFromPhase('unknown') === 'orchestrator', 'unknown phase defaults to orchestrator')

// --- pane waiting / BUSY gating (no regressions) ---------------------------

assert(detectPaneWaiting('BUSY\nBUSY\nBUSY\nBUSY\nBUSY\nBUSY\nBUSY\nBUSY', 'unknown') === null, 'merge lock busy spam is normal orchestrator wait')
assert(detectPaneWaiting('', 'idle') === null, 'herdr idle is not a supervisor stop condition')
assert(detectPaneWaiting('coding...', 'unknown') === null, 'active output is not waiting')
assert(detectPaneWaiting('', 'blocked')?.kind === 'blocked', 'herdr blocked means human input')
assert(detectPaneMergeLockWait('orchestrator: waiting for merge lock (another context is integrating)…') === true, 'merge lock wait is detectable')
assert(detectPaneOrchestratorExited('Session terminated, killing shell... ...killed.') === true, 'killed shell is detectable')
assert(detectPaneOrchestratorExited('Session terminated, killing shell... ...killed.\norchestrator: CODING → pi attempt 1') === false, 'restarted orchestrator after kill is not exited')
assert(detectPaneOrchestratorExited(
  '===HARNESS-VERDICT-END===\nagent: harness verdict received (id=WI-AC-046) — stopping agent\nSession terminated, killing shell...',
) === false, 'agent early-exit after verdict is not orchestrator exit')
assert(paneShowsIdleShell('…/relay  plan/opensource-docker  v24  ❯') === true, 'idle shell prompt is detectable')
assert(paneShowsIdleShell('orchestrator: goal-review complete\n…/relay  v24  ❯') === true, 'idle prompt after orchestrator history is detectable')
assert(paneShowsIdleShell('orchestrator: merge lock acquired\norchestrator: INTEGRATION_QA → pi attempt 3') === false, 'active orchestrator is not idle shell')

// --- each spawn gets its own named tab -------------------------------------

seedState({ tabs: [baseTab], panes: [basePane], seq: 0 })
resetLog()

const first = spawnAgent('worker-public-docs-invariants', ['node', '-e', 'console.log(1)'], {
  cwd: '/tmp/worktree',
  taskId: 'WI-AC-025',
  role: 'qa',
  project: 'public-docs',
  retry: 2,
})
assert(first.tabLabel === 'WI-AC-025 - qa - public-docs - r2', 'spawnAgent uses named tab label')
assert(first.paneId === '1-r2', 'worker reuses the new tab root pane')
assert(getPaneAgentStatus(first.paneId) === 'working', 'getPaneAgentStatus reads pane state')
assert(paneExists(first.paneId) === true, 'paneExists is true for live pane')
assert(readPaneTail(first.paneId).includes('worker output'), 'readPaneTail returns pane text')

const firstLog = spawnSync('cat', [log], { encoding: 'utf8', env }).stdout
assert(firstLog.includes('1-r2'), 'worker runs in dedicated tab root pane')
assert(firstLog.includes('PATH='), 'pane run forwards supervisor PATH into the worker pane')
assert(firstLog.includes('HARNESS_HERDR_PANE=') && firstLog.includes('HARNESS_DISPLAY='), 'pane run injects herdr display env')

const second = spawnAgent('worker-core-foundation', ['node', '-e', 'console.log(2)'], {
  cwd: '/tmp/worktree',
  taskId: 'WI-AC-001',
  role: 'code',
  project: 'core',
  retry: 1,
})
assert(second.tabId !== first.tabId, 'second worker gets a different tab')
assert(second.paneId !== first.paneId, 'second worker gets a different pane')
assert(second.tabLabel === 'WI-AC-001 - code - core - r1', 'second worker has its own label')

renameWorkerTab(first.tabId, 'WI-AC-025 - merge - public-docs - r2')
const renamed = listHarnessWorkerTabs('1').find((tab) => tab.tab_id === first.tabId)
assert(renamed?.label === 'WI-AC-025 - merge - public-docs - r2', 'renameWorkerTab updates label')

closeWorkerDisplay(first.paneId, first.tabId)
assert(!listTabPanes(first.tabId).length, 'closeWorkerDisplay removes panes on the tab')
assert(!listHarnessWorkerTabs('1').some((tab) => tab.tab_id === first.tabId), 'closeWorkerDisplay closes the tab')

// --- resolveHarnessWorkerTab still creates a dedicated tab -----------------

seedState({ tabs: [baseTab], panes: [basePane], seq: 0 })
const resolved = resolveHarnessWorkerTab('1')
assert(resolved.created === true, 'resolveHarnessWorkerTab creates a tab')
assert(resolved.rootPaneId, 'resolveHarnessWorkerTab exposes root pane')

// --- monorepo: pane cleanup is scoped per subproject -----------------------

const sharedHarnessTab = '1-6'
seedState({
  tabs: [
    baseTab,
    { tab_id: sharedHarnessTab, label: 'WI-AC-010 - code - core - r1', pane_count: 4, workspace_id: '1', number: 6 },
  ],
  panes: [
    basePane,
    { pane_id: '1-6-core-live', tab_id: sharedHarnessTab, workspace_id: '1', agent: 'worker-core-live', agent_status: 'working' },
    { pane_id: '1-6-core-done', tab_id: sharedHarnessTab, workspace_id: '1', agent: 'worker-core-done', agent_status: 'idle' },
    { pane_id: '1-6-relay-done', tab_id: sharedHarnessTab, workspace_id: '1', agent: 'worker-relay-done', agent_status: 'idle' },
  ],
  seq: 30,
})

closeStaleHarnessPanesForProject(sharedHarnessTab, 'core', new Set(['1-6-core-live']))
const afterScopedClose = listTabPanes(sharedHarnessTab).map((pane) => pane.pane_id)
assert(afterScopedClose.includes('1-6-core-live'), 'active core worker pane is kept')
assert(!afterScopedClose.includes('1-6-core-done'), 'finished core worker pane is closed')
assert(afterScopedClose.includes('1-6-relay-done'), 'sibling subproject relay pane is never closed by core supervisor')

seedState({
  tabs: [
    baseTab,
    { tab_id: sharedHarnessTab, label: 'WI-AC-020 - code - relay - r1', pane_count: 1, workspace_id: '1', number: 6 },
  ],
  panes: [
    basePane,
    { pane_id: '1-6-relay-stale', tab_id: sharedHarnessTab, workspace_id: '1', agent: 'worker-relay-stale', agent_status: 'working' },
  ],
  pane_tails: { '1-6-relay-stale': '…/relay  plan/opensource-docker  v24  ❯' },
  seq: 40,
})
closeStaleHarnessPanesForProject(sharedHarnessTab, 'relay', new Set())
assert(!listTabPanes(sharedHarnessTab).some((pane) => pane.pane_id === '1-6-relay-stale'), 'untracked idle relay pane is closed on supervisor tick')
assert(!listHarnessWorkerTabs('1').some((tab) => tab.tab_id === sharedHarnessTab), 'empty worker tab is closed after cleanup')

// --- legacy spawnInPane still works -----------------------------------------

const { paneId: legacyPane } = spawnInPane('node -e "console.log(1)"', 'worker-legacy')
assert(typeof legacyPane === 'string' && legacyPane.length > 0, 'spawnInPane still works for legacy callers')
assert(shellQuote("a'b") === `'a'\\''b'`, 'shellQuote escapes single quotes')

console.log('ok - herdr spawn helpers use one named tab per worker')
