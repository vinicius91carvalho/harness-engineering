import { spawnSync } from 'node:child_process'

function commandExists(cmd) {
  return spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0
}

/** Resolve worker display mode from CLI flag, env, or herdr context. */
export function resolveDisplayMode(options = {}) {
  const explicit = options.display || process.env.HARNESS_DISPLAY
  if (explicit === 'background') return 'background'
  if (explicit === 'herdr') return 'herdr'
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
  try {
    const parsed = JSON.parse(herdr(['pane', 'get', paneId]))
    return parsed.result?.pane?.agent_status || 'unknown'
  } catch {
    return 'unknown'
  }
}

export function isPaneDone(paneId) {
  return getPaneAgentStatus(paneId) === 'done'
}

export function readPaneTail(paneId, lines = 80) {
  const result = spawnSync('herdr', ['pane', 'read', paneId, '--source', 'recent-unwrapped', '--lines', String(lines)], { encoding: 'utf8' })
  return result.stdout || ''
}
