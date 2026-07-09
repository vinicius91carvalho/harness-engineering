import { mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { spawnSync } from 'node:child_process'

const HARNESS_TAB_PREFIX = 'harness-workers'

function commandExists(cmd) {
  return spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0
}

/** Resolve worker display mode. Herdr panes are opt-in via --display herdr or HARNESS_DISPLAY=herdr. */
export function resolveDisplayMode(options = {}) {
  const explicit = options.display || process.env.HARNESS_DISPLAY
  if (explicit === 'background') return 'background'
  if (explicit === 'herdr') return commandExists('herdr') ? 'herdr' : 'background'
  return 'background'
}

function herdr(args) {
  const result = spawnSync('herdr', args, { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `herdr ${args.join(' ')} failed`).trim())
  }
  return result.stdout
}

function readMaxPanesPerTab() {
  const value = Number(process.env.HARNESS_HERDR_MAX_PANES_PER_TAB || 4)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 4
}

function withHerdrLayoutLock(lockDir, fn) {
  if (!lockDir) return fn()
  mkdirSync(dirname(lockDir), { recursive: true })
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockDir)
      try {
        return fn()
      } finally {
        try { rmSync(lockDir, { recursive: true }) } catch {}
      }
    } catch {
      spawnSync('sleep', ['0.05'])
    }
  }
  throw new Error('timed out waiting for herdr layout lock')
}

export function getFocusedWorkspaceId() {
  const parsed = JSON.parse(herdr(['pane', 'list']))
  const panes = parsed.result?.panes || []
  const focused = panes.find((pane) => pane.focused) || panes[0]
  if (!focused?.workspace_id) throw new Error('no focused herdr workspace')
  return focused.workspace_id
}

export function getFocusedPaneId() {
  const parsed = JSON.parse(herdr(['pane', 'list']))
  const panes = parsed.result?.panes || []
  const focused = panes.find((pane) => pane.focused) || panes[0]
  if (!focused?.pane_id) throw new Error('no focused herdr pane')
  return focused.pane_id
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

export function listHarnessWorkerTabs(workspaceId, tabPrefix = HARNESS_TAB_PREFIX) {
  const tabs = JSON.parse(herdr(['tab', 'list', '--workspace', workspaceId])).result?.tabs || []
  return tabs
    .filter((tab) => String(tab.label || '').startsWith(tabPrefix))
    .sort((a, b) => (a.number || 0) - (b.number || 0))
}

export function nextHarnessWorkerTabLabel(existingTabs, tabPrefix = HARNESS_TAB_PREFIX) {
  if (!existingTabs.length) return tabPrefix
  return `${tabPrefix}-${existingTabs.length + 1}`
}

/** Pick or create a harness-workers tab with fewer than maxPanesPerTab panes. */
export function resolveHarnessWorkerTab(workspaceId, { maxPanes = readMaxPanesPerTab(), tabPrefix = HARNESS_TAB_PREFIX } = {}) {
  const harnessTabs = listHarnessWorkerTabs(workspaceId, tabPrefix)
  for (const tab of harnessTabs) {
    if ((tab.pane_count ?? 0) < maxPanes) {
      return { tabId: tab.tab_id, created: false }
    }
  }
  const label = nextHarnessWorkerTabLabel(harnessTabs, tabPrefix)
  const created = JSON.parse(herdr(['tab', 'create', '--workspace', workspaceId, '--label', label, '--no-focus']))
  const tabId = created.result?.tab?.tab_id
  const rootPaneId = created.result?.root_pane?.pane_id
  if (!tabId) throw new Error('herdr tab create did not return tab_id')
  return { tabId, rootPaneId, created: true }
}

export function listTabPanes(tabId) {
  const parsed = JSON.parse(herdr(['pane', 'list']))
  return (parsed.result?.panes || []).filter((pane) => pane.tab_id === tabId)
}

function isDanglingShell(pane) {
  if (pane.agent || pane.label) return false
  return !pane.agent_status || ['unknown', 'idle'].includes(pane.agent_status)
}

/** Tab create and agent start both leave idle shells. Drop orphans. */
export function closeDanglingShellPanes(tabId, keepPaneIds = null) {
  const keep = keepPaneIds == null
    ? null
    : keepPaneIds instanceof Set
      ? keepPaneIds
      : new Set([keepPaneIds].filter(Boolean))
  for (const pane of listTabPanes(tabId)) {
    if (keep?.has(pane.pane_id)) continue
    if (!isDanglingShell(pane)) continue
    closePane(pane.pane_id)
  }
}

function pickWorkerPane(tabId) {
  const panes = listTabPanes(tabId)
  for (const pane of panes) {
    if (isDanglingShell(pane)) return pane.pane_id
  }
  const workers = panes.filter((pane) => pane.agent || pane.label)
  const source = workers[workers.length - 1]?.pane_id || panes[0]?.pane_id
  if (!source) throw new Error(`no pane available in tab ${tabId}`)
  const splitOut = JSON.parse(herdr(['pane', 'split', source, '--direction', 'right', '--no-focus']))
  const paneId = splitOut.result?.pane?.pane_id
  if (!paneId) throw new Error('herdr pane split did not return pane_id')
  return paneId
}

function argvToCommand(commandArgv, { cwd, env = {} } = {}) {
  const envPrefix = Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(' ')
  const cmd = commandArgv.map(shellQuote).join(' ')
  const body = envPrefix ? `${envPrefix} ${cmd}` : cmd
  return cwd ? `cd ${shellQuote(cwd)} && ${body}` : body
}

export function paneExists(paneId) {
  try {
    const parsed = JSON.parse(herdr(['pane', 'get', paneId]))
    return Boolean(parsed.result?.pane?.pane_id)
  } catch {
    return false
  }
}

const HARNESS_PANE_ENV = { HARNESS_DISPLAY: 'herdr', HARNESS_HERDR_PANE: '1' }

/** Start a named harness worker in herdr — one pane per worker via pane run (never agent start split). */
export function spawnAgent(name, commandArgv, { cwd, layoutLockDir } = {}) {
  return withHerdrLayoutLock(layoutLockDir, () => {
    const workspaceId = getFocusedWorkspaceId()
    const tab = resolveHarnessWorkerTab(workspaceId)
    const paneId = tab.created && tab.rootPaneId ? tab.rootPaneId : pickWorkerPane(tab.tabId)
    const command = argvToCommand(commandArgv, { cwd, env: HARNESS_PANE_ENV })
    const wrapped = `printf '%s\\n' 'harness: ${name} starting' >&2; ${command}`
    herdr(['pane', 'run', paneId, wrapped])
    closeDanglingShellPanes(tab.tabId, new Set([paneId]))
    reportHarnessAgent(paneId, name, 'working', 'starting')
    return { paneId, tabId: tab.tabId, label: name }
  })
}

/** @deprecated Prefer spawnAgent — plain pane split/run is not listed in herdr's agent sidebar. */
export function spawnInPane(command, label, splitFrom = null) {
  const source = splitFrom || getFocusedPaneId()
  const splitOut = JSON.parse(herdr(['pane', 'split', source, '--direction', 'right', '--no-focus']))
  const paneId = splitOut.result?.pane?.pane_id
  if (!paneId) throw new Error('herdr pane split did not return pane_id')
  herdr(['pane', 'run', paneId, command])
  return { paneId, label }
}

export function closePane(paneId) {
  try { herdr(['pane', 'close', paneId]) } catch {}
}

export function getPaneAgentStatus(paneId) {
  if (!paneExists(paneId)) return 'gone'
  try {
    const parsed = JSON.parse(herdr(['pane', 'get', paneId]))
    return parsed.result?.pane?.agent_status || 'unknown'
  } catch {
    return 'gone'
  }
}

export function isPaneDone(paneId) {
  const status = getPaneAgentStatus(paneId)
  return status === 'gone'
}

export function isPaneBlocked(paneId) {
  return getPaneAgentStatus(paneId) === 'blocked'
}

export function readPaneTail(paneId, lines = 80) {
  if (!paneExists(paneId)) return ''
  const result = spawnSync('herdr', ['pane', 'read', paneId, '--source', 'recent-unwrapped', '--lines', String(lines)], { encoding: 'utf8' })
  return result.stdout || ''
}

const reportSeqByPane = new Map()

export function detectPaneWaiting(tail = '', paneStatus = 'unknown') {
  if (paneStatus === 'blocked') {
    return { kind: 'blocked', reason: 'Agent needs input, approval, or a decision' }
  }
  const lower = tail.toLowerCase()
  if (/\b(input required|press enter|choose an option|y\/n)\b/.test(lower)) {
    return { kind: 'prompt', reason: 'Agent appears to be waiting for interactive input' }
  }
  return null
}

export function reportHarnessAgent(paneId, agentName, state, message = '') {
  if (!agentName || !paneExists(paneId)) return
  const seq = (reportSeqByPane.get(paneId) || 0) + 1
  reportSeqByPane.set(paneId, seq)
  const args = [
    'pane', 'report-agent', paneId,
    '--source', `harness:${agentName}`,
    '--agent', agentName,
    '--state', state,
    '--seq', String(seq),
  ]
  if (message) args.push('--message', message)
  spawnSync('herdr', args, { stdio: 'ignore' })
}

/** Close every dangling shell on harness-worker tabs (one-shot layout cleanup). */
export function closeAllDanglingHarnessShells(workspaceId) {
  for (const tab of listHarnessWorkerTabs(workspaceId)) closeDanglingShellPanes(tab.tab_id)
}
