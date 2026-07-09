import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, chmodSync } from 'node:fs'
import { readFile, writeFile as writeFileAsync, appendFile as appendFileAsync, mkdir as mkdirAsync } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
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
import { mkey, strikeOf, buildPlan, buildCandidates, lastCoder } from '../skills/generator/lib/route-plan.mjs'
import { planWorkerClosedActions } from '../skills/generator/lib/worker-lifecycle.mjs'
import { pruneOrphanPendingInputs, isCrashBoundContext, liveClaimContexts } from '../skills/generator/lib/supervisor-claims.mjs'
import { createWorkflowState } from '../skills/generator/lib/workflow-state.mjs'
import { readJson, atomicJson } from '../skills/generator/lib/fs-json.mjs'
import { integrationBranchName, DEFAULT_INTEGRATION_BRANCH } from '../skills/generator/lib/integration-branch.mjs'
import { cleanupBrowserOrphans } from '../skills/generator/lib/browser-cleanup.mjs'
import { mergeAcquire, mergeRelease } from '../skills/generator/lib/claim-lease.mjs'
import { hostSpawnVisible } from '../skills/generator/lib/agent-spawn.mjs'

function withoutIntegrationBranchEnv(fn) {
  const saved = process.env.HARNESS_INTEGRATION_BRANCH
  delete process.env.HARNESS_INTEGRATION_BRANCH
  try {
    return fn()
  } finally {
    if (saved === undefined) delete process.env.HARNESS_INTEGRATION_BRANCH
    else process.env.HARNESS_INTEGRATION_BRANCH = saved
  }
}

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

test('browser cleanup is a no-op on win32', () => {
  assert.deepEqual(cleanupBrowserOrphans({ port: 5170, workdir: '/tmp/wt' }), { killed: 0 })
})

test('merge lock does not spam BUSY on stdout in herdr panes', () => {
  withoutIntegrationBranchEnv(() => {
    const root = mkdtempSync(join(tmpdir(), 'merge-busy-'))
    spawnSync('git', ['init', '-b', 'main'], { cwd: root })
    spawnSync('git', ['config', 'user.name', 'test'], { cwd: root })
    spawnSync('git', ['config', 'user.email', 't@example.invalid'], { cwd: root })
    writeFileSync(join(root, 'README.md'), 'x\n')
    spawnSync('git', ['add', 'README.md'], { cwd: root })
    spawnSync('git', ['commit', '-qm', 'init'], { cwd: root })
    const held = mergeAcquire(root, process.pid)
    assert.ok(held.integDir)
    const claimLease = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'generator', 'lib', 'claim-lease.mjs')
    const child = spawnSync(process.execPath, [
      '-e',
      `import { mergeAcquire } from ${JSON.stringify(claimLease)};
       const result = mergeAcquire(${JSON.stringify(root)}, 999999);
       if (result.busy) process.exit(0);
       process.stderr.write(JSON.stringify(result));
       process.exit(2);`,
    ], { env: { ...process.env, HARNESS_HERDR_PANE: '1' }, encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr || child.stdout)
    assert.equal(child.stdout, '')
    mergeRelease(root, process.pid)
  })
})

test('hostSpawnVisible respects herdr env', () => {
  assert.equal(hostSpawnVisible(), Boolean(process.env.HARNESS_HERDR_PANE === '1' || process.env.HARNESS_DISPLAY === 'herdr'))
})

test('integration branch resolves from file and env', () => {
  withoutIntegrationBranchEnv(() => {
    const root = mkdtempSync(join(tmpdir(), 'integration-branch-'))
    spawnSync('git', ['init'], { cwd: root })
    mkdirSync(join(root, '.harness'), { recursive: true })
    writeFileSync(join(root, '.harness', 'integration-branch'), 'plan/demo\n')
    assert.equal(integrationBranchName(root), 'plan/demo')
    assert.equal(integrationBranchName(root, { env: { HARNESS_INTEGRATION_BRANCH: 'plan/override' } }), 'plan/override')
    assert.equal(DEFAULT_INTEGRATION_BRANCH, 'main')
  })
})


test('pickClaimCandidate selects first unclaimed ready context', () => {
  withoutIntegrationBranchEnv(() => {
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

test('route-plan mkey and strikeOf', () => {
  assert.equal(mkey('claude', 'opus'), 'claude|opus')
  assert.equal(mkey('claude', null), 'claude|')
  const strikes = { 'infra|claude|': 2, 'quality|coding|claude|': 1 }
  assert.equal(strikeOf('coding', 'claude', null, strikes), 3)
})

test('route-plan buildPlan sorts by strikes', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'route-plan-'))
  spawnSync('git', ['init', '-b', 'main'], { cwd: tmp, encoding: 'utf8' })
  const roles = {
    coding: [{ harness: 'claude' }, { harness: 'codex' }],
    validation: [{ harness: 'claude' }],
    repairPlanning: [{ harness: 'claude' }],
    goalReview: [{ harness: 'claude' }],
  }
  const plan = buildPlan(tmp, roles)
  assert.ok(plan.sortedRoles.coding.length === 2)
})

test('route-plan buildCandidates direct mode', () => {
  const candidates = buildCandidates({
    plan: null,
    kind: 'CODING',
    attempt: 1,
    options: { host: 'claude' },
    roleNames: { CODING: 'coding' },
    codedBy: null,
    state: {},
  })
  assert.deepEqual(candidates, [{ harness: 'claude' }])
})

test('route-plan lastCoder from route history', () => {
  const state = {
    routeHistory: [
      { kind: 'CODING', outcome: 'selected', harness: 'codex', model: 'gpt' },
    ],
  }
  assert.equal(lastCoder(state), 'codex|gpt')
})

test('planWorkerClosedActions quota retry', () => {
  const plan = planWorkerClosedActions({
    key: 'core',
    exitCode: 1,
    tail: '429 rate limit',
    result: null,
    rateLimited: true,
    crashCount: 0,
    harnessRepairs: {},
    retryQueue: {},
    autoRepair: false,
    logFile: '/tmp/log',
  })
  assert.equal(plan.action, 'quota_retry')
})

test('planWorkerClosedActions release on success', () => {
  const plan = planWorkerClosedActions({
    key: 'core',
    exitCode: 0,
    tail: '',
    result: { total: 1, passed: 1, stuck: [] },
    rateLimited: false,
    crashCount: 0,
    harnessRepairs: {},
    retryQueue: {},
    autoRepair: false,
    logFile: '/tmp/log',
  })
  assert.equal(plan.action, 'release')
  assert.equal(plan.passed, 1)
})

test('planWorkerClosedActions blocked input', () => {
  const plan = planWorkerClosedActions({
    key: 'core',
    exitCode: 0,
    tail: '',
    result: { blocked: true, summary: 'Attempt budget exhausted' },
    rateLimited: false,
    crashCount: 0,
    harnessRepairs: {},
    retryQueue: {},
    autoRepair: false,
    logFile: '/tmp/log',
  })
  assert.equal(plan.action, 'blocked_input')
  assert.equal(plan.scope, 'context')
})

test('createWorkflowState journal and readFeatures', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'workflow-state-'))
  const stateFile = join(tmp, 'state.json')
  const queue = [{ id: 'WI-1', context: 'core', integration: false }]
  writeFileSync(join(tmp, 'feature_list.json'), `${JSON.stringify(queue)}\n`)
  const wf = createWorkflowState({
    stateFile,
    leaseToken: 'test-lease',
    context: 'core',
    readJson,
    atomicJson,
    hostname: () => 'testhost',
    process,
    fail: (msg) => { throw new Error(msg) },
    dirname,
    join,
    mkdir: mkdirAsync,
    appendFile: appendFileAsync,
    writeFile: writeFileAsync,
    readFile,
    git: () => ({ status: 0, stdout: '' }),
    workdir: tmp,
    terminateChild: () => {},
  })
  const { list } = await wf.readFeatures(tmp)
  assert.equal(list[0].id, 'WI-1')
  const journalFile = await wf.journal(tmp, 'Test entry', { Outcome: 'ok' })
  assert.ok(journalFile.endsWith('core.md'))
})

test('atomicJson reformats feature_list.json with the target repo\'s own installed formatter', async () => {
  // Stand in for a target repo (e.g. one with Biome configured) that would fail its own
  // `<formatter> check .` Acceptance Check if feature_list.json weren't in its house style.
  const tmp = mkdtempSync(join(tmpdir(), 'fs-json-fmt-'))
  const binDir = join(tmp, 'node_modules', '.bin')
  mkdirSync(binDir, { recursive: true })
  const fakeBiome = join(binDir, 'biome')
  writeFileSync(fakeBiome, '#!/usr/bin/env bash\necho \'["reformatted-by-fake-biome"]\' > "${@: -1}"\n')
  chmodSync(fakeBiome, 0o755)

  await atomicJson(join(tmp, 'feature_list.json'), [{ id: 'WI-1' }])
  assert.equal(readFileSync(join(tmp, 'feature_list.json'), 'utf8'), '["reformatted-by-fake-biome"]\n')

  // Other JSON files (Run State, defect records, ...) never trigger the reformat -
  // only feature_list.json is committed into the target repo's linted tree.
  await atomicJson(join(tmp, 'state.json'), { a: 1 })
  assert.equal(readFileSync(join(tmp, 'state.json'), 'utf8'), '{\n  "a": 1\n}\n')
})

test('atomicJson leaves feature_list.json untouched when the target repo has no formatter installed', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fs-json-noformat-'))
  await atomicJson(join(tmp, 'feature_list.json'), [{ id: 'WI-1' }])
  assert.deepEqual(JSON.parse(readFileSync(join(tmp, 'feature_list.json'), 'utf8')), [{ id: 'WI-1' }])
})

test('pruneOrphanPendingInputs drops stale context events only', () => {
  const pending = {
    100: { scope: 'context', context: 'ghost-orphan' },
    101: { scope: 'context', context: 'realblock' },
    102: { scope: 'goal', context: null },
  }
  const claims = { realblock: { context: 'realblock', status: 'blocked' } }
  const { pendingInputs, pruned } = pruneOrphanPendingInputs(pending, { claims, retryQueue: {}, workerContexts: [] })
  assert.equal(pruned, 1)
  assert.equal(pendingInputs[100], undefined)
  assert.ok(pendingInputs[101])
  assert.ok(pendingInputs[102])
})

test('liveClaimContexts and crash bound skip', () => {
  const claims = { a: { context: 'alpha' }, b: { context: 'beta' } }
  assert.deepEqual([...liveClaimContexts(claims)].sort(), ['alpha', 'beta'])
  assert.equal(isCrashBoundContext('flaky', { flaky: 5 }), true)
  assert.equal(isCrashBoundContext('flaky', { flaky: 4 }), false)
})
