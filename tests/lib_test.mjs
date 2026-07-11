import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, appendFileSync, chmodSync } from 'node:fs'
import { readFile, writeFile as writeFileAsync, appendFile as appendFileAsync, mkdir as mkdirAsync } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { parseObject, isProviderQuotaLimited, VERDICT_BEGIN, VERDICT_END } from '../skills/generator/lib/verdict.mjs'
import { readyWorkItems, isWorkItemReady, validateDependencyGraph } from '../skills/generator/lib/ready-work-items.mjs'
import { parseProjectSpecification } from '../skills/generator/lib/project-specification.mjs'
import { resolveProjectTopology } from '../skills/generator/lib/project-topology.mjs'
import { claimKey, projectIdFromPrefix, resultFileFromRunState } from '../skills/generator/lib/project-keys.mjs'
import { isHarnessInfrastructureError, stuckThresholdMs } from '../skills/generator/lib/stuck-worker.mjs'
import { pickClaimCandidate, mergeDo, restoreDirtyRuntimeLogs } from '../skills/generator/lib/claim-lease.mjs'
import { MARKER_PATTERN, hasMergeMarkers, unionAppendOnly } from '../skills/generator/lib/integrate-checkpoint.mjs'
import { interpretWorkerOutcome } from '../skills/generator/lib/worker-outcome.mjs'
import { drainRetryQueue, applyRetryResumeOutcome, shouldFinalizePendingGoal } from '../skills/generator/lib/supervisor-tick.mjs'
import { planTickAdmission, goalReviewAdmissible, goalReviewGate } from '../skills/generator/lib/supervisor-admission.mjs'
import { goalReviewAdmissible as goalReviewContract } from '../skills/generator/lib/completion-contract.mjs'
import { mkey, strikeOf, buildPlan, buildCandidates, lastCoder, candidatePool, isNoCreditsCandidate } from '../skills/generator/lib/route-plan.mjs'
import { planWorkerClosedActions, buildOrchestratorArgv, buildWorkerBase, planWorkerHerdrMeta, planWorkerStop, planWorkerCleanupTargets, terminateProcessTree } from '../skills/generator/lib/worker-lifecycle.mjs'
import { pruneOrphanPendingInputs, isCrashBoundContext, liveClaimContexts } from '../skills/generator/lib/supervisor-claims.mjs'
import { isAutoRetryableInput, planAutoRetryResponses } from '../skills/generator/lib/supervisor-auto-respond.mjs'
import {
  authorizeRecovery,
  classifyFailure,
  isAutoRetryableReason,
  requiresDurableApproval,
  recoveryDecision,
} from '../skills/generator/lib/failure-policy.mjs'
import {
  readWorkerResult,
  validateWorkerVerdict,
  writeWorkerResult,
} from '../skills/generator/lib/worker-result.mjs'
import { createWorkflowState } from '../skills/generator/lib/workflow-state.mjs'
import { applyLedgerToCatalog, readLedger, ledgerPath } from '../skills/generator/lib/execution-ledger.mjs'
import { readJson, atomicJson } from '../skills/generator/lib/fs-json.mjs'
import { integrationBranchName, DEFAULT_INTEGRATION_BRANCH } from '../skills/generator/lib/integration-branch.mjs'
import { cleanupBrowserOrphans } from '../skills/generator/lib/browser-cleanup.mjs'
import { mergeAcquire, mergeRelease, clearDeadLock } from '../skills/generator/lib/claim-lease.mjs'
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

test('parseProjectSpecification rejects unknown deps and cycles', () => {
  const unknownDep = `<project_specification>
    <project_goal>Goal</project_goal>
    <acceptance_checks>
      <acceptance_check id="AC-1" context="a" category="functional" depends_on="AC-404">
        <description>one</description>
      </acceptance_check>
    </acceptance_checks>
  </project_specification>`
  assert.throws(() => parseProjectSpecification(unknownDep), /unknown acceptance check AC-404/)

  const cycle = `<project_specification>
    <project_goal>Goal</project_goal>
    <acceptance_checks>
      <acceptance_check id="AC-1" context="a" category="functional" depends_on="AC-2">
        <description>one</description>
      </acceptance_check>
      <acceptance_check id="AC-2" context="b" category="functional" depends_on="AC-1">
        <description>two</description>
      </acceptance_check>
    </acceptance_checks>
  </project_specification>`
  assert.throws(() => parseProjectSpecification(cycle), /dependency cycle/)
})

test('planning_decisions require topic coverage and valid Acceptance Check links', () => {
  const baseChecks = `
    <acceptance_checks>
      <acceptance_check id="AC-1" context="a" category="functional" depends_on="">
        <description>happy path</description>
      </acceptance_check>
      <acceptance_check id="AC-2" context="a" category="edge-case" depends_on="AC-1">
        <description>empty input rejected</description>
      </acceptance_check>
    </acceptance_checks>`

  const missingTopic = `<project_specification>
    <project_goal>Goal</project_goal>
    ${baseChecks}
    <planning_decisions>
      <decision id="D-1" topic="ambiguous-requirement">
        <question>Who can publish?</question>
        <options>Anyone; signed-in only</options>
        <choice>Signed-in only</choice>
        <rationale>Matches auth model</rationale>
        <acceptance_checks>AC-1</acceptance_checks>
      </decision>
    </planning_decisions>
  </project_specification>`
  assert.throws(() => parseProjectSpecification(missingTopic), /architectural-tradeoff/)

  const badLink = `<project_specification>
    <project_goal>Goal</project_goal>
    ${baseChecks}
    <planning_decisions>
      <decision id="D-1" topic="ambiguous-requirement">
        <question>Who can publish?</question>
        <options>Anyone; signed-in only</options>
        <choice>Signed-in only</choice>
        <rationale>Matches auth model</rationale>
        <acceptance_checks>AC-404</acceptance_checks>
      </decision>
      <decision id="D-2" topic="architectural-tradeoff">
        <question>SQLite or Postgres?</question>
        <options>SQLite; Postgres</options>
        <choice>SQLite</choice>
        <rationale>Local smoke</rationale>
        <acceptance_checks>AC-1</acceptance_checks>
      </decision>
      <decision id="D-3" topic="edge-case">
        <question>Empty title?</question>
        <options>Reject; allow</options>
        <choice>Reject</choice>
        <rationale>No blank notes</rationale>
        <acceptance_checks>AC-2</acceptance_checks>
      </decision>
    </planning_decisions>
  </project_specification>`
  assert.throws(() => parseProjectSpecification(badLink), /unknown acceptance check AC-404/)

  const ok = `<project_specification>
    <project_goal>Goal</project_goal>
    ${baseChecks}
    <planning_decisions>
      <decision id="D-1" topic="ambiguous-requirement">
        <question>Who can publish?</question>
        <options>Anyone; signed-in only</options>
        <choice>Signed-in only</choice>
        <rationale>Matches auth model</rationale>
        <acceptance_checks>AC-1</acceptance_checks>
      </decision>
      <decision id="D-2" topic="architectural-tradeoff">
        <question>SQLite or Postgres?</question>
        <options>SQLite; Postgres</options>
        <choice>SQLite</choice>
        <rationale>Local smoke</rationale>
        <acceptance_checks>AC-1</acceptance_checks>
      </decision>
      <decision id="D-3" topic="edge-case">
        <question>Empty title?</question>
        <options>Reject; allow</options>
        <choice>Reject</choice>
        <rationale>No blank notes</rationale>
        <acceptance_checks>AC-2</acceptance_checks>
      </decision>
    </planning_decisions>
  </project_specification>`
  const parsed = parseProjectSpecification(ok)
  assert.equal(parsed.planningDecisions.present, true)
  assert.equal(parsed.planningDecisions.decisions.length, 3)
})

test('validateDependencyGraph rejects unknown Work Item deps and cycles', () => {
  const checks = [{ id: 'AC-1', dependsOn: [] }]
  const unknownCatalog = [{ id: 'WI-1', acceptance_checks: ['AC-1'], depends_on: ['AC-404'] }]
  assert.throws(
    () => validateDependencyGraph(checks, unknownCatalog),
    /depends_on unknown id AC-404/,
  )

  const cyclicCatalog = [
    { id: 'WI-1', acceptance_checks: ['AC-1'], depends_on: ['WI-2'] },
    { id: 'WI-2', acceptance_checks: ['AC-1'], depends_on: ['WI-1'] },
  ]
  assert.throws(
    () => validateDependencyGraph(checks, cyclicCatalog),
    /work item dependency cycle/,
  )
})

test('resolveProjectTopology uses flat control root for repo root', () => {
  withoutIntegrationBranchEnv(() => {
    const root = mkdtempSync(join(tmpdir(), 'topology-root-'))
    spawnSync('git', ['init', '-b', 'main'], { cwd: root })
    const topology = resolveProjectTopology(root)
    assert.equal(topology.projectId, 'root')
    assert.match(topology.controlRoot, /harness-control$/)
    assert.doesNotMatch(topology.controlRoot, /harness-control\/root$/)
  })
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

test('browser cleanup is a no-op without scoped identifiers', () => {
  assert.deepEqual(cleanupBrowserOrphans({}), { killed: 0 })
  assert.deepEqual(cleanupBrowserOrphans(), { killed: 0 })
})

test('feature prompts require resource cleanup before verdict', async () => {
  const { featurePrompt, RESOURCE_CLEANUP_RULE, NO_REDELEGATE_RULE } = await import('../skills/generator/prompts/feature.mjs')
  assert.match(RESOURCE_CLEANUP_RULE, /RESOURCE CLEANUP/)
  assert.match(RESOURCE_CLEANUP_RULE, /docker compose down/)
  assert.match(NO_REDELEGATE_RULE, /assigned harness worker/)
  assert.match(NO_REDELEGATE_RULE, /Do NOT spawn Task/)
  const feature = { id: 'WI-1', context: 'core', description: 'x', acceptance_checks: ['AC-1'] }
  for (const kind of ['CODING', 'QA', 'INTEGRATION_QA']) {
    const prompt = featurePrompt(kind, feature, 1, null, '/wt', { port: 5170, integrationBranch: 'plan/x' })
    assert.match(prompt, /RESOURCE CLEANUP/)
    assert.match(prompt, /docker compose down/)
    assert.match(prompt, /assigned harness worker|Do NOT spawn Task/)
  }
})

test('browser cleanup patterns stay scoped to port/workdir/profile', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'generator', 'lib', 'browser-cleanup.mjs'), 'utf8')
  assert.equal(source.includes('chromium.*--headless'), false)
  assert.equal(source.includes('playwright.*chromium'), false)
  assert.equal(source.includes('ms-playwright'), false)
})

test('worker lifecycle builds shared spawn argv for work items and goal review', () => {
  const claim = { context: 'core', worktree: '/wt/core', port: 5171, featureIds: ['WI-1'] }
  const workArgv = buildOrchestratorArgv({
    orchestrator: '/orch.mjs',
    repo: '/repo',
    host: 'claude',
    claim,
    guidance: 'fix it',
  })
  assert.ok(workArgv.includes('--features'))
  assert.ok(workArgv.includes('WI-1'))
  assert.equal(workArgv.includes('--mode'), false)

  const goalArgv = buildOrchestratorArgv({
    orchestrator: '/orch.mjs',
    repo: '/repo',
    host: 'claude',
    claim: { ...claim, context: 'goal-review', featureIds: [] },
    mode: 'goal-review',
  })
  assert.deepEqual(goalArgv.filter((part) => part === 'goal-review').length, 2)

  const base = buildWorkerBase({ claim, logFile: '/tmp/x.log', reservationId: 'r1' })
  assert.equal(base.ownedResources.port, 5171)
  assert.equal(base.ownedResources.worktree, '/wt/core')

  const herdr = planWorkerHerdrMeta({ claim, projectId: 'app', retry: 2 })
  assert.equal(herdr.agentName, 'worker-app-core')
  assert.equal(herdr.retry, 2)
})

test('worker lifecycle stop and cleanup plans cover herdr and background', () => {
  assert.equal(planWorkerStop(null).kind, 'noop')
  assert.equal(planWorkerStop({ type: 'herdr', paneId: 'w1:p2' }).kind, 'close_display')
  assert.equal(planWorkerStop({ type: 'background', child: { pid: 4242 } }).kind, 'terminate_tree')
  assert.deepEqual(planWorkerCleanupTargets({ port: 9, worktree: '/wt' }), {
    port: 9,
    workdir: '/wt',
    profileDir: null,
  })
  assert.equal(terminateProcessTree(null).terminated, false)
})

test('clearDeadLock removes absent merge lock as no-op', () => {
  withoutIntegrationBranchEnv(() => {
    const root = mkdtempSync(join(tmpdir(), 'dead-lock-'))
    spawnSync('git', ['init', '-b', 'main'], { cwd: root })
    assert.deepEqual(clearDeadLock(root, 'merge'), { cleared: false, reason: 'absent', lock: 'merge' })
  })
})

test('clearStaleGeneratorLocks clears a dead same-host merge lock', async () => {
  const { clearStaleGeneratorLocks, mergeLockHolder } = await import('../skills/generator/lib/claim-lease.mjs')
  const { hostname } = await import('node:os')
  withoutIntegrationBranchEnv(() => {
    const root = mkdtempSync(join(tmpdir(), 'stale-locks-'))
    spawnSync('git', ['init', '-b', 'main'], { cwd: root })
    const lockDir = join(root, '.git', 'harness-locks', 'generator-merge')
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(join(lockDir, 'owner'), '999999999\n')
    writeFileSync(join(lockDir, 'host'), `${hostname()}\n`)
    assert.equal(mergeLockHolder(root).busy, true)
    const cleared = clearStaleGeneratorLocks(root)
    assert.ok(cleared.some((row) => row.lock === 'merge' && row.cleared))
    assert.equal(mergeLockHolder(root).busy, false)
  })
})

test('clearStaleGeneratorLocks leaves a live-held merge lock alone', async () => {
  const { clearStaleGeneratorLocks, mergeLockHolder } = await import('../skills/generator/lib/claim-lease.mjs')
  const { hostname } = await import('node:os')
  withoutIntegrationBranchEnv(() => {
    const root = mkdtempSync(join(tmpdir(), 'live-locks-'))
    spawnSync('git', ['init', '-b', 'main'], { cwd: root })
    const lockDir = join(root, '.git', 'harness-locks', 'generator-merge')
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(join(lockDir, 'owner'), `${process.pid}\n`)
    writeFileSync(join(lockDir, 'host'), `${hostname()}\n`)
    const cleared = clearStaleGeneratorLocks(root)
    assert.equal(cleared.length, 0)
    assert.equal(mergeLockHolder(root).busy, true)
    assert.equal(String(mergeLockHolder(root).owner), String(process.pid))
  })
})

test('authorizeFleetRecovery allows recovery when supervisor is not live', async () => {
  const { authorizeFleetRecovery } = await import('../skills/generator/lib/supervisor-lease.mjs')
  const controlRoot = mkdtempSync(join(tmpdir(), 'fleet-auth-'))
  const auth = await authorizeFleetRecovery(controlRoot, { state: {}, force: false })
  assert.equal(auth.authorized, true)
  assert.equal(auth.mode, 'recovery')
})

test('clearStaleSupervisorLock clears an absent lock', async () => {
  const { clearStaleSupervisorLock } = await import('../skills/generator/lib/supervisor-lease.mjs')
  const controlRoot = mkdtempSync(join(tmpdir(), 'fleet-lock-'))
  assert.deepEqual(await clearStaleSupervisorLock(controlRoot), { cleared: false, reason: 'absent' })
})

test('browser cleanup is a no-op on win32', { skip: process.platform !== 'win32' }, () => {
  assert.deepEqual(cleanupBrowserOrphans({ port: 5170, workdir: '/tmp/wt' }), { killed: 0 })
})

test('browser cleanup returns a killed count on unix', { skip: process.platform === 'win32' }, () => {
  // Broad playwright patterns may match live browsers on a developer machine —
  // only assert the return shape, not a zero kill count.
  const result = cleanupBrowserOrphans({ port: 59999, workdir: '/tmp/harness-no-such-worktree-xyz' })
  assert.equal(typeof result.killed, 'number')
  assert.ok(result.killed >= 0)
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

test('visible herdr agent spawn flushes PTY output with script -f', async () => {
  const { visibleScriptArgv } = await import('../skills/generator/lib/agent-spawn.mjs')
  const [program, args] = visibleScriptArgv('pi', ['-p', 'hello'])
  assert.equal(program, 'script')
  assert.deepEqual(args.slice(0, 3), ['-q', '-e', '-f'])
  assert.equal(args[3], '-c')
  assert.match(args[4], /^'pi' '-p' 'hello'$/)
  assert.equal(args[5], '/dev/null')
})

test('pi herdr stream uses --mode json and formats thinking/tools', async () => {
  const { withVisibleAgentMode, createAgentStreamFormatter } = await import('../skills/generator/lib/agent-stream.mjs')
  assert.deepEqual(
    withVisibleAgentMode('pi', ['--model', 'x', '-p', 'hi'], true),
    ['--model', 'x', '--mode', 'json', '-p', 'hi'],
  )
  assert.deepEqual(withVisibleAgentMode('pi', ['-p', 'hi'], false), ['-p', 'hi'])
  assert.deepEqual(withVisibleAgentMode('codex', ['exec', 'hi'], true), ['exec', 'hi'])

  const fmt = createAgentStreamFormatter()
  const pane = [
    fmt.push(`${JSON.stringify({ type: 'agent_start' })}\n`),
    fmt.push(`${JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'plan the next verification steps carefully ' } })}\n`),
    fmt.push(`${JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end', content: 'plan the next verification steps carefully then run tools' } })}\n`),
    fmt.push(`${JSON.stringify({ type: 'tool_execution_start', toolName: 'bash' })}\n`),
    fmt.push(`${JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '===HARNESS-VERDICT-BEGIN===\n{"ok":true}\n===HARNESS-VERDICT-END===\n' } })}\n`),
    fmt.flush(),
  ].join('')
  assert.match(pane, /agent: working/)
  assert.match(pane, /thinking: plan the next verification steps carefully then run tools/)
  assert.match(pane, /tool → bash/)
  assert.match(pane, /HARNESS-VERDICT-BEGIN/)
  assert.match(fmt.assistantText(), /"ok":true/)
})

test('parseObject reports complete vs open verdict', async () => {
  const { parseObject, hasCompleteVerdict } = await import('../skills/generator/lib/verdict.mjs')
  const open = '===HARNESS-VERDICT-BEGIN===\n{"id":"x","ok":true}\n'
  const closed = `${open}===HARNESS-VERDICT-END===\n`
  assert.equal(hasCompleteVerdict(open), false)
  assert.equal(hasCompleteVerdict(closed), true)
  assert.equal(parseObject(closed).ok, true)
})

test('cursor agent herdr stream uses stream-json and formats thinking/tools', async () => {
  const { withVisibleAgentMode, createAgentStreamFormatter } = await import('../skills/generator/lib/agent-stream.mjs')
  assert.deepEqual(
    withVisibleAgentMode('agent', ['-p', '--force', '--trust', '--model', 'composer-2.5', 'hi'], true),
    ['-p', '--output-format', 'stream-json', '--stream-partial-output', '--force', '--trust', '--model', 'composer-2.5', 'hi'],
  )
  assert.deepEqual(withVisibleAgentMode('agent', ['-p', 'hi'], false), ['-p', 'hi'])

  const fmt = createAgentStreamFormatter()
  const pane = [
    fmt.push(`${JSON.stringify({ type: 'system', subtype: 'init', model: 'Composer 2.5' })}\n`),
    fmt.push(`${JSON.stringify({ type: 'thinking', subtype: 'delta', text: 'plan the next verification steps carefully ' })}\n`),
    fmt.push(`${JSON.stringify({ type: 'thinking', subtype: 'completed' })}\n`),
    fmt.push(`${JSON.stringify({ type: 'tool_call', subtype: 'started', tool_call: { shellToolCall: { description: 'curl health' } } })}\n`),
  ]
  assert.equal(fmt.inFlightTool(), 'shell: curl health')
  pane.push(fmt.push(`${JSON.stringify({ type: 'tool_call', subtype: 'completed', tool_call: { shellToolCall: { description: 'curl health' } } })}\n`))
  assert.equal(fmt.inFlightTool(), null)
  pane.push(fmt.push(`${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '===HARNESS-VERDICT-BEGIN===\n{"ok":true}\n===HARNESS-VERDICT-END===\n' }] } })}\n`))
  pane.push(fmt.flush())
  const joined = pane.join('')
  assert.match(joined, /agent: working/)
  assert.match(joined, /thinking: plan the next verification steps carefully/)
  assert.match(joined, /tool → shell: curl health/)
  assert.match(joined, /tool ✓ shell: curl health/)
  assert.match(joined, /HARNESS-VERDICT-BEGIN/)
  assert.match(fmt.assistantText(), /"ok":true/)
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

test('unionAppendOnly keeps both journal sides', () => {
  assert.equal(unionAppendOnly('a\n', 'a\nb\n'), 'a\nb\n')
  assert.equal(unionAppendOnly('# h\n\n## one\n', '# h\n\n## two\n'), '# h\n\n## one\n# h\n\n## two\n')
  assert.equal(unionAppendOnly('', 'only\n'), 'only\n')
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

function baseSnapshot({ total = 1, integrated = 0, items = null } = {}) {
  const queue = items || Array.from({ length: total }, (_, i) => ({ id: `WI-${i}` }))
  return { queue, counts: { total, integrated } }
}

test('planTickAdmission finalizes a pending goal once the retry queue is empty', () => {
  const plan = planTickAdmission({
    slots: 1, retryQueue: {}, recoverable: [], pendingGoalResult: { goal: true, summary: 'done' },
    snapshot: baseSnapshot(), activeWorkers: 0, hasGoalReviewWorker: false,
  })
  assert.deepEqual(plan, [{ type: 'finalize_goal', result: { goal: true, summary: 'done' } }])
})

test('planTickAdmission waits when a pending goal still has a non-empty retry queue', () => {
  const plan = planTickAdmission({
    slots: 1, retryQueue: { core: { guidance: 'x', attempts: 1 } }, recoverable: [], pendingGoalResult: { goal: true },
    snapshot: baseSnapshot(), activeWorkers: 0, hasGoalReviewWorker: false,
  })
  assert.deepEqual(plan, [{ type: 'wait_pending_goal' }])
})

test('planTickAdmission starts Goal Review once the queue is fully integrated with a free slot', () => {
  const plan = planTickAdmission({
    slots: 1, retryQueue: {}, recoverable: [], pendingGoalResult: null,
    snapshot: baseSnapshot({ total: 2, integrated: 2 }), activeWorkers: 0, hasGoalReviewWorker: false,
  })
  assert.deepEqual(plan, [{ type: 'start_goal_review' }])
})

test('planTickAdmission does not gate Goal Review behind an active worker or an existing goal-review worker', () => {
  const integrated = baseSnapshot({ total: 1, integrated: 1 })
  assert.deepEqual(
    planTickAdmission({ slots: 1, retryQueue: {}, recoverable: [], pendingGoalResult: null, snapshot: integrated, activeWorkers: 1, hasGoalReviewWorker: false }),
    [{ type: 'claim_new' }],
  )
  assert.deepEqual(
    planTickAdmission({ slots: 1, retryQueue: {}, recoverable: [], pendingGoalResult: null, snapshot: integrated, activeWorkers: 0, hasGoalReviewWorker: true }),
    [{ type: 'claim_new' }],
  )
  assert.deepEqual(
    planTickAdmission({ slots: 0, retryQueue: {}, recoverable: [], pendingGoalResult: null, snapshot: integrated, activeWorkers: 0, hasGoalReviewWorker: false }),
    [{ type: 'claim_new' }],
  )
})

test('planTickAdmission resumes recoverable claims in order before claiming new work', () => {
  const plan = planTickAdmission({
    slots: 2, retryQueue: {}, recoverable: [{ context: 'alpha' }, { context: 'beta' }], pendingGoalResult: null,
    snapshot: baseSnapshot({ total: 2, integrated: 0 }), activeWorkers: 0, hasGoalReviewWorker: false,
  })
  assert.deepEqual(plan, [
    { type: 'resume', context: 'alpha' },
    { type: 'resume', context: 'beta' },
    { type: 'claim_new' },
  ])
})

test('planTickAdmission always ends with claim_new when nothing else is recoverable', () => {
  const plan = planTickAdmission({
    slots: 3, retryQueue: {}, recoverable: [], pendingGoalResult: null,
    snapshot: baseSnapshot({ total: 1, integrated: 0 }), activeWorkers: 0, hasGoalReviewWorker: false,
  })
  assert.deepEqual(plan, [{ type: 'claim_new' }])
})

test('goalReviewGate returns structured reasons from completion-contract', () => {
  const catalog = [{ id: 'WI-1', implementation: true, qa: true, integration: true }]
  assert.deepEqual(
    goalReviewContract({ catalog, activeWorkers: 0, slots: 1, hasGoalReviewWorker: false }),
    { ok: true, reason: 'admissible' },
  )
  assert.deepEqual(goalReviewContract({ catalog: [], activeWorkers: 0 }), { ok: false, reason: 'empty-queue' })
  assert.deepEqual(goalReviewContract({ catalog, activeWorkers: 1 }), { ok: false, reason: 'active-workers' })
  assert.deepEqual(goalReviewContract({ catalog, activeWorkers: 0, slots: 0 }), { ok: false, reason: 'no-slot' })
  assert.deepEqual(
    goalReviewContract({ catalog, activeWorkers: 0, slots: 1, hasGoalReviewWorker: true }),
    { ok: false, reason: 'goal-review-running' },
  )
  assert.deepEqual(goalReviewContract({ catalog, activeWorkers: 0, cleanCheckout: false }), { ok: false, reason: 'dirty-checkout' })
  assert.deepEqual(
    goalReviewContract({
      catalog,
      activeWorkers: 0,
      integrationHead: 'abc',
      reviewedHead: 'abc',
      status: 'complete',
    }),
    { ok: false, reason: 'already-reviewed-head' },
  )
  assert.deepEqual(
    goalReviewContract({
      catalog: [{ id: 'WI-1', implementation: true, qa: true, integration: true, blocked: true }],
      activeWorkers: 0,
      counts: { total: 1, integrated: 1 },
    }),
    { ok: false, reason: 'blocked-items' },
  )
  assert.deepEqual(
    goalReviewContract({
      catalog: [{ id: 'WI-1', implementation: true, qa: false, integration: false }],
      activeWorkers: 0,
      counts: { total: 1, integrated: 0 },
    }),
    { ok: false, reason: 'incomplete-queue' },
  )
})

test('goalReviewAdmissible boolean adapter covers fleet gates and already-reviewed-head short-circuit', () => {
  const integrated = baseSnapshot({ total: 1, integrated: 1 })
  assert.equal(goalReviewAdmissible({ snapshot: integrated, activeWorkers: 0, slots: 1, hasGoalReviewWorker: false }), true)
  assert.equal(goalReviewAdmissible({ snapshot: baseSnapshot({ total: 1, integrated: 0 }), activeWorkers: 0, slots: 1, hasGoalReviewWorker: false }), false)
  assert.equal(goalReviewAdmissible({ snapshot: { queue: [], counts: { total: 0, integrated: 0 } }, activeWorkers: 0, slots: 1, hasGoalReviewWorker: false }), false)
  assert.equal(
    goalReviewAdmissible({
      snapshot: integrated,
      activeWorkers: 0,
      slots: 1,
      hasGoalReviewWorker: false,
      integrationHead: 'abc',
      reviewedHead: 'abc',
      status: 'complete',
    }),
    true,
  )
  assert.equal(goalReviewGate({
    catalog: integrated.queue,
    counts: integrated.counts,
    integrationHead: 'abc',
    reviewedHead: 'abc',
    status: 'complete',
  }).reason, 'already-reviewed-head')
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
  const { candidates } = buildCandidates({
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

test('route-plan noCredits tier only for CODING after paid pool', () => {
  const roles = {
    coding: [{ harness: 'claude' }, { harness: 'codex' }],
    validation: [{ harness: 'claude' }],
    repairPlanning: [{ harness: 'claude' }],
    goalReview: [{ harness: 'claude' }],
    noCredits: [{ harness: 'opencode', model: 'free' }],
  }
  const plan = { roles, sortedRoles: roles, strikes: {} }
  const codingPool = candidatePool({ plan, kind: 'CODING', attempt: 1, roleNames: { CODING: 'coding' } })
  assert.equal(codingPool.length, 3)
  assert.equal(codingPool.at(-1).model, 'free')
  const qaPool = candidatePool({ plan, kind: 'QA', attempt: 1, roleNames: { QA: 'validation' } })
  assert.equal(qaPool.length, 1)
  assert.equal(isNoCreditsCandidate({ harness: 'opencode', model: 'free' }, roles), true)
  assert.equal(isNoCreditsCandidate({ harness: 'claude' }, roles), false)
})

test('failure-policy denies durable approval cases and auto-retry', () => {
  assert.equal(requiresDurableApproval('QA failed after Attempt 3'), true)
  assert.equal(requiresDurableApproval('Integrated Verification failed after Attempt 3'), true)
  assert.equal(requiresDurableApproval('Claim Lease is stale on another host'), true)
  assert.equal(requiresDurableApproval('Worker exited with code 1'), false)

  const blocked = authorizeRecovery({
    failureClass: 'product',
    safeRecovery: 'repair_plan',
    reason: 'coding agent failed three times',
    auto: true,
  })
  assert.equal(blocked.allowed, false)
  assert.equal(blocked.requiresInputRequest, true)

  const allowed = recoveryDecision({
    reason: 'Worker exited with code 1',
    scope: 'context',
    auto: true,
  })
  assert.equal(allowed.allowed, true)
  assert.equal(allowed.action, 'retry')
  assert.equal(isAutoRetryableReason('integration could not complete'), true)
  assert.equal(isAutoRetryableReason('QA failed after Attempt 3'), false)
})

test('classifyFailure unifies quota, infra, and observation_mismatch with repair-router recovery', () => {
  const quota = classifyFailure({ reason: '429 rate limit exceeded' })
  assert.equal(quota.class, 'quota')
  assert.equal(quota.safeRecovery, 'provider_cooldown')

  const infra = classifyFailure({ reason: 'DynamoHypothesisRepository still wired in bootstrap' })
  assert.equal(infra.class, 'infra')
  assert.equal(infra.safeRecovery, 'block')

  const auth = classifyFailure({ reason: 'API key unauthorized' })
  assert.equal(auth.class, 'infra')
  assert.equal(auth.safeRecovery, 'block')

  const observation = classifyFailure({
    defectClass: 'observation_mismatch',
    reason: 'grep-only audit should not start a server',
  })
  assert.equal(observation.class, 'observation_mismatch')
  assert.equal(observation.safeRecovery, 'repair_plan')
})

test('worker-result fences stale invocation and validates verdicts', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'worker-result-'))
  const stateFile = join(tmp, 'core.json')
  await writeWorkerResult(stateFile, {
    invocationId: 'inv-a',
    leaseToken: 'lease-a',
    payload: { total: 1, passed: 1, stuck: [] },
  })
  const scoped = await readWorkerResult(stateFile, {
    expectedInvocationId: 'inv-a',
    expectedLeaseToken: 'lease-a',
  })
  assert.equal(scoped.passed, 1)
  const staleInvocation = await readWorkerResult(stateFile, {
    expectedInvocationId: 'inv-b',
    expectedLeaseToken: 'lease-a',
  })
  assert.equal(staleInvocation, null)
  const staleLease = await readWorkerResult(stateFile, {
    expectedInvocationId: 'inv-a',
    expectedLeaseToken: 'lease-b',
  })
  assert.equal(staleLease, null)

  const goal = validateWorkerVerdict({ goal: true, summary: 'done' })
  assert.equal(goal.valid, true)
  assert.equal(goal.mode, 'goalReview')
  const bad = validateWorkerVerdict({ goal: 'yes' })
  assert.equal(bad.valid, false)
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
    commonGit: join(tmp, '.git'),
    projectId: '',
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

test('createWorkflowState overlays ledger progress without mutating feature_list.json', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'workflow-state-ledger-'))
  mkdirSync(join(tmp, '.git', 'harness-ledger'), { recursive: true })
  const catalog = [{
    id: 'WI-1',
    context: 'core',
    description: 'demo',
    acceptance_checks: ['AC-1'],
    depends_on: [],
    implementation: false,
    qa: false,
    integration: false,
    retries: 0,
  }]
  writeFileSync(join(tmp, 'feature_list.json'), `${JSON.stringify(catalog, null, 2)}\n`)
  const wf = createWorkflowState({
    stateFile: join(tmp, 'state.json'),
    leaseToken: 'test-lease',
    context: 'core',
    commonGit: join(tmp, '.git'),
    projectId: '',
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

  const before = JSON.parse(readFileSync(join(tmp, 'feature_list.json'), 'utf8'))
  await wf.updateFeature(tmp, 'WI-1', { implementation: true, qa: true, retries: 1 })
  const afterCatalog = JSON.parse(readFileSync(join(tmp, 'feature_list.json'), 'utf8'))
  assert.deepEqual(afterCatalog, before)

  const ledger = await readLedger(ledgerPath(join(tmp, '.git'), ''))
  assert.equal(ledger.items['WI-1'].implementation, true)
  assert.equal(ledger.items['WI-1'].qa, true)
  assert.equal(ledger.items['WI-1'].retries, 1)

  const { list } = await wf.readFeatures(tmp)
  assert.equal(list[0].implementation, true)
  assert.equal(list[0].qa, true)
  assert.equal(list[0].retries, 1)
  assert.deepEqual(applyLedgerToCatalog(catalog, ledger)[0], list[0])
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

test('planAutoRetryResponses queues retry for stalled context inputs only', () => {
  const pending = {
    10: { status: 'pending', scope: 'context', context: 'stale', reason: 'Worker exited with code 1' },
    11: { status: 'pending', scope: 'context', context: 'live', reason: 'integration could not complete' },
    12: { status: 'pending', scope: 'goal', context: null, reason: 'goal needs human' },
    13: { status: 'pending', scope: 'context', context: 'exhausted', reason: 'coding agent failed three times' },
  }
  assert.equal(isAutoRetryableInput(pending[10]), true)
  assert.equal(isAutoRetryableInput(pending[12]), false)
  // Coding exhaustion must not auto-burn; needs operator/Repair Plan guidance.
  assert.equal(isAutoRetryableInput(pending[13]), false)
  const attempt3 = { status: 'pending', scope: 'context', context: 'core', reason: 'QA failed after Attempt 3' }
  assert.equal(isAutoRetryableInput(attempt3), false)
  assert.equal(isAutoRetryableReason('Claim Lease is stale on another host'), false)
  const goalReviewExit = {
    status: 'pending',
    scope: 'goal',
    context: null,
    reason: 'Worker exited with code 1',
    detail: { log: '/tmp/goal-review-123.log' },
  }
  assert.equal(isAutoRetryableInput(goalReviewExit), true)
  const planned = planAutoRetryResponses(pending, {
    workers: new Set(['live']),
    retryQueue: {},
    crashCounts: { exhausted: 5 },
  })
  assert.deepEqual(planned.map((item) => item.eventId).sort(), [10])
  assert.equal(planned[0].response.action, 'retry')
  assert.equal(planned[0].response.auto, true)

  const withQueued = planAutoRetryResponses({
    20: { status: 'pending', scope: 'context', context: 'stale', reason: 'Worker exited with code 1' },
  }, {
    workers: new Set(),
    retryQueue: { stale: { guidance: 'Custom operator guidance for AC-025', attempts: 0 } },
    crashCounts: {},
  })
  // Already queued contexts are skipped entirely (resumeClaim will drain retryQueue).
  assert.deepEqual(withQueued, [])
})

test('buildHostCommand passes model to pi and agent', async () => {
  const { buildHostCommand } = await import('../skills/generator/adapters/hosts.mjs')
  assert.deepEqual(
    buildHostCommand('pi', 'do work', 'anthropic/claude-opus-4-8:xhigh'),
    ['pi', ['--model', 'anthropic/claude-opus-4-8:xhigh', '-p', 'do work']],
  )
  assert.deepEqual(
    buildHostCommand('agent', 'do work', 'grok-4.5-xhigh'),
    ['agent', ['-p', '--force', '--trust', '--sandbox', 'disabled', '--model', 'grok-4.5-xhigh', 'do work']],
  )
  assert.deepEqual(
    buildHostCommand('agent', 'do work'),
    ['agent', ['-p', '--force', '--trust', '--sandbox', 'disabled', 'do work']],
  )
})

test('worker-health classifies merge lock, verdict hang, and thinking', async () => {
  const {
    classifyPaneTail, assessWorkerHealth, paneReadSource,
  } = await import('../skills/generator/lib/worker-health.mjs')
  assert.equal(classifyPaneTail('orchestrator: waiting for merge lock (holder pid=1)'), 'merge_lock')
  assert.equal(classifyPaneTail('thinking: next step\ntool → read'), 'tooling')
  assert.equal(classifyPaneTail('===HARNESS-VERDICT-END===\nagent: still working (20s since last log)'), 'verdict_hung')
  // Prior tool lines in the same window must not mask a post-verdict hang.
  assert.equal(classifyPaneTail([
    'tool → shell: Run AC-019',
    'tool ✓ shell: Run AC-019',
    'thinking: returning verdict',
    '===HARNESS-VERDICT-BEGIN===',
    '{"resolved":true,"notes":"ok"}',
    'agent: still working (35s since last log)',
  ].join('\n')), 'verdict_hung')
  assert.equal(paneReadSource(0), 'visible')
  assert.equal(paneReadSource(12), 'recent')

  const waiting = assessWorkerHealth({
    tailText: 'orchestrator: waiting for merge lock…',
    mergeHolderAlive: true,
    childAlive: false,
    runStateAgeMs: 120_000,
  })
  assert.equal(waiting.verdict, 'waiting_expected')
  assert.equal(waiting.recycle, false)

  const stuckLock = assessWorkerHealth({
    tailText: 'orchestrator: waiting for merge lock…',
    mergeHolderAlive: false,
    childAlive: false,
    runStateAgeMs: 120_000,
  })
  assert.equal(stuckLock.verdict, 'stuck')

  const healthy = assessWorkerHealth({
    tailText: 'thinking: working\ntool → shell',
    scrollDelta: 3,
    childAlive: true,
    lastAgentOutputAgeMs: 5_000,
  })
  assert.equal(healthy.verdict, 'healthy')
})

test('repair-router blocks coding exhaustion and routes quota/infra', async () => {
  const { inferDefectClass, routeRepair, routePendingInput } = await import('../skills/generator/lib/repair-router.mjs')
  assert.equal(inferDefectClass({}, 'Codex error: The usage limit has been reached'), 'quota')
  assert.equal(inferDefectClass({}, 'DynamoHypothesisRepository still wired in bootstrap'), 'infra')
  assert.equal(inferDefectClass({ defectClass: 'observation_mismatch' }, ''), 'observation_mismatch')

  const exhausted = routePendingInput({ reason: 'coding agent failed three times' })
  assert.equal(exhausted.action, 'pause')
  assert.equal(exhausted.autoRetry, false)

  const quota = routeRepair({ defectClass: 'quota' })
  assert.equal(quota.action, 'switch_candidate')
  assert.equal(quota.autoRetry, true)

  const infra = routeRepair({ defectClass: 'infra' })
  assert.equal(infra.action, 'block')
  assert.equal(infra.autoRetry, false)
})

test('observation-method filters pi away for http/browser validation', async () => {
  const {
    inferObservationMethod, filterCandidatesForObservation, needsStrongValidationHost,
    observationGateFailure,
  } = await import('../skills/generator/lib/observation-method.mjs')
  assert.equal(inferObservationMethod({ category: 'static', description: 'grep for LICENSE' }), 'grep')
  assert.equal(inferObservationMethod({
    category: 'functional',
    description: 'GET /api/v1/investigation/:id/stream emits SSE events',
  }), 'http')
  assert.equal(inferObservationMethod({
    description: 'The dashboard SPA at /dashboard renders; clicking an incident opens detail',
  }), 'browser')
  assert.equal(needsStrongValidationHost(['http']), true)

  const candidates = [
    { harness: 'pi', model: 'x' },
    { harness: 'agent', model: 'composer-2.5' },
    { harness: 'codex', model: 'gpt-5.5' },
  ]
  const filtered = filterCandidatesForObservation(candidates, ['http'], 'INTEGRATION_QA')
  assert.equal(filtered[0].harness, 'agent')
  assert.ok(!filtered.some((c) => c.harness === 'pi'))

  const piOnly = filterCandidatesForObservation([{ harness: 'pi', model: 'x' }], ['http'], 'INTEGRATION_QA')
  assert.deepEqual(piOnly, [])
  const gate = observationGateFailure(['http'], 'INTEGRATION_QA', [{ harness: 'pi', model: 'x' }], piOnly)
  assert.equal(gate.ok, false)
  assert.match(gate.reason, /Observation Hard Gate/)

  const codingFiltered = filterCandidatesForObservation(candidates, ['http'], 'CODING')
  assert.deepEqual(codingFiltered, candidates)
})

test('route-plan buildCandidates fails closed when only weak validation hosts remain', () => {
  const roles = {
    coding: [{ harness: 'opencode' }],
    validation: [{ harness: 'pi', model: 'glm' }],
    repairPlanning: [{ harness: 'claude' }],
    goalReview: [{ harness: 'claude' }],
  }
  const plan = { roles, sortedRoles: roles, strikes: {} }
  const { candidates, gateFailure } = buildCandidates({
    plan,
    kind: 'QA',
    attempt: 1,
    options: {},
    roleNames: { QA: 'validation' },
    codedBy: 'opencode',
    state: {},
    observationMethods: ['http'],
  })
  assert.deepEqual(candidates, [])
  assert.equal(gateFailure.ok, false)
  assert.match(gateFailure.reason, /Observation Hard Gate/)
})

test('coding prompt soft-aligns to grep-only observation methods', async () => {
  const { featurePrompt } = await import('../skills/generator/prompts/feature.mjs')
  const feature = {
    id: 'WI-1',
    context: 'core',
    description: 'grep LICENSE',
    acceptance_checks: ['AC-1'],
    observation_methods: ['grep'],
  }
  const prompt = featurePrompt('CODING', feature, 1, null, '/wt', { port: 5170 })
  assert.match(prompt, /grep audit/i)
  assert.doesNotMatch(prompt, /Bring up the app on the assigned ports and run black-box behavior tests\./)
})

test('control journal fails closed on corrupt JSONL', async () => {
  const { readControlEvents, appendControlEvent } = await import('../skills/generator/lib/control-journal.mjs')
  const tmp = mkdtempSync(join(tmpdir(), 'journal-corrupt-'))
  const eventsFile = join(tmp, 'events.jsonl')
  writeFileSync(eventsFile, '{"id":1,"kind":"run_started"}\n{broken\n')
  await assert.rejects(
    () => readControlEvents(tmp, eventsFile),
  )
  const goodRoot = mkdtempSync(join(tmpdir(), 'journal-good-'))
  await appendControlEvent(goodRoot, { kind: 'run_started', runId: 'r1' })
  const events = await readControlEvents(goodRoot, join(goodRoot, 'events.jsonl'))
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'run_started')
})

test('control journal compaction preserves pending input lineage', async () => {
  const {
    appendControlEvent, readControlEvents, compactControlJournal, deriveSnapshot,
  } = await import('../skills/generator/lib/control-journal.mjs')
  const root = mkdtempSync(join(tmpdir(), 'journal-compact-'))
  for (let i = 0; i < 60; i++) {
    await appendControlEvent(root, { kind: 'progress', workers: i })
  }
  const input = await appendControlEvent(root, {
    kind: 'input_required', scope: 'context', context: 'core', reason: 'blocked', choices: ['retry'],
  })
  const eventsBefore = await readControlEvents(root, join(root, 'events.jsonl'))
  assert.equal(eventsBefore.length, 61)
  const compacted = await compactControlJournal(root, { minTail: 10 })
  assert.equal(compacted.compacted, true)
  const eventsAfter = await readControlEvents(root, join(root, 'events.jsonl'))
  assert.ok(eventsAfter.some((event) => event.id === input.id && event.kind === 'input_required'))
  const derived = deriveSnapshot(eventsAfter)
  assert.equal(derived.pendingInputs[input.id].status, 'pending')
})

test('control journal ignores caller id and keeps latest duplicate', async () => {
  const {
    appendControlEvent, readControlEvents, maxRawEventIdFromText,
  } = await import('../skills/generator/lib/control-journal.mjs')
  const root = mkdtempSync(join(tmpdir(), 'journal-id-'))
  const first = await appendControlEvent(root, { kind: 'worker_started', id: 999, context: 'a' })
  const second = await appendControlEvent(root, { kind: 'input_required', id: first.id, context: 'a', choices: ['retry'] })
  assert.equal(first.id, 1)
  assert.equal(second.id, 2)
  assert.notEqual(second.id, 999)
  const eventsFile = join(root, 'events.jsonl')
  // Simulate a corrupt recycled-id tail (old bug) and ensure read keeps the newest.
  appendFileSync(eventsFile, `${JSON.stringify({
    id: 1, kind: 'input_required', context: 'a', reason: 'latest', choices: ['retry'],
  })}\n`)
  const events = await readControlEvents(root, eventsFile)
  const one = events.find((event) => event.id === 1)
  assert.equal(one.kind, 'input_required')
  assert.equal(one.reason, 'latest')
  assert.equal(maxRawEventIdFromText(readFileSync(eventsFile, 'utf8')), 2)
})

test('resource governor prunes dead-pid reservations and reuses context', async () => {
  const { requestAdmission, observeCapacity, releaseAdmission } = await import('../skills/generator/lib/resource-governor.mjs')
  const tmp = mkdtempSync(join(tmpdir(), 'governor-dead-'))
  const commonGit = join(tmp, '.git')
  mkdirSync(join(commonGit, 'harness-governor'), { recursive: true })
  const file = join(commonGit, 'harness-governor', 'reservations.json')
  writeFileSync(file, `${JSON.stringify({
    version: 1,
    reservations: {
      ghost: {
        id: 'ghost', projectId: 'core', context: 'remediation', provider: 'agent',
        host: 'test', pid: 99999999, at: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    },
    providers: {},
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`)
  const governorOpts = {
    maxWorkers: 2,
    quotaWorkers: 2,
    cpuPerWorker: 1,
    // Keep memory tiny so low-free-RAM CI runners (macOS) still have memory slots;
    // this test is about dead-pid pruning and same-context reuse, not load shedding.
    memoryPerWorkerMb: 1,
    reserveMemoryMb: 0,
    maxLoadRatio: 100,
  }
  const observed = await observeCapacity(commonGit, governorOpts)
  // Dead pid must not count toward active workers after prune-on-admit.
  const first = await requestAdmission(commonGit, {
    projectId: 'core', context: 'remediation', provider: 'agent',
    ...governorOpts,
  })
  assert.equal(first.granted, true)
  const second = await requestAdmission(commonGit, {
    projectId: 'core', context: 'remediation', provider: 'agent',
    ...governorOpts,
  })
  assert.equal(second.granted, true)
  assert.equal(second.reused, true)
  assert.equal(second.reservation.id, first.reservation.id)
  await releaseAdmission(commonGit, first.reservation.id)
  assert.ok(observed)
})

test('resource governor denies admission when full', async () => {
  const { requestAdmission, observeCapacity, releaseAdmission } = await import('../skills/generator/lib/resource-governor.mjs')
  const tmp = mkdtempSync(join(tmpdir(), 'governor-deny-'))
  const commonGit = join(tmp, '.git')
  mkdirSync(commonGit, { recursive: true })
  const opts = {
    maxWorkers: 1,
    quotaWorkers: 1,
    cpuPerWorker: 0.25,
    // Keep memory tiny so low-free-RAM CI runners (macOS) still have memory slots;
    // capacity denial under test is from maxWorkers/quotaWorkers, not host RAM.
    memoryPerWorkerMb: 1,
    reserveMemoryMb: 0,
    maxLoadRatio: 100,
  }
  const first = await requestAdmission(commonGit, { projectId: 'root', context: 'a', ...opts })
  assert.equal(first.granted, true)
  const second = await requestAdmission(commonGit, { projectId: 'root', context: 'b', ...opts })
  assert.equal(second.granted, false)
  assert.equal(second.reason, 'no-capacity')
  const observed = await observeCapacity(commonGit, opts)
  assert.equal(observed.slots, 0)
  await releaseAdmission(commonGit, first.reservation.id)
})

test('supervisor lease fences stale writers', async () => {
  const {
    acquireSupervisorLease, assertSupervisorLease, updateSupervisorLease, releaseSupervisorLease,
  } = await import('../skills/generator/lib/supervisor-lease.mjs')
  const root = mkdtempSync(join(tmpdir(), 'sup-lease-'))
  const first = await acquireSupervisorLease(root, { token: 'a', pid: process.pid, leaseSeconds: 30 })
  await assertSupervisorLease(root, { token: 'a', fenceGeneration: first.fenceGeneration })
  await assert.rejects(
    () => assertSupervisorLease(root, { token: 'a', fenceGeneration: first.fenceGeneration + 99 }),
    /refusing stale writer/,
  )
  await releaseSupervisorLease(root, 'a')
  await acquireSupervisorLease(root, { token: 'b', pid: process.pid, leaseSeconds: 30 })
  await assert.rejects(
    () => updateSupervisorLease(root, { token: 'a', fenceGeneration: first.fenceGeneration, status: 'running' }),
    /refusing stale writer/,
  )
})

test('evidence artifacts are create-only', async () => {
  const { putEvidenceArtifact } = await import('../skills/generator/lib/evidence-artifacts.mjs')
  const { open } = await import('node:fs/promises')
  const tmp = mkdtempSync(join(tmpdir(), 'evidence-create-only-'))
  const commonGit = join(tmp, '.git')
  mkdirSync(commonGit, { recursive: true })
  const first = await putEvidenceArtifact({
    commonGit,
    projectId: 'root',
    runId: 'run-1',
    context: 'core',
    workItemId: 'WI-1',
    attempt: 1,
    kind: 'http',
    detail: 'GET /health 200',
  })
  const second = await putEvidenceArtifact({
    commonGit,
    projectId: 'root',
    runId: 'run-1',
    context: 'core',
    workItemId: 'WI-1',
    attempt: 1,
    kind: 'http',
    detail: 'GET /health 200',
  })
  assert.equal(second.path, first.path)
  await assert.rejects(open(first.path, 'wx'), /EEXIST/)
})
