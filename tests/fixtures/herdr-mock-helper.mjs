#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'

const [cmd, stateFile, ...rest] = process.argv.slice(2)
const state = JSON.parse(readFileSync(stateFile, 'utf8'))

if (cmd === 'tab-list') {
  const workspace = rest[0]
  const tabs = state.tabs.filter((tab) => tab.workspace_id === workspace)
  process.stdout.write(`${JSON.stringify({ result: { tabs } })}\n`)
  process.exit(0)
}

if (cmd === 'tab-create') {
  const [workspace, label] = rest
  const n = state.tabs.filter((tab) => tab.workspace_id === workspace).length + 1
  const tab = { tab_id: `${workspace}-${n}`, label, workspace_id: workspace, number: n, pane_count: 1 }
  const rootPane = { pane_id: `${workspace}-r${n}`, tab_id: tab.tab_id, agent_status: 'unknown' }
  state.tabs.push(tab)
  writeFileSync(stateFile, `${JSON.stringify(state)}\n`)
  process.stdout.write(`${JSON.stringify({ result: { tab, root_pane: rootPane } })}\n`)
  process.exit(0)
}

if (cmd === 'bump-tab') {
  const tabId = rest[0]
  const hit = state.tabs.find((tab) => tab.tab_id === tabId)
  if (hit) hit.pane_count = (hit.pane_count || 0) + 1
  writeFileSync(stateFile, `${JSON.stringify(state)}\n`)
  process.exit(0)
}

process.stderr.write(`unknown helper command: ${cmd}\n`)
process.exit(1)
