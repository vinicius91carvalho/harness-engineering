import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  shouldCloseCursorSubagentEntry,
  planCursorSubagentTabReap,
  applyCursorSubagentTabReap,
  isCursorSubagentAgent,
  paneLooksLikeCursorSubagent,
  logviewAliveForMeta,
  DEFAULT_ORPHAN_GRACE_MS,
  DEFAULT_IDLE_AFTER_START_MS,
} from '../skills/generator/lib/cursor-subagent-tab-reaper.mjs'

const NOW = Date.parse('2026-07-15T22:00:00.000Z')

function entryAt(ageMs) {
  return { started_at: new Date(NOW - ageMs).toISOString(), tab_id: 'tab-1', root_pane_id: 'pane-1' }
}

test('isCursorSubagentAgent matches cursor-sub prefix', () => {
  assert.equal(isCursorSubagentAgent('cursor-sub-abc123'), true)
  assert.equal(isCursorSubagentAgent('worker-causeflow-core'), false)
})

test('shouldCloseCursorSubagentEntry keeps old live working entry', () => {
  const entry = entryAt(DEFAULT_ORPHAN_GRACE_MS + 1_000)
  const pane = { pane_id: 'pane-1', tab_id: 'tab-1', agent_status: 'working', cwd: '/tmp/proj' }
  const decision = shouldCloseCursorSubagentEntry(entry, {
    pane,
    logviewAlive: true,
    now: NOW,
  })
  assert.equal(decision.close, false)
  assert.equal(decision.reason, 'live')
})

test('shouldCloseCursorSubagentEntry keeps old working entry when logview is unknown', () => {
  const entry = entryAt(DEFAULT_ORPHAN_GRACE_MS + 1_000)
  const pane = { pane_id: 'pane-1', tab_id: 'tab-1', agent_status: 'working', cwd: '/tmp/proj' }
  const decision = shouldCloseCursorSubagentEntry(entry, {
    pane,
    logviewAlive: null,
    now: NOW,
  })
  assert.equal(decision.close, false)
  assert.equal(decision.reason, 'live')
})

test('shouldCloseCursorSubagentEntry closes missing pane on orphan grace', () => {
  const entry = entryAt(DEFAULT_ORPHAN_GRACE_MS + 1_000)
  const decision = shouldCloseCursorSubagentEntry(entry, {
    pane: null,
    logviewAlive: null,
    now: NOW,
  })
  assert.equal(decision.close, true)
  assert.equal(decision.reason, 'missing_pane_orphan')
})

test('shouldCloseCursorSubagentEntry keeps young live entry', () => {
  const entry = entryAt(30_000)
  const pane = { pane_id: 'pane-1', tab_id: 'tab-1', agent_status: 'working', cwd: '/tmp/proj' }
  const decision = shouldCloseCursorSubagentEntry(entry, {
    pane,
    logviewAlive: true,
    now: NOW,
  })
  assert.equal(decision.close, false)
  assert.equal(decision.reason, 'live')
})

test('shouldCloseCursorSubagentEntry closes when logview is dead', () => {
  const entry = entryAt(DEFAULT_IDLE_AFTER_START_MS + 1_000)
  const pane = { pane_id: 'pane-1', tab_id: 'tab-1', agent_status: 'working', cwd: '/tmp/proj' }
  const decision = shouldCloseCursorSubagentEntry(entry, {
    pane,
    logviewAlive: false,
    now: NOW,
  })
  assert.equal(decision.close, true)
  assert.equal(decision.reason, 'logview_dead')
})

test('shouldCloseCursorSubagentEntry closes cwd_deleted panes', () => {
  const entry = entryAt(10_000)
  const pane = {
    pane_id: 'pane-1',
    tab_id: 'tab-1',
    agent_status: 'working',
    cwd: '/home/user/proj (deleted)',
  }
  const decision = shouldCloseCursorSubagentEntry(entry, { pane, now: NOW })
  assert.equal(decision.close, true)
  assert.equal(decision.reason, 'cwd_deleted')
})

test('planCursorSubagentTabReap keeps live registry entry past orphan grace', () => {
  const registry = {
    sub1: {
      tab_id: 'tab-reg',
      root_pane_id: 'pane-reg',
      meta_path: '/tmp/meta.json',
      started_at: new Date(NOW - DEFAULT_ORPHAN_GRACE_MS - 5_000).toISOString(),
    },
  }
  const panes = [{
    pane_id: 'pane-reg',
    tab_id: 'tab-reg',
    agent: 'cursor-sub-deadbeef',
    agent_status: 'working',
    cwd: '/tmp/causeflow-ai',
  }]
  const plan = planCursorSubagentTabReap({
    registry,
    panes,
    now: NOW,
    isLogviewAlive: () => true,
  })
  assert.equal(plan.shouldReap, false)
  assert.equal(plan.closes.length, 0)
  assert.equal(plan.keepRegistryIds.has('sub1'), true)
})

test('planCursorSubagentTabReap keeps active registry entry with live logview', () => {
  const registry = {
    sub1: {
      tab_id: 'tab-live',
      root_pane_id: 'pane-live',
      meta_path: '/tmp/live-meta.json',
      started_at: new Date(NOW - 30_000).toISOString(),
    },
  }
  const panes = [{
    pane_id: 'pane-live',
    tab_id: 'tab-live',
    agent: 'cursor-sub-live',
    agent_status: 'working',
    cwd: '/tmp/causeflow-ai',
  }]
  const plan = planCursorSubagentTabReap({
    registry,
    panes,
    now: NOW,
    isLogviewAlive: () => true,
  })
  assert.equal(plan.shouldReap, false)
  assert.equal(plan.closes.length, 0)
})

test('planCursorSubagentTabReap closes stray cursor-sub panes not in registry', () => {
  const panes = [{
    pane_id: 'pane-stray',
    tab_id: 'tab-stray',
    agent: 'cursor-sub-stray',
    agent_status: 'working',
    cwd: '/tmp/causeflow-ai',
  }]
  const plan = planCursorSubagentTabReap({
    registry: {},
    panes,
    now: NOW,
    isLogviewAlive: () => false,
  })
  assert.equal(plan.shouldReap, true)
  assert.equal(plan.closes.length, 1)
  assert.equal(plan.closes[0].registryId, null)
  assert.equal(plan.closes[0].tabId, 'tab-stray')
  assert.ok(['logview_dead', 'stray_cursor_sub'].includes(plan.closes[0].reason))
})

test('logviewAliveForMeta detects meta path in ps output', () => {
  const meta = '/home/user/.cursor/herdr-subagent-meta/abc.json'
  const ps = 'python3 /home/user/.cursor/herdr-subagent-logview.py /home/user/.cursor/herdr-subagent-meta/abc.json\n'
  assert.equal(logviewAliveForMeta(meta, ps), true)
  assert.equal(logviewAliveForMeta(meta, 'other process\n'), false)
})

test('paneLooksLikeCursorSubagent matches Task-style labels', () => {
  assert.equal(paneLooksLikeCursorSubagent({ agent: 'cursor-sub-x' }), true)
  assert.equal(paneLooksLikeCursorSubagent({ label: '🧮 generalPurpose: Diagnose' }), true)
  assert.equal(paneLooksLikeCursorSubagent({ agent: 'worker-causeflow-core' }), false)
})

test('applyCursorSubagentTabReap keeps registry after transient close failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-reap-'))
  const metaPath = join(root, 'meta.json')
  const registryPath = join(root, 'registry.json')
  writeFileSync(metaPath, '{}\n')
  const registry = { sub1: { tab_id: 'tab-1', meta_path: metaPath } }
  const result = applyCursorSubagentTabReap({
    closes: [{ registryId: 'sub1', tabId: 'tab-1', metaPath }],
  }, {
    registryPath,
    registry,
    run: () => ({ status: 1, stderr: 'temporary herdr failure' }),
  })
  assert.equal(result.closed, 0)
  assert.equal(result.errors.length, 1)
  assert.deepEqual(result.registry, registry)
  assert.equal(existsSync(metaPath), true)
})

test('applyCursorSubagentTabReap prunes registry when tab is already gone', () => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-reap-'))
  const metaPath = join(root, 'meta.json')
  const registryPath = join(root, 'registry.json')
  writeFileSync(metaPath, '{}\n')
  const result = applyCursorSubagentTabReap({
    closes: [{ registryId: 'sub1', tabId: 'tab-1', metaPath }],
  }, {
    registryPath,
    registry: { sub1: { tab_id: 'tab-1', meta_path: metaPath } },
    run: () => ({ status: 1, stderr: 'tab_not_found' }),
  })
  assert.equal(result.closed, 0)
  assert.equal(result.errors.length, 1)
  assert.deepEqual(result.registry, {})
  assert.equal(existsSync(metaPath), false)
})
