import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { parseObject, isProviderQuotaLimited, VERDICT_BEGIN, VERDICT_END } from '../skills/generator/lib/verdict.mjs'
import { readyWorkItems, isWorkItemReady } from '../skills/generator/lib/ready-work-items.mjs'
import { claimKey, projectIdFromPrefix, resultFileFromRunState } from '../skills/generator/lib/project-keys.mjs'
import { isHarnessInfrastructureError, stuckThresholdMs } from '../skills/generator/lib/stuck-worker.mjs'
import { pickClaimCandidate, mergeDo, restoreDirtyRuntimeLogs } from '../skills/generator/lib/claim-lease.mjs'

test('parseObject reads delimited verdict', () => {
  const body = `${VERDICT_BEGIN}\n{"goal":true}\n${VERDICT_END}`
  assert.deepEqual(parseObject(body), { goal: true })
})

test('isProviderQuotaLimited detects common quota messages', () => {
  assert.equal(isProviderQuotaLimited('429 rate limit'), true)
  assert.equal(isProviderQuotaLimited('usage limit Try again at midnight'), true)
  assert.equal(isProviderQuotaLimited('network timeout'), false)
})

test('readyWorkItems respects dependency graph', () => {
  const queue = [
    { id: 'WI-1', context: 'a', acceptance_checks: ['AC-1'], depends_on: [], integration: false },
    { id: 'WI-2', context: 'b', acceptance_checks: ['AC-2'], depends_on: ['AC-1'], integration: false },
  ]
  assert.equal(readyWorkItems(queue).length, 1)
  queue[0].integration = true
  assert.equal(readyWorkItems(queue).length, 1)
  assert.equal(readyWorkItems(queue)[0].id, 'WI-2')
})

test('isWorkItemReady qa mode', () => {
  const queue = [{ id: 'WI-1', context: 'a', acceptance_checks: ['AC-1'], implementation: true, qa: false, integration: false }]
  assert.equal(isWorkItemReady(queue[0], queue, { mode: 'qa' }), true)
  assert.equal(isWorkItemReady(queue[0], queue, { mode: 'all' }), true)
})

test('project keys', () => {
  assert.equal(projectIdFromPrefix('app/'), 'app')
  assert.equal(claimKey('app', 'core'), 'app--core')
  assert.equal(resultFileFromRunState('/tmp/app--core.json'), '/tmp/app--core.result.json')
})

test('harness infrastructure error detection', () => {
  assert.equal(isHarnessInfrastructureError('orchestrator: cannot read feature_list.json'), true)
  assert.equal(isHarnessInfrastructureError('QA failed after Attempt 3'), false)
})

test('stuck threshold default', () => {
  assert.equal(stuckThresholdMs(), 600_000)
})


test('pickClaimCandidate selects first unclaimed ready context', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'claim-pick-'))
  spawnSync('git', ['init', '-b', 'main'], { cwd: tmp, encoding: 'utf8' })
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: tmp })
  spawnSync('git', ['config', 'user.email', 't@example.invalid'], { cwd: tmp })
  const queue = [
    { id: 'A', context: 'alpha', acceptance_checks: ['AC-A'], depends_on: [], integration: false },
    { id: 'B', context: 'beta', acceptance_checks: ['AC-B'], depends_on: [], integration: false },
  ]
  writeFileSync(join(tmp, 'feature_list.json'), `${JSON.stringify(queue)}\n`)
  spawnSync('git', ['add', 'feature_list.json'], { cwd: tmp })
  spawnSync('git', ['commit', '-qm', 'init'], { cwd: tmp })

  const first = pickClaimCandidate(tmp, 'all', '', {})
  assert.equal(first.context, 'alpha')
  assert.deepEqual(first.featureIds, ['A'])

  const claims = { alpha: { status: 'building' } }
  const second = pickClaimCandidate(tmp, 'all', '', claims)
  assert.equal(second.context, 'beta')
  assert.deepEqual(second.featureIds, ['B'])
})

test('mergeDo restores dirty runtime logs before merging', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'claim-merge-'))
  spawnSync('git', ['init', '-b', 'main'], { cwd: tmp, encoding: 'utf8' })
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: tmp })
  spawnSync('git', ['config', 'user.email', 't@example.invalid'], { cwd: tmp })
  mkdirSync(join(tmp, 'logs'))
  writeFileSync(join(tmp, 'logs', 'app.log'), 'base\n')
  writeFileSync(join(tmp, 'app.js'), 'keep\n')
  spawnSync('git', ['add', '.'], { cwd: tmp })
  spawnSync('git', ['commit', '-qm', 'init'], { cwd: tmp })

  spawnSync('git', ['checkout', '-q', '-b', 'gen/root-core'], { cwd: tmp })
  writeFileSync(join(tmp, 'logs', 'app.log'), 'branchval\n')
  writeFileSync(join(tmp, 'app.js'), 'feature\n')
  spawnSync('git', ['commit', '-aqm', 'branch work'], { cwd: tmp })
  spawnSync('git', ['checkout', '-q', 'main'], { cwd: tmp })

  writeFileSync(join(tmp, 'logs', 'app.log'), 'runtime-noise\n')
  restoreDirtyRuntimeLogs(tmp)
  assert.equal(spawnSync('git', ['diff', '--name-only'], { cwd: tmp, encoding: 'utf8' }).stdout.trim(), '')

  const result = mergeDo(tmp, 'core', tmp)
  assert.equal(result.status, 'clean')
  assert.equal(spawnSync('cat', [join(tmp, 'logs', 'app.log')], { encoding: 'utf8' }).stdout, 'branchval\n')
  assert.equal(spawnSync('cat', [join(tmp, 'app.js')], { encoding: 'utf8' }).stdout, 'feature\n')
})
