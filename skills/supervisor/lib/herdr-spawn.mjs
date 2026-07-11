import { mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { spawnSync } from 'node:child_process'

/** @deprecated Packed harness-workers tabs — kept for cleanup of legacy layouts. */
const HARNESS_TAB_PREFIX = 'harness-workers'

const ROLE_BY_PHASE = {
  coding: 'code',
  qa: 'qa',
  integration_qa: 'integration-qa',
  repair_plan: 'repair',
  merge: 'merge',
  goal_review: 'goal-review',
}

function commandExists(cmd) {
  return spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0
}

/**
 * Resolve worker display mode.
 *
 * Auto-selects herdr when running inside a herdr workspace
 * (HERDR_ENV=1) and the herdr CLI is on PATH. `--display background` /
 * HARNESS_DISPLAY=background always forces background; `--display herdr` /
 * HARNESS_DISPLAY=herdr forces herdr when available, else falls back to
 * background.
 */
export function resolveDisplayMode(options = {}) {
  const explicit = options.display || process.env.HARNESS_DISPLAY
  if (explicit === 'background') return 'background'
  if (explicit === 'herdr') return commandExists('herdr') ? 'herdr' : 'background'
  if (process.env.HERDR_ENV === '1' && commandExists('herdr')) return 'herdr'
  return 'background'
}

function herdr(args) {
  const result = spawnSync('herdr', args, { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `herdr ${args.join(' ')} failed`).trim())
  }
  return result.stdout
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

/** Map orchestrator phase / kind to a short role label for the tab name. */
export function roleFromPhase(phase) {
  const key = String(phase || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  return ROLE_BY_PHASE[key] || 'orchestrator'
}

/**
 * Tab label: `{taskId} - {role} - {project} - r{retry}`
 * Example: `WI-AC-025 - qa - public-docs - r1`
 */
export function buildWorkerTabLabel({ taskId, role, project, retry = 1 } = {}) {
  const task = String(taskId || 'task').replace(/\s+/g, '')
  const agent = String(role || 'orchestrator').replace(/\s+/g, '-')
  const proj = String(project || 'project').replace(/\s+/g, '-')
  const n = Math.max(1, Number(retry) || 1)
  return `${task} - ${agent} - ${proj} - r${n}`
}

/** @deprecated Prefer buildWorkerTabLabel — packed harness-workers overflow labels. */
export function nextHarnessWorkerTabLabel(existingTabs, tabPrefix = HARNESS_TAB_PREFIX) {
  if (!existingTabs.length) return tabPrefix
  return `${tabPrefix}-${existingTabs.length + 1}`
}

export function listHarnessWorkerTabs(workspaceId, tabPrefix = HARNESS_TAB_PREFIX) {
  const tabs = JSON.parse(herdr(['tab', 'list', '--workspace', workspaceId])).result?.tabs || []
  return tabs
    .filter((tab) => {
      const label = String(tab.label || '')
      return label.startsWith(tabPrefix) || / - r\d+$/.test(label)
    })
    .sort((a, b) => (a.number || 0) - (b.number || 0))
}

/** Create a dedicated tab for one worker (one pane = one tab). */
export function createWorkerTab(workspaceId, label) {
  const created = JSON.parse(herdr(['tab', 'create', '--workspace', workspaceId, '--label', label, '--no-focus']))
  const tabId = created.result?.tab?.tab_id
  const rootPaneId = created.result?.root_pane?.pane_id
  if (!tabId) throw new Error('herdr tab create did not return tab_id')
  if (!rootPaneId) throw new Error('herdr tab create did not return root_pane')
  return { tabId, rootPaneId, label }
}

export function renameWorkerTab(tabId, label) {
  if (!tabId || !label) return
  try { herdr(['tab', 'rename', tabId, label]) } catch {}
}

export function closeWorkerTab(tabId) {
  if (!tabId) return
  try { herdr(['tab', 'close', tabId]) } catch {}
}

/** @deprecated Packed-tab resolver — new spawns use createWorkerTab. */
export function resolveHarnessWorkerTab(workspaceId, { tabPrefix = HARNESS_TAB_PREFIX } = {}) {
  const label = buildWorkerTabLabel({
    taskId: 'worker',
    role: 'orchestrator',
    project: tabPrefix,
    retry: 1,
  })
  const created = createWorkerTab(workspaceId, label)
  return { tabId: created.tabId, rootPaneId: created.rootPaneId, created: true }
}

export function listTabPanes(tabId) {
  const parsed = JSON.parse(herdr(['pane', 'list']))
  return (parsed.result?.panes || []).filter((pane) => pane.tab_id === tabId)
}

function isDanglingShell(pane) {
  if (pane.agent || pane.label) return false
  return !pane.agent_status || ['unknown', 'idle'].includes(pane.agent_status)
}

/** Tab create leaves an idle shell if unused — drop orphans on a tab. */
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

/**
 * Close finished worker tabs/panes for one subproject only.
 * Prefers closing the whole tab when it only holds that worker.
 */
export function closeStaleHarnessPanesForProject(tabId, projectId, keepPaneIds) {
  const keep = keepPaneIds instanceof Set ? keepPaneIds : new Set([keepPaneIds].filter(Boolean))
  const slug = String(projectId || 'root').replace(/[^a-zA-Z0-9_-]/g, '_')
  const prefix = `worker-${slug}-`
  const panes = listTabPanes(tabId)
  let closedOwned = false
  for (const pane of panes) {
    if (keep.has(pane.pane_id)) continue
    const agentName = String(pane.agent || pane.agent_name || pane.label || '')
    const ownsPane = agentName.startsWith(prefix) || agentName.includes(`harness:${prefix}`)
    if (!ownsPane && !isDanglingShell(pane)) continue
    if (ownsPane) {
      const tail = readPaneTail(pane.pane_id, 40)
      if (['done', 'idle', 'gone', 'unknown'].includes(pane.agent_status)
        || detectPaneOrchestratorExited(tail)
        || paneShowsIdleShell(tail)) {
        closePane(pane.pane_id)
        closedOwned = true
      }
      continue
    }
    if (isDanglingShell(pane)) closePane(pane.pane_id)
  }
  if (closedOwned) {
    const remaining = listTabPanes(tabId)
    if (!remaining.length || remaining.every(isDanglingShell)) {
      for (const pane of remaining) closePane(pane.pane_id)
      closeWorkerTab(tabId)
    }
  }
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

/** Env injected into every harness worker pane (display flags + caller PATH). */
export function harnessPaneEnv(extra = {}) {
  const env = { ...HARNESS_PANE_ENV, ...extra }
  if (process.env.PATH && env.PATH == null) env.PATH = process.env.PATH
  return env
}

/**
 * Start a named harness worker in herdr — one dedicated tab per worker.
 * Tab label: `{taskId} - {role} - {project} - r{retry}`.
 */
export function spawnAgent(name, commandArgv, {
  cwd,
  layoutLockDir,
  env: extraEnv,
  tabLabel,
  taskId,
  role = 'orchestrator',
  project,
  retry = 1,
} = {}) {
  return withHerdrLayoutLock(layoutLockDir, () => {
    const workspaceId = getFocusedWorkspaceId()
    const label = tabLabel || buildWorkerTabLabel({
      taskId: taskId || name,
      role,
      project: project || 'project',
      retry,
    })
    const tab = createWorkerTab(workspaceId, label)
    const paneId = tab.rootPaneId
    const command = argvToCommand(commandArgv, { cwd, env: harnessPaneEnv(extraEnv) })
    const wrapped = `clear 2>/dev/null || true; printf '\\n%s\\n%s\\n\\n' '── ${name} ──' 'waiting for agent…'; ${command}`
    herdr(['pane', 'run', paneId, wrapped])
    closeDanglingShellPanes(tab.tabId, new Set([paneId]))
    reportHarnessAgent(paneId, name, 'working', 'starting')
    return { paneId, tabId: tab.tabId, label, tabLabel: label }
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

/** Close the worker's pane and its dedicated tab. */
export function closeWorkerDisplay(paneId, tabId) {
  if (paneId) closePane(paneId)
  if (tabId) closeWorkerTab(tabId)
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
  const scroll = paneScrollOffset(paneId)
  const source = scroll > 0 ? 'recent-unwrapped' : 'visible'
  const result = spawnSync('herdr', ['pane', 'read', paneId, '--source', source, '--lines', String(lines), '--format', 'text'], { encoding: 'utf8' })
  return result.stdout || ''
}

/** Current scroll.max_offset_from_bottom for a pane (0 if unknown). */
export function paneScrollOffset(paneId) {
  try {
    const parsed = JSON.parse(herdr(['pane', 'list']))
    const pane = (parsed.result?.panes || []).find((p) => p.pane_id === paneId)
    return Number(pane?.scroll?.max_offset_from_bottom || 0)
  } catch {
    return 0
  }
}

/** Map of paneId → scroll offset for all panes (one herdr call). */
export function listPaneScroll() {
  try {
    const parsed = JSON.parse(herdr(['pane', 'list']))
    const out = new Map()
    for (const pane of parsed.result?.panes || []) {
      out.set(pane.pane_id, Number(pane.scroll?.max_offset_from_bottom || 0))
    }
    return out
  } catch {
    return new Map()
  }
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

/** Pane shell ended but herdr kept the pane open (common after pi/codex exit). */
export function detectPaneOrchestratorExited(tail = '') {
  if (!tail) return false
  const recent = tail.trim().split('\n').filter(Boolean).slice(-6).join('\n')
  // Host adapters SIGTERM the nested agent after a harness verdict; that prints
  // "Session terminated" while the orchestrator is still alive and applying flags.
  if (/agent:\s+harness verdict received/i.test(recent)) return false
  if (/\borchestrator:\s+\S+/i.test(recent) && !/\bSession terminated, killing shell\b/i.test(recent.split('\n').at(-1) || '')) {
    if (!/\bSession terminated, killing shell\b/i.test(recent)) return false
    const lines = recent.split('\n')
    const lastKill = lines.map((line, i) => (/\bSession terminated, killing shell\b/i.test(line) ? i : -1)).filter((i) => i >= 0).at(-1)
    const lastOrch = lines.map((line, i) => (/\borchestrator:/i.test(line) ? i : -1)).filter((i) => i >= 0).at(-1)
    if (lastOrch != null && lastKill != null && lastOrch > lastKill) return false
  }
  if (/\bSession terminated, killing shell\b/i.test(recent)) return true
  if (/\.\.\.killed\.?\s*$/m.test(recent)) return true
  return false
}

export function detectPaneMergeLockWait(tail = '') {
  return /waiting for merge lock/i.test(tail)
}

/** Idle login shell with no live orchestrator/agent output on the final line. */
export function paneShowsIdleShell(tail = '') {
  if (!tail.trim()) return false
  const lines = tail.trim().split('\n').filter(Boolean)
  const last = lines[lines.length - 1] || ''
  if (/\borchestrator:/i.test(last)) return false
  if (/\bscript -q -e -c\b/.test(last)) return false
  if (/\bHARNESS-VERDICT-(BEGIN|END)\b/.test(last)) return false
  return /[❯›]\s*$/.test(last)
}

export function listProjectWorkerAgents(projectId) {
  try {
    const parsed = JSON.parse(herdr(['agent', 'list']))
    const prefix = `worker-${String(projectId || 'root').replace(/[^a-zA-Z0-9_-]/g, '_')}-`
    return (parsed.result?.agents || []).filter((agent) => String(agent.agent || '').startsWith(prefix))
  } catch {
    return []
  }
}

export function contextFromWorkerAgent(agentName, projectId) {
  const prefix = `worker-${String(projectId || 'root').replace(/[^a-zA-Z0-9_-]/g, '_')}-`
  if (!String(agentName || '').startsWith(prefix)) return null
  return agentName.slice(prefix.length) || null
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

/** Close dangling shells on harness worker tabs (legacy packed + named). */
export function closeAllDanglingHarnessShells(workspaceId) {
  for (const tab of listHarnessWorkerTabs(workspaceId)) closeDanglingShellPanes(tab.tab_id)
}
