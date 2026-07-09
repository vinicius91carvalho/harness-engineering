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
import { MARKER_PATTERN, hasMergeMarkers } from '../skills/generator/lib/integrate-checkpoint.mjs'
import { interpretWorkerOutcome } from '../skills/generator/lib/worker-outcome.mjs'
import { drainRetryQueue, applyRetryResumeOutcome, shouldFinalizePendingGoal } from '../skills/generator/lib/supervisor-tick.mjs'

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

test('MARKER_PATTERN detects unresolved merge markers', () => {
  assert.equal(hasMergeMarkers('line\n<<<<<<< ours\n'), true)
  assert.equal(hasMergeMarkers('line\n=======\n'), true)
  assert.equal(hasMergeMarkers('line\n>>>>>>> theirs\n'), true)
  assert.equal(hasMergeMarkers('clean merged content\n'), false)
  assert.equal(MARKER_PATTERN.test('<<<<<<< HEAD\n'), true)
})

test('interpretWorkerOutcome goal-review complete', () => {
  const result = interpretWorkerOutcome({
    key: 'goal-review',
    tail: '',
    persisted: null,
    runState: { status: 'complete', phase: 'complete', lastResult: 'all checks passed' },
    featureIds: [],
    queue: [],
  })
  assert.equal(result.goal, true)
  assert.equal(result.durable, true)
})

test('interpretWorkerOutcome blocked context', () => {
  const result = interpretWorkerOutcome({
    key: 'core',
    tail: '',
    persisted: null,
    runState: { status: 'blocked', lastResult: 'Attempt budget exhausted' },
    featureIds: ['WI-1'],
    queue: [{ id: 'WI-1', integration: false }],
  })
  assert.equal(result.blocked, true)
  assert.equal(result.summary, 'Attempt budget exhausted')
})

test('interpretWorkerOutcome context complete when integrated', () => {
  const result = interpretWorkerOutcome({
    key: 'core',
    tail: '',
    persisted: null,
    runState: { status: 'complete' },
    featureIds: ['WI-1', 'WI-2'],
    queue: [
      { id: 'WI-1', integration: true },
      { id: 'WI-2', integration: true },
    ],
  })
  assert.equal(result.total, 2)
  assert.equal(result.passed, 2)
  assert.deepEqual(result.stuck, [])
})

test('drainRetryQueue respects slot budget on successful resume', () => {
  const retryQueue = {
    alpha: { guidance: 'retry alpha', attempts: 0 },
    beta: { guidance: 'retry beta', attempts: 0 },
  }
  const { attempts } = drainRetryQueue(retryQueue, 2)
  assert.equal(attempts.length, 2)
  assert.equal(attempts[0].context, 'alpha')

  let slots = 1
  const first = applyRetryResumeOutcome(retryQueue, 'alpha', retryQueue.alpha, true)
  slots += first.remainingSlotsDelta
  assert.equal(slots, 0)
  assert.equal(first.updatedQueue.alpha, undefined)
})

test('applyRetryResumeOutcome exhausts after max attempts', () => {
  const retry = { guidance: 'retry', attempts: 4 }
  const outcome = applyRetryResumeOutcome({ core: retry }, 'core', retry, false, 5)
  assert.equal(outcome.exhausted.attempts, 5)
  assert.equal(outcome.updatedQueue.core, undefined)
})

test('shouldFinalizePendingGoal waits for empty retry queue', () => {
  assert.equal(shouldFinalizePendingGoal({}, { goal: true }), true)
  assert.equal(shouldFinalizePendingGoal({ core: { guidance: 'x' } }, { goal: true }), false)
  assert.equal(shouldFinalizePendingGoal({}, null), false)
})
