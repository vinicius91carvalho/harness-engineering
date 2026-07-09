#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'

const [cmd, stateFile, ...rest] = process.argv.slice(2)
const state = JSON.parse(readFileSync(stateFile, 'utf8'))
state.panes ??= []
state.seq ??= 0

function save() {
  writeFileSync(stateFile, `${JSON.stringify(state)}\n`)
}

function nextPaneId(prefix) {
  state.seq += 1
  return `${prefix}${state.seq}`
}

if (cmd === 'tab-list') {
  const workspace = rest[0]
  const tabs = state.tabs.filter((tab) => tab.workspace_id === workspace)
  process.stdout.write(`${JSON.stringify({ result: { tabs } })}\n`)
  process.exit(0)
}

if (cmd === 'tab-create') {
  const [workspace, label] = rest
  const n = state.tabs.filter((tab) => tab.workspace_id === workspace).length + 1
  const tabId = `${workspace}-${n}`
  const tab = { tab_id: tabId, label, workspace_id: workspace, number: n, pane_count: 1 }
  const rootPaneId = `${workspace}-r${n}`
  const rootPane = { pane_id: rootPaneId, tab_id: tabId, workspace_id: workspace, agent_status: 'unknown' }
  state.tabs.push(tab)
  state.panes.push(rootPane)
  save()
  process.stdout.write(`${JSON.stringify({ result: { tab, root_pane: rootPane } })}\n`)
  process.exit(0)
}

if (cmd === 'tab-rename') {
  const [tabId, label] = rest
  const tab = state.tabs.find((t) => t.tab_id === tabId)
  if (tab) {
    tab.label = label
    save()
  }
  process.stdout.write(`${JSON.stringify({ result: { type: 'ok' } })}\n`)
  process.exit(0)
}

if (cmd === 'tab-close') {
  const [tabId] = rest
  state.panes = state.panes.filter((p) => p.tab_id !== tabId)
  state.tabs = state.tabs.filter((t) => t.tab_id !== tabId)
  save()
  process.stdout.write(`${JSON.stringify({ result: { type: 'ok' } })}\n`)
  process.exit(0)
}

if (cmd === 'pane-list') {
  process.stdout.write(`${JSON.stringify({ result: { panes: state.panes } })}\n`)
  process.exit(0)
}

if (cmd === 'pane-split') {
  const sourceId = rest[0]
  const source = state.panes.find((pane) => pane.pane_id === sourceId)
  if (!source) {
    process.stderr.write(`unknown source pane: ${sourceId}\n`)
    process.exit(1)
  }
  const paneId = nextPaneId(`${source.tab_id}-s`)
  const pane = { pane_id: paneId, tab_id: source.tab_id, workspace_id: source.workspace_id, agent_status: 'unknown' }
  state.panes.push(pane)
  const tab = state.tabs.find((t) => t.tab_id === source.tab_id)
  if (tab) tab.pane_count = (tab.pane_count || 0) + 1
  save()
  process.stdout.write(`${JSON.stringify({ result: { pane } })}\n`)
  process.exit(0)
}

if (cmd === 'pane-get') {
  const paneId = rest[0]
  const pane = state.panes.find((p) => p.pane_id === paneId)
  if (!pane) {
    process.stdout.write(`${JSON.stringify({ error: { code: 'pane_not_found' } })}\n`)
    process.exit(1)
  }
  process.stdout.write(`${JSON.stringify({ result: { pane } })}\n`)
  process.exit(0)
}

if (cmd === 'pane-close') {
  const paneId = rest[0]
  const pane = state.panes.find((p) => p.pane_id === paneId)
  state.panes = state.panes.filter((p) => p.pane_id !== paneId)
  if (pane) {
    const tab = state.tabs.find((t) => t.tab_id === pane.tab_id)
    if (tab) tab.pane_count = Math.max(0, (tab.pane_count || 1) - 1)
  }
  save()
  process.exit(0)
}

if (cmd === 'pane-read') {
  const paneId = rest[0]
  const tail = state.pane_tails?.[paneId] || 'worker output line\n'
  process.stdout.write(tail.endsWith('\n') ? tail : `${tail}\n`)
  process.exit(0)
}

if (cmd === 'pane-report-agent') {
  const [paneId, agentState] = rest
  const pane = state.panes.find((p) => p.pane_id === paneId)
  if (pane) {
    pane.agent_status = agentState
    save()
  }
  process.exit(0)
}

if (cmd === 'bump-tab') {
  const tabId = rest[0]
  const hit = state.tabs.find((tab) => tab.tab_id === tabId)
  if (hit) hit.pane_count = (hit.pane_count || 0) + 1
  save()
  process.exit(0)
}

process.stderr.write(`unknown helper command: ${cmd}\n`)
process.exit(1)
