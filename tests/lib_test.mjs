import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, appendFileSync, chmodSync, existsSync, realpathSync } from 'node:fs'
import { readFile, writeFile as writeFileAsync, appendFile as appendFileAsync, mkdir as mkdirAsync } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { parseVerdict, isProviderQuotaLimited, VERDICT_BEGIN, VERDICT_END, isInfraNoise, stuckThresholdMs, interpretClosed } from '../skills/generator/lib/worker-outcome.mjs'
import { readyWorkItems, isWorkItemReady, validateDependencyGraph } from '../skills/generator/lib/ready-work-items.mjs'
import { parseProjectSpecification } from '../skills/generator/lib/project-specification.mjs'
import {
  resolveProjectRoot,
  resolveProjectTopology,
  readProjectsRegistry,
  upsertProject,
} from '../skills/generator/lib/project-topology.mjs'
import { claimKey, projectIdFromPrefix, resultFileFromRunState } from '../skills/generator/lib/project-keys.mjs'
import { pickClaimCandidate, mergeDo, restoreDirtyRuntimeLogs } from '../skills/generator/lib/claim-lease.mjs'
import { MARKER_PATTERN, hasMergeMarkers, unionAppendOnly } from '../skills/generator/lib/integrate-checkpoint.mjs'
import { drainRetryQueue, applyRetryResumeOutcome, shouldFinalizePendingGoal, nextTickDelay, tickWatchPaths } from '../skills/supervisor/lib/supervisor-tick.mjs'
import {
  planTickAdmission,
  goalReviewAdmissible,
  goalReviewGate,
  pruneOrphanPendingInputs,
  isCrashBoundContext,
  liveClaimContexts,
} from '../skills/supervisor/lib/supervisor-admission.mjs'
import { goalReviewAdmissible as goalReviewContract } from '../skills/generator/lib/completion-contract.mjs'
import {
  meaningfulCheckoutDirt,
  isCheckoutCleanForGoalReview,
} from '../skills/generator/lib/checkout-dirt.mjs'
import { mkey, strikeOf, buildPlan, buildCandidates, lastCoder, candidatePool, isNoCreditsCandidate } from '../skills/generator/lib/route-plan.mjs'
import {
  buildOrchestratorArgv,
  buildWorkerBase,
  planWorkerStop,
  planWorkerCleanupTargets,
  terminateProcessTree,
  processGroupForWorker,
  cleanupBrowserOrphans,
} from '../skills/generator/lib/worker-lifecycle.mjs'
import {
  authorizeRecovery,
  classifyFailure,
  inferDefectClass,
  isAutoRetryableInput,
  isAutoRetryableReason,
  planAutoRetryResponses,
  planWorkerClosedActions,
  requiresDurableApproval,
  recoveryDecision,
  routePendingInput,
  routeRepair,
  shouldEnqueueStuckWorkerRetry,
} from '../skills/generator/lib/failure-policy.mjs'
import {
  readDurable,
  validateOutcome,
  writeDurable,
} from '../skills/generator/lib/worker-outcome.mjs'
import { createWorkflowState } from '../skills/generator/lib/workflow-state.mjs'
import { applyLedgerToCatalog, readLedger, ledgerPath } from '../skills/generator/lib/execution-ledger.mjs'
import { readJson, atomicJson } from '../skills/generator/lib/fs-json.mjs'
import {
  integrationBranchName,
  DEFAULT_INTEGRATION_BRANCH,
  pinIntegrationBranchIfAbsent,
} from '../skills/generator/lib/integration-branch.mjs'
import { canonicalPath } from '../skills/generator/lib/canonical-path.mjs'
import { detectProjectBoundaries } from '../skills/setup/lib/detect-boundaries.mjs'
import {
  isLiveRunOwner,
  classifyRunStateHealth,
  listGhostClaims,
  abandonGhostRun,
  processAlive,
} from '../skills/supervisor/lib/orphan-claims.mjs'
import { runtimeView } from '../skills/supervisor/lib/runtime-view.mjs'
import { parseMeminfo, readHostResources } from '../skills/supervisor/lib/host-resources.mjs'
import { planRuntimeRecovery, shouldEmitEmptyFleet } from '../skills/supervisor/lib/fleet-snapshot.mjs'
import { appendOwnedRuntime, readOwnedRuntime } from '../skills/generator/lib/worktree-teardown.mjs'
import { mergeAcquire, mergeRelease, clearDeadLock } from '../skills/generator/lib/claim-lease.mjs'

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

test('parseVerdict reads delimited verdict', () => {
  const body = `${VERDICT_BEGIN}\n{"goal":true}\n${VERDICT_END}`
  assert.deepEqual(parseVerdict(body), { goal: true })
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

test('resolveProjectRoot finds the root spec from a subdirectory', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'resolve-root-')))
  spawnSync('git', ['init', '-b', 'main'], { cwd: root })
  writeFileSync(join(root, 'project_specs.xml'), '<project_specification/>\n')
  mkdirSync(join(root, 'a', 'b'), { recursive: true })
  assert.equal(resolveProjectRoot(join(root, 'a', 'b')), root)
  assert.equal(resolveProjectRoot(root), root)
})

test('resolveProjectRoot nearest spec wins over the root spec', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'resolve-nearest-')))
  spawnSync('git', ['init', '-b', 'main'], { cwd: root })
  writeFileSync(join(root, 'project_specs.xml'), '<project_specification/>\n')
  mkdirSync(join(root, 'packages', 'a', 'src'), { recursive: true })
  writeFileSync(join(root, 'packages', 'a', 'project_specs.xml'), '<project_specification/>\n')
  assert.equal(resolveProjectRoot(join(root, 'packages', 'a', 'src')), join(root, 'packages', 'a'))
  assert.equal(resolveProjectRoot(join(root, 'packages')), root)
})

test('resolveProjectRoot resolves a single registered project from an unrelated cwd', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'resolve-registry-')))
  spawnSync('git', ['init', '-b', 'main'], { cwd: root })
  mkdirSync(join(root, 'apps', 'web'), { recursive: true })
  mkdirSync(join(root, 'tools'), { recursive: true })
  writeFileSync(join(root, 'apps', 'web', 'project_specs.xml'), '<project_specification/>\n')
  mkdirSync(join(root, '.harness'), { recursive: true })
  writeFileSync(join(root, '.harness', 'projects.json'), `${JSON.stringify({ projects: [{ id: 'web', path: 'apps/web' }] })}\n`)
  assert.equal(resolveProjectRoot(join(root, 'tools')), join(root, 'apps', 'web'))
})

test('resolveProjectRoot throws on registry ambiguity listing every candidate', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'resolve-ambiguous-')))
  spawnSync('git', ['init', '-b', 'main'], { cwd: root })
  mkdirSync(join(root, 'apps', 'web'), { recursive: true })
  mkdirSync(join(root, 'apps', 'api'), { recursive: true })
  mkdirSync(join(root, 'tools'), { recursive: true })
  writeFileSync(join(root, 'apps', 'web', 'project_specs.xml'), '<project_specification/>\n')
  writeFileSync(join(root, 'apps', 'api', 'project_specs.xml'), '<project_specification/>\n')
  mkdirSync(join(root, '.harness'), { recursive: true })
  writeFileSync(join(root, '.harness', 'projects.json'), `${JSON.stringify({
    projects: [{ id: 'web', path: 'apps/web' }, { id: 'api', path: 'apps/api' }],
  })}\n`)
  assert.throws(
    () => resolveProjectRoot(join(root, 'tools')),
    /web \(apps\/web\), api \(apps\/api\); pass the project directory explicitly/,
  )
})

test('resolveProjectRoot throws when no spec exists up to the git root', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'resolve-none-')))
  spawnSync('git', ['init', '-b', 'main'], { cwd: root })
  mkdirSync(join(root, 'tools'), { recursive: true })
  assert.throws(
    () => resolveProjectRoot(join(root, 'tools')),
    /no project_specs\.xml found from .* up to .*; run \/planner or \/harness:setup first, or pass the project directory explicitly/,
  )
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
  assert.equal(isInfraNoise('orchestrator: cannot read feature_list.json'), true)
  assert.equal(isInfraNoise('QA failed after Attempt 3'), false)
})

test('stuck threshold default', () => {
  assert.equal(stuckThresholdMs(), 600_000)
})

test('browser cleanup is a no-op without scoped identifiers', () => {
  assert.deepEqual(cleanupBrowserOrphans({}), { killed: 0 })
  assert.deepEqual(cleanupBrowserOrphans(), { killed: 0 })
})

test('feature prompts require resource cleanup before verdict', async () => {
  const { featurePrompt, RESOURCE_CLEANUP_RULE, APP_START_RULE, NO_REDELEGATE_RULE } = await import('../skills/generator/prompts/feature.mjs')
  assert.match(RESOURCE_CLEANUP_RULE, /RESOURCE CLEANUP/)
  assert.match(RESOURCE_CLEANUP_RULE, /docker compose down/)
  assert.match(RESOURCE_CLEANUP_RULE, /\.\/init\.sh stop/)
  assert.match(APP_START_RULE, /APP START/)
  assert.match(APP_START_RULE, /\.\/init\.sh start/)
  assert.match(NO_REDELEGATE_RULE, /assigned harness worker/)
  assert.match(NO_REDELEGATE_RULE, /Do NOT spawn Task/)
  const feature = { id: 'WI-1', context: 'core', description: 'x', acceptance_checks: ['AC-1'] }
  for (const kind of ['CODING', 'QA', 'INTEGRATION_QA']) {
    const prompt = featurePrompt(kind, feature, 1, null, '/wt', { port: 5170, integrationBranch: 'plan/x' })
    assert.match(prompt, /RESOURCE CLEANUP/)
    assert.match(prompt, /APP START/)
    assert.match(prompt, /docker compose down/)
    assert.match(prompt, /\.\/init\.sh stop/)
    assert.match(prompt, /\.\/init\.sh start/)
    assert.match(prompt, /assigned harness worker|Do NOT spawn Task/)
  }
})

test('initializer documents init.sh lifecycle subcommands', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const templatePath = join(root, 'skills', 'generator', 'templates', 'init.sh')
  assert.ok(existsSync(templatePath), 'init.sh template must exist as SoT')
  const template = readFileSync(templatePath, 'utf8')
  assert.match(template, /start\|stop\|restart\|status\|help/)
  assert.match(template, /cmd_start|cmd_stop|cmd_status/)
  assert.match(template, /kill_process_tree/)
  assert.match(template, /start is not configured/)
  assert.doesNotMatch(template, /TODO\(stack\)[\s\S]*echo "Ready/)
  assert.match(template, /\.harness\/app\.pid/)
  const source = readFileSync(join(root, 'agents', 'initializer.md'), 'utf8')
  assert.match(source, /skills\/generator\/templates\/init\.sh/)
  assert.match(source, /\.harness\/app\.pid/)
  assert.match(source, /\.\/init\.sh start/)
})

test('init.sh template fails closed on unconfigured start stub', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const templatePath = join(repoRoot, 'skills', 'generator', 'templates', 'init.sh')
  const tmp = mkdtempSync(join(tmpdir(), 'init-template-'))
  writeFileSync(join(tmp, 'init.sh'), readFileSync(templatePath))
  chmodSync(join(tmp, 'init.sh'), 0o755)
  const run = spawnSync(join(tmp, 'init.sh'), ['start'], { cwd: tmp, encoding: 'utf8' })
  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /start is not configured/)
  assert.equal(run.stdout.includes('Ready'), false)
})

test('browser cleanup patterns stay scoped to port/workdir/profile', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'generator', 'lib', 'worker-lifecycle.mjs'), 'utf8')
  const fnStart = source.indexOf('export function cleanupBrowserOrphans')
  assert.ok(fnStart >= 0)
  const fnBody = source.slice(fnStart, fnStart + 800)
  assert.equal(fnBody.includes('chromium.*--headless'), false)
  assert.equal(fnBody.includes('playwright.*chromium'), false)
  assert.equal(fnBody.includes('ms-playwright'), false)
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
})

test('worker lifecycle stop and cleanup plans cover background workers', () => {
  assert.equal(planWorkerStop(null).kind, 'noop')
  assert.equal(planWorkerStop({ type: 'background', child: { pid: 4242 } }).kind, 'terminate_tree')
  assert.equal(processGroupForWorker(
    { type: 'background', pid: 333 },
    { ownerPid: 111, childPid: 222 },
  ), 333)
  assert.deepEqual(planWorkerCleanupTargets({ port: 9, worktree: '/wt' }), {
    port: 9,
    workdir: '/wt',
    profileDir: null,
    commonGit: null,
    projectId: null,
    context: null,
  })
  assert.deepEqual(planWorkerCleanupTargets({
    port: 9,
    worktree: '/wt',
    context: 'dashboard',
    commonGit: '/git',
    projectId: 'web',
    ownedResources: { port: 9, worktree: '/wt', commonGit: '/git', projectId: 'web', context: 'dashboard' },
  }), {
    port: 9,
    workdir: '/wt',
    profileDir: null,
    commonGit: '/git',
    projectId: 'web',
    context: 'dashboard',
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
  const { authorizeFleetRecovery } = await import('../skills/supervisor/lib/supervisor-lease.mjs')
  const controlRoot = mkdtempSync(join(tmpdir(), 'fleet-auth-'))
  const auth = await authorizeFleetRecovery(controlRoot, { state: {}, force: false })
  assert.equal(auth.authorized, true)
  assert.equal(auth.mode, 'recovery')
})

test('clearStaleSupervisorLock clears an absent lock', async () => {
  const { clearStaleSupervisorLock } = await import('../skills/supervisor/lib/supervisor-lease.mjs')
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

test('merge lock writes BUSY on stdout when contended', () => {
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
    ], { encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr || child.stdout)
    assert.match(child.stdout, /^BUSY/m)
    mergeRelease(root, process.pid)
  })
})

test('mergeAcquire anchors the integration worktree as a gitRoot sibling for a subproject', () => {
  withoutIntegrationBranchEnv(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'merge-anchor-')))
    spawnSync('git', ['init', '-b', 'main'], { cwd: root })
    spawnSync('git', ['config', 'user.name', 'test'], { cwd: root })
    spawnSync('git', ['config', 'user.email', 't@example.invalid'], { cwd: root })
    mkdirSync(join(root, 'packages', 'a'), { recursive: true })
    writeFileSync(join(root, 'packages', 'a', 'feature_list.json'), '[]\n')
    spawnSync('git', ['add', '.'], { cwd: root })
    spawnSync('git', ['commit', '-qm', 'init'], { cwd: root })
    spawnSync('git', ['branch', 'plan/demo'], { cwd: root })
    mkdirSync(join(root, '.harness'), { recursive: true })
    writeFileSync(join(root, '.harness', 'integration-branch'), 'plan/demo\n')
    const subproject = join(root, 'packages', 'a')
    const held = mergeAcquire(subproject, process.pid)
    try {
      assert.equal(held.integDir, join(`${root}-wt-integration`, 'packages/a'))
      assert.ok(existsSync(`${root}-wt-integration`))
      assert.equal(existsSync(`${subproject}-wt-integration`), false)
    } finally {
      mergeRelease(subproject, process.pid)
      spawnSync('git', ['worktree', 'remove', '--force', `${root}-wt-integration`], { cwd: root })
    }
  })
})

test('parseVerdict reports complete vs open verdict', async () => {
  const { parseVerdict, hasCompleteVerdict } = await import('../skills/generator/lib/worker-outcome.mjs')
  const open = '===HARNESS-VERDICT-BEGIN===\n{"id":"x","ok":true}\n'
  const closed = `${open}===HARNESS-VERDICT-END===\n`
  assert.equal(hasCompleteVerdict(open), false)
  assert.equal(hasCompleteVerdict(closed), true)
  assert.equal(parseVerdict(closed).ok, true)
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

test('pinIntegrationBranchIfAbsent pins once and never overwrites', () => {
  withoutIntegrationBranchEnv(() => {
    const root = mkdtempSync(join(tmpdir(), 'pin-integration-'))
    spawnSync('git', ['init', '-b', 'main'], { cwd: root })
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], { cwd: root })
    const first = pinIntegrationBranchIfAbsent(root, 'Demo App')
    assert.equal(first.pinned, true)
    assert.equal(first.branch, 'plan/demo-app')
    assert.equal(readFileSync(join(root, '.harness', 'integration-branch'), 'utf8'), 'plan/demo-app\n')
    assert.equal(spawnSync('git', ['rev-parse', '--verify', 'refs/heads/plan/demo-app'], { cwd: root }).status, 0)
    const second = pinIntegrationBranchIfAbsent(root, 'Other')
    assert.equal(second.pinned, false)
    assert.equal(readFileSync(join(root, '.harness', 'integration-branch'), 'utf8'), 'plan/demo-app\n')
  })
})

test('upsertProject is the sole projects.json writer and preserves entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'projects-registry-'))
  spawnSync('git', ['init', '-b', 'main'], { cwd: root })
  mkdirSync(join(root, '.harness'), { recursive: true })
  writeFileSync(join(root, '.harness', 'projects.json'), `${JSON.stringify({
    note: 'keep',
    projects: [{ id: 'frontend', path: 'apps/frontend', description: 'Web' }],
  }, null, 2)}\n`)
  const created = upsertProject(root, { id: 'apps_api', path: 'apps/api/' })
  assert.equal(created.created, true)
  assert.equal(created.path, 'apps/api')
  const updated = upsertProject(root, { id: 'frontend', path: 'apps/web', description: 'Customer web' })
  assert.equal(updated.created, false)
  const registry = readProjectsRegistry(root)
  assert.equal(registry.note, 'keep')
  assert.equal(registry.projects.find((p) => p.id === 'frontend').path, 'apps/web')
  assert.equal(registry.projects.find((p) => p.id === 'frontend').description, 'Customer web')
  assert.ok(registry.projects.some((p) => p.id === 'apps_api' && p.path === 'apps/api'))
})

test('detectProjectBoundaries finds workspaces, compose, and registry', () => {
  const root = mkdtempSync(join(tmpdir(), 'detect-boundaries-'))
  spawnSync('git', ['init', '-b', 'main'], { cwd: root })
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({
    private: true,
    workspaces: ['apps/*'],
  }, null, 2)}\n`)
  mkdirSync(join(root, 'apps', 'web'), { recursive: true })
  mkdirSync(join(root, 'apps', 'api'), { recursive: true })
  writeFileSync(join(root, 'apps', 'web', 'package.json'), '{}\n')
  writeFileSync(join(root, 'apps', 'api', 'package.json'), '{}\n')
  writeFileSync(join(root, 'docker-compose.yml'), 'services: {}\n')
  mkdirSync(join(root, '.harness'), { recursive: true })
  writeFileSync(join(root, '.harness', 'projects.json'), `${JSON.stringify({
    projects: [{ id: 'web', path: 'apps/web', description: 'Customer UI' }],
  }, null, 2)}\n`)
  const { gitRoot, projects } = detectProjectBoundaries(root)
  assert.equal(gitRoot, canonicalPath(root))
  assert.ok(projects.some((p) => p.path === 'apps/web' && p.sources.includes('.harness/projects.json')))
  assert.ok(projects.some((p) => p.path === 'apps/api' && p.sources.includes('package.json#workspaces')))
  assert.ok(projects.some((p) => p.path === '' && p.sources.includes('docker-compose.yml')))
})

test('detect-boundaries CLI requires --confirm before writing registry', () => {
  const root = mkdtempSync(join(tmpdir(), 'detect-confirm-'))
  spawnSync('git', ['init', '-b', 'main'], { cwd: root })
  mkdirSync(join(root, 'apps', 'web'), { recursive: true })
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ private: true, workspaces: ['apps/*'] }, null, 2)}\n`)
  writeFileSync(join(root, 'apps', 'web', 'package.json'), '{}\n')
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'setup', 'lib', 'detect-boundaries.mjs')
  const dry = spawnSync('node', [script, root], { encoding: 'utf8' })
  assert.equal(dry.status, 0)
  const dryJson = JSON.parse(dry.stdout)
  assert.equal(dryJson.mutated, false)
  assert.equal(dryJson.confirm_required, true)
  assert.equal(existsSync(join(root, '.harness', 'projects.json')), false)
  const confirmed = spawnSync('node', [script, root, '--confirm'], { encoding: 'utf8' })
  assert.equal(confirmed.status, 0)
  const confirmedJson = JSON.parse(confirmed.stdout)
  assert.equal(confirmedJson.mutated, true)
  assert.ok(existsSync(join(root, '.harness', 'projects.json')))
  const registry = JSON.parse(readFileSync(join(root, '.harness', 'projects.json'), 'utf8'))
  assert.ok(registry.projects.some((p) => p.id === 'apps_web' && p.path === 'apps/web'))
})

test('orphan-claims detects live, ghost, idle, and terminal run states', () => {
  const alive = (pid) => pid === 42 || pid === 99
  assert.equal(isLiveRunOwner({ ownerPid: 42 }, alive), true)
  assert.equal(isLiveRunOwner({ childPid: 99 }, alive), true)
  assert.equal(isLiveRunOwner({ ownerPid: 1 }, alive), false)

  assert.equal(classifyRunStateHealth({ status: 'complete' }, alive).health, 'terminal')
  assert.equal(classifyRunStateHealth({ status: 'running', ownerPid: 42 }, alive).health, 'live')
  assert.equal(
    classifyRunStateHealth({ status: 'running', ownerPid: 1, childPid: 2 }, alive).health,
    'ghost',
  )
  assert.equal(
    classifyRunStateHealth({ status: 'claimed', phase: 'claimed', heartbeatEpoch: 999 }, alive).health,
    'idle',
  )
})

test('processAlive treats permission-denied probes as live', () => {
  const originalKill = process.kill
  process.kill = () => {
    const error = new Error('permission denied')
    error.code = 'EPERM'
    throw error
  }
  try {
    assert.equal(processAlive(12345), true)
  } finally {
    process.kill = originalKill
  }
})

test('runtimeView classifies live-stale and remote-owned workers', () => {
  assert.equal(runtimeView({
    runState: { status: 'running', ownerPid: 42, heartbeatEpoch: 10 },
    processAlive: (pid) => pid === 42,
    nowEpoch: 200,
    staleSeconds: 60,
  }).health, 'live_stale')
  assert.equal(runtimeView({
    runState: { status: 'running', ownerPid: 42, ownerHost: 'remote', heartbeatEpoch: 195 },
    processAlive: () => false,
    localHost: 'local',
    nowEpoch: 200,
    leaseSeconds: 60,
  }).health, 'remote_owned')
})

test('listGhostClaims finds building contexts with dead PIDs', () => {
  const alive = () => false
  const ghosts = listGhostClaims({
    claims: { 'core--alpha': { context: 'alpha', status: 'building' } },
    runStatesByContext: {
      alpha: { context: 'alpha', status: 'running', ownerPid: 100, childPid: null },
    },
    processAlive: alive,
  })
  assert.equal(ghosts.length, 1)
  assert.equal(ghosts[0].context, 'alpha')
})

test('abandonGhostRun clears PIDs and marks abandoned', () => {
  const next = abandonGhostRun(
    { context: 'alpha', status: 'running', ownerPid: 1, childPid: 2, phase: 'coding' },
    { reason: 'test abandon' },
  )
  assert.equal(next.status, 'abandoned')
  assert.equal(next.ownerPid, null)
  assert.equal(next.childPid, null)
  assert.equal(next.abandonReason, 'test abandon')
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

test('interpretClosed goal-review complete', () => {
  const result = interpretClosed({
    key: 'goal-review',
    tail: '',
    persisted: null,
    runState: {
      status: 'complete',
      phase: 'complete',
      lastResult: 'all checks passed',
      reviewedHead: 'abc123',
    },
    featureIds: [],
    queue: [],
    integrationHead: 'abc123',
  })
  assert.equal(result.goal, true)
  assert.equal(result.durable, true)
})

test('interpretClosed blocked context', () => {
  const result = interpretClosed({
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

test('interpretClosed context complete when integrated', () => {
  const result = interpretClosed({
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

test('worker-outcome canonical API covers closed paths and stuck helpers', async () => {
  const {
    parseVerdict,
    validateOutcome,
    readDurable,
    writeDurable,
    interpretClosed,
    isInfraNoise,
    isWorkerStuckByHealth,
  } = await import('../skills/generator/lib/worker-outcome.mjs')

  assert.deepEqual(parseVerdict('===HARNESS-VERDICT-BEGIN===\n{"goal":true}\n===HARNESS-VERDICT-END==='), { goal: true })
  assert.equal(validateOutcome({ goal: true }).valid, true)
  assert.equal(isInfraNoise('orchestrator: cannot read feature_list.json'), true)
  assert.equal(isWorkerStuckByHealth({ verdict: 'stuck', recycle: true }), true)

  const closed = interpretClosed({
    key: 'goal-review',
    tail: '',
    persisted: null,
    runState: { status: 'complete', phase: 'complete', lastResult: 'ok', reviewedHead: 'abc' },
    featureIds: [],
    queue: [],
  })
  assert.equal(closed?.goal, undefined)

  const matched = interpretClosed({
    key: 'goal-review',
    tail: '',
    persisted: null,
    runState: { status: 'complete', phase: 'complete', lastResult: 'ok', reviewedHead: 'abc' },
    featureIds: [],
    queue: [],
    integrationHead: 'abc',
  })
  assert.equal(matched.goal, true)

  const tmp = mkdtempSync(join(tmpdir(), 'worker-outcome-durable-'))
  const stateFile = join(tmp, 'core.json')
  await writeDurable(stateFile, {
    invocationId: 'inv-1',
    leaseToken: 'lease-1',
    payload: { total: 1, passed: 1, stuck: [] },
  })
  const scoped = await readDurable(stateFile, {
    expectedInvocationId: 'inv-1',
    expectedLeaseToken: 'lease-1',
  })
  assert.equal(scoped.passed, 1)
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

test('planTickAdmission starts Goal Review when integrated queue has stale reviewedHead', () => {
  const plan = planTickAdmission({
    slots: 1,
    retryQueue: {},
    recoverable: [],
    pendingGoalResult: null,
    snapshot: baseSnapshot({ total: 1, integrated: 1 }),
    activeWorkers: 0,
    hasGoalReviewWorker: false,
    integrationHead: 'head-new',
    reviewedHead: 'head-old',
    status: 'blocked',
    ledger: { version: 1, items: { 'WI-0': { implementation: true, qa: true, integration: true } } },
  })
  assert.deepEqual(plan, [{ type: 'start_goal_review' }])
})

test('jobs-done ledger helpers and flag-drift filtering', async () => {
  const {
    integratedIds,
    incompleteIds,
    isFeatureListFlagDriftDefect,
    filterGoalReviewFlagDrift,
    formatJobsDoneForPrompt,
  } = await import('../skills/generator/lib/jobs-done.mjs')

  const catalog = [
    { id: 'WI-1', implementation: false, qa: false, integration: false },
    { id: 'WI-2', implementation: true, qa: true, integration: false },
  ]
  const ledger = {
    version: 1,
    items: {
      'WI-1': { implementation: true, qa: true, integration: true },
      'WI-2': { implementation: true, qa: true, integration: true },
    },
  }
  assert.deepEqual(integratedIds(catalog, ledger), ['WI-1', 'WI-2'])
  assert.deepEqual(incompleteIds(catalog, ledger), [])
  assert.equal(
    isFeatureListFlagDriftDefect('WI-1 has integration=false in feature_list.json but Execution Ledger fully integrated'),
    true,
  )
  assert.equal(
    isFeatureListFlagDriftDefect('compose up failed: ECONNREFUSED on port 3000'),
    false,
  )
  const filtered = filterGoalReviewFlagDrift({
    defects: [
      'WI-1 not integrated per feature_list.json integration=false',
      'GET /health returned 500 for AC-054',
    ],
    acceptanceCheckIds: ['AC-001', 'AC-002', 'AC-054'],
    catalog: [
      { id: 'WI-1', acceptance_checks: ['AC-1'] },
      { id: 'WI-2', acceptance_checks: ['AC-2'] },
      { id: 'WI-AC-054', acceptance_checks: ['AC-054'] },
    ],
    ledger: {
      ...ledger,
      items: {
        ...ledger.items,
        'WI-AC-054': { implementation: true, qa: true, integration: true },
      },
    },
  })
  assert.equal(filtered.strippedDrift, true)
  assert.equal(filtered.defects.length, 1)
  assert.match(filtered.defects[0], /500/)
  // Real defects derive AC ids from prose — keep ledger-integrated ACs with product failures
  assert.deepEqual(filtered.acceptanceCheckIds, ['AC-054'])
  assert.ok(formatJobsDoneForPrompt(catalog, ledger).includes('Integrated Work Items (2/2)'))
})

test('planWorkerClosedActions queues Goal Review retry on stripped flag drift', () => {
  const plan = planWorkerClosedActions({
    key: 'goal-review',
    exitCode: 0,
    tail: '',
    result: {
      goal: false,
      blocked: true,
      retryGoalReview: true,
      strippedFlagDrift: true,
      summary: 'flag drift only',
    },
    rateLimited: false,
    crashCount: 0,
    harnessRepairs: {},
    retryQueue: {},
    autoRepair: false,
    logFile: '/tmp/goal.log',
  })
  assert.equal(plan.action, 'goal_review_retry')
  assert.equal(plan.clearGoalBlock, true)
  assert.equal(plan.strippedFlagDrift, true)
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

test('meaningfulCheckoutDirt ignores untracked files and runtime pids', () => {
  const porcelain = [
    '?? unrelated.txt',
    '?? monorepo/noise.md',
    '!! .gitignore-local',
    '?? .harness/app.pid',
    ' M tracked.js',
  ].join('\n')
  assert.equal(meaningfulCheckoutDirt(porcelain), ' M tracked.js')
  assert.equal(isCheckoutCleanForGoalReview('?? unrelated.txt\n?? .harness/app.pid\n'), true)
  assert.equal(isCheckoutCleanForGoalReview(' M src/app.js\n'), false)
  assert.equal(isCheckoutCleanForGoalReview(''), true)
})

test('meaningfulCheckoutDirt ignores turbo/next build caches', () => {
  const porcelain = [
    ' M .turbo/cache/abc-meta.json',
    ' M .turbo/cache/abc.tar.zst',
    ' M src/app.ts',
    '?? .turbo/cache/new.tar.zst',
    ' M .next/BUILD_ID',
  ].join('\n')
  assert.equal(meaningfulCheckoutDirt(porcelain), ' M src/app.ts')
  assert.equal(
    isCheckoutCleanForGoalReview(' M .turbo/cache/x.tar.zst\n?? .turbo/cache/y.tar.zst\n'),
    true,
  )
})

test('meaningfulCheckoutDirt ignores harness-progress Workflow Journals', () => {
  const porcelain = [
    ' M harness-progress/goal-review.md',
    ' M web/harness-progress/session.md',
    'AM harness-progress/notes.md',
    ' M src/app.ts',
  ].join('\n')
  assert.equal(meaningfulCheckoutDirt(porcelain), ' M src/app.ts')
  assert.equal(
    isCheckoutCleanForGoalReview(' M harness-progress/goal-review.md\n'),
    true,
  )
  assert.equal(
    isCheckoutCleanForGoalReview(' M harness-progress/goal-review.md\n M src/app.ts\n'),
    false,
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

test('classifyFailure unifies quota, infra, and observation_mismatch with failure-policy recovery', () => {
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

  const routed = routeRepair({ defectClass: 'observation_mismatch' })
  assert.equal(routed.action, 'repair_plan')
  assert.equal(routed.autoRetry, true)
})

test('shouldEnqueueStuckWorkerRetry enqueues stuck workers', () => {
  assert.equal(shouldEnqueueStuckWorkerRetry({ verdict: 'stuck', recycle: true }), true)
  assert.equal(shouldEnqueueStuckWorkerRetry({ verdict: 'healthy' }), false)
  assert.equal(shouldEnqueueStuckWorkerRetry(null), true)
})

test('planWorkerClosedActions infra crash blocks without auto harness repair', () => {
  const plan = planWorkerClosedActions({
    key: 'core',
    exitCode: 1,
    tail: 'orchestrator: timed out waiting for merge lock',
    result: null,
    rateLimited: false,
    crashCount: 0,
    harnessRepairs: {},
    retryQueue: {},
    autoRepair: false,
    logFile: '/tmp/log',
  })
  assert.equal(plan.action, 'blocked_input')
  assert.equal(plan.emitHarnessIssue?.reason?.includes('Worker exited with code 1'), true)
})

test('worker-outcome fences stale invocation and validates verdicts', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'worker-outcome-'))
  const stateFile = join(tmp, 'core.json')
  await writeDurable(stateFile, {
    invocationId: 'inv-a',
    leaseToken: 'lease-a',
    payload: { total: 1, passed: 1, stuck: [] },
  })
  const scoped = await readDurable(stateFile, {
    expectedInvocationId: 'inv-a',
    expectedLeaseToken: 'lease-a',
  })
  assert.equal(scoped.passed, 1)
  const staleInvocation = await readDurable(stateFile, {
    expectedInvocationId: 'inv-b',
    expectedLeaseToken: 'lease-a',
  })
  assert.equal(staleInvocation, null)
  const staleLease = await readDurable(stateFile, {
    expectedInvocationId: 'inv-a',
    expectedLeaseToken: 'lease-b',
  })
  assert.equal(staleLease, null)

  const goal = validateOutcome({ goal: true, summary: 'done' })
  assert.equal(goal.valid, true)
  assert.equal(goal.mode, 'goalReview')
  const bad = validateOutcome({ goal: 'yes' })
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

test('classifyFailure treats host-death strings as operational', () => {
  const sessionKill = classifyFailure({ reason: 'Session terminated, killing shell... ...killed.' })
  assert.equal(sessionKill.class, 'operational')
  assert.equal(sessionKill.safeRecovery, 'retry_same')

  const sessionLimit = classifyFailure({ reason: 'Claude session limit until 6am' })
  assert.equal(sessionLimit.class, 'operational')

  const orphan = classifyFailure({ reason: 'orphanShell detected after childPid died' })
  assert.equal(orphan.class, 'operational')

  assert.equal(isInfraNoise('Session terminated, killing shell...'), true)
  assert.equal(isInfraNoise('Harness worker pane ended before run state completed'), true)
})

test('planWorkerClosedActions host-death on Goal Review retries operationally', () => {
  const plan = planWorkerClosedActions({
    key: 'goal-review',
    exitCode: 1,
    tail: 'agent: harness verdict received\nSession terminated, killing shell... ...killed.',
    result: null,
    rateLimited: false,
    crashCount: 0,
    harnessRepairs: {},
    retryQueue: {},
    autoRepair: false,
    logFile: '/tmp/goal.log',
  })
  assert.equal(plan.action, 'goal_review_retry')
  assert.equal(plan.clearGoalBlock, true)
  assert.notEqual(plan.action, 'blocked_input')
})

test('planWorkerClosedActions host-death on context worker queues operational retry', () => {
  const plan = planWorkerClosedActions({
    key: 'core',
    exitCode: 1,
    tail: 'Session terminated, killing shell... ...killed.',
    result: null,
    rateLimited: false,
    crashCount: 0,
    harnessRepairs: {},
    retryQueue: {},
    autoRepair: false,
    logFile: '/tmp/core.log',
  })
  assert.equal(plan.action, 'operational_retry')
  assert.equal(plan.context, 'core')
  assert.equal(plan.clearCrashCount, true)
})

test('interpretClosed and planWorkerClosedActions treat empty Goal Review verdict as retry', async () => {
  const { interpretClosed, isMalformedGoalReviewVerdict } = await import('../skills/generator/lib/worker-outcome.mjs')

  const emptyWrapped = `${VERDICT_BEGIN}\n\n${VERDICT_END}`
  assert.equal(isMalformedGoalReviewVerdict(emptyWrapped), true)

  const prosePass = 'Goal Review passed all acceptance checks on integrated main.'
  assert.equal(isMalformedGoalReviewVerdict(prosePass), true)

  const closed = interpretClosed({
    key: 'goal-review',
    tail: emptyWrapped,
    persisted: null,
    runState: { status: 'blocked', phase: 'blocked', lastResult: 'stale block' },
    featureIds: [],
    queue: [],
  })
  assert.equal(closed.retryGoalReview, true)
  assert.equal(closed.malformedVerdict, true)

  const plan = planWorkerClosedActions({
    key: 'goal-review',
    exitCode: 0,
    tail: emptyWrapped,
    result: closed,
    rateLimited: false,
    crashCount: 0,
    harnessRepairs: {},
    retryQueue: {},
    autoRepair: false,
    logFile: '/tmp/goal.log',
  })
  assert.equal(plan.action, 'goal_review_retry')
  assert.notEqual(plan.action, 'blocked_input')
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
  const { buildHostCommand, hostCommands } = await import('../skills/generator/adapters/hosts.mjs')
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
  // hostCommands and buildHostCommand share one default-model policy for opencode/pi.
  assert.deepEqual(hostCommands.opencode('do work'), buildHostCommand('opencode', 'do work'))
  assert.deepEqual(hostCommands.pi('do work'), buildHostCommand('pi', 'do work'))
  assert.deepEqual(
    buildHostCommand('opencode', 'do work'),
    ['opencode', ['run', '--model', 'opencode-go/deepseek-v4-flash', 'do work']],
  )
  assert.deepEqual(
    buildHostCommand('pi', 'do work'),
    ['pi', ['--model', 'opencode-go/deepseek-v4-flash', '-p', 'do work']],
  )
})

test('evidenceGuidanceExcerpt reads expected/observed pairs without mutating artifacts', async () => {
  const { evidenceGuidanceExcerpt, enrichGuidanceWithEvidence } = await import('../skills/generator/lib/evidence-guidance.mjs')
  const { autoRetryGuidance } = await import('../skills/generator/lib/failure-policy.mjs')

  const tmp = mkdtempSync(join(tmpdir(), 'evidence-guidance-'))
  const artifact = join(tmp, 'WI-AC-001-1-qa-deadbeef.log')
  const body = JSON.stringify({
    id: 'WI-AC-001',
    qa: false,
    defects: ['expected GET /health returns 200; observed 503 Service Unavailable; evidence curl output'],
  })
  writeFileSync(artifact, [
    'project=demo',
    'context=core',
    'id=WI-AC-001',
    'attempt=1',
    'kind=qa',
    'digest=deadbeef',
    '',
    body,
  ].join('\n'))
  const before = readFileSync(artifact, 'utf8')

  const excerpt = evidenceGuidanceExcerpt(artifact)
  assert.match(excerpt, /expected: GET \/health returns 200/)
  assert.match(excerpt, /observed: 503 Service Unavailable/)
  assert.equal(readFileSync(artifact, 'utf8'), before)

  const enriched = enrichGuidanceWithEvidence('Retry with smallest fix.', {
    evidence: artifact,
    defects: JSON.parse(body).defects,
  })
  assert.match(enriched, /Retry with smallest fix\./)
  assert.match(enriched, /expected: GET \/health returns 200/)

  const guidance = autoRetryGuidance({
    reason: 'integration could not complete',
    detail: { evidence: artifact },
  })
  assert.match(guidance, /MERGE\/IV ONLY/)
  assert.match(guidance, /index\.lock/)
  assert.match(guidance, /observed: 503 Service Unavailable/)
})

test('host remediation releases sibling goal-review ghosts and clears stale index.lock', async () => {
  const {
    planHostRemediation,
    shouldEscalateRemediation,
  } = await import('../skills/supervisor/lib/host-remediation.mjs')
  const tmp = mkdtempSync(join(tmpdir(), 'host-remed-'))
  const lockPath = join(tmp, 'index.lock')
  writeFileSync(lockPath, '')
  const plan = planHostRemediation({
    projects: [
      {
        id: 'root',
        status: 'running',
        workers: 0,
        emptyFleetActionable: true,
        progress: { total: 26, integrated: 4 },
        capacity: { available: 0 },
      },
      {
        id: 'web',
        status: 'running',
        workers: 0,
        progress: { total: 91, integrated: 91 },
        needsGoalReviewRetry: true,
        supervisorLive: true,
        supervisorPid: 410635,
        root: '/repo/web',
      },
    ],
    reservations: {
      gr: {
        id: 'gr',
        projectId: 'web',
        context: 'goal-review',
        resourceClass: 'goal-review',
        cost: 2,
      },
    },
    blockerProjectId: 'root',
    indexLockPath: lockPath,
    indexLockHeld: false,
    indexLockAgeMs: 10_000,
  })
  assert.ok(plan.actions.some((a) => a.kind === 'clear_index_lock'))
  assert.ok(plan.actions.some((a) => a.kind === 'release_reservation' && a.reservationId === 'gr'))
  assert.ok(plan.actions.some((a) => a.kind === 'stop_idle_complete_supervisor' && a.projectId === 'web'))
  assert.equal(shouldEscalateRemediation({
    attempts: 3,
    emptyFleetActionable: true,
    available: 0,
    remaining: 22,
  }), true)
  assert.equal(shouldEscalateRemediation({
    attempts: 1,
    emptyFleetActionable: true,
    available: 0,
    remaining: 22,
  }), false)
})

test('representative-brief plans progress notifies and judgment wakes', async () => {
  const {
    planProgressBrief,
    isJudgmentWake,
  } = await import('../skills/supervisor/lib/representative-brief.mjs')
  const first = planProgressBrief({
    previous: null,
    progress: { total: 26, integrated: 24, implemented: 24, qa: 24 },
    status: 'running',
    claims: [{ context: 'oss-golden-path', phase: 'coding' }],
    pendingInputs: 0,
  })
  assert.equal(first.brief, true)
  assert.match(first.body, /24\/26/)

  const unchanged = planProgressBrief({
    previous: first.snapshot,
    progress: { total: 26, integrated: 24, implemented: 24, qa: 24 },
    status: 'running',
    claims: [{ context: 'oss-golden-path', phase: 'coding' }],
    now: Date.parse(first.snapshot.at) + 60_000,
    minIntervalMs: 15 * 60_000,
  })
  assert.equal(unchanged.brief, false)

  const advanced = planProgressBrief({
    previous: first.snapshot,
    progress: { total: 26, integrated: 25, implemented: 25, qa: 25 },
    status: 'running',
    claims: [],
    now: Date.parse(first.snapshot.at) + 60_000,
  })
  assert.equal(advanced.brief, true)
  assert.match(advanced.body, /25\/26/)

  assert.equal(isJudgmentWake({ kind: 'worker_stuck' }), true)
  assert.equal(isJudgmentWake({ kind: 'progress', wakeTriage: { action: 'wake' } }), false)
  assert.equal(isJudgmentWake({ kind: 'input_required' }), true)
})

test('workerActivityAgeMs ignores orchestrator heartbeat when agent is silent', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { workerActivityAgeMs, isWorkerStuck } = await import('../skills/generator/lib/worker-outcome.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'silent-agent-'))
  const logFile = join(dir, 'empty.log')
  writeFileSync(logFile, '')
  const now = Date.now()
  const age = await workerActivityAgeMs({
    logFile,
    runState: {
      heartbeatEpoch: Math.floor(now / 1000),
      lastAgentOutputAt: null,
      startedAt: new Date(now - 20 * 60_000).toISOString(),
    },
    now,
  })
  assert.ok(age >= 15 * 60_000, `expected silent age >= 15m, got ${age}`)
  assert.equal(await isWorkerStuck({
    logFile,
    runState: {
      heartbeatEpoch: Math.floor(now / 1000),
      lastAgentOutputAt: null,
      startedAt: new Date(now - 20 * 60_000).toISOString(),
    },
    thresholdMs: 600_000,
  }), true)
})

test('anomaly-detect never-started, crash-loop, and spawn-failed planners', async () => {
  const {
    planNeverStarted,
    planCrashLoop,
    planSpawnFailed,
  } = await import('../skills/supervisor/lib/anomaly-detect.mjs')

  const within = planNeverStarted({
    context: 'alpha',
    startedAt: new Date().toISOString(),
    runState: {},
    deadlineMs: 120_000,
    processAlive: () => false,
  })
  assert.equal(within.emit, false)

  const never = planNeverStarted({
    context: 'alpha',
    startedAt: new Date(Date.now() - 200_000).toISOString(),
    runState: { status: 'starting', phase: 'coding' },
    workerPid: null,
    deadlineMs: 120_000,
    processAlive: () => false,
  })
  assert.equal(never.emit, true)
  assert.equal(never.kind, 'worker_never_started')

  const live = planNeverStarted({
    context: 'alpha',
    startedAt: new Date(Date.now() - 200_000).toISOString(),
    runState: { status: 'running', ownerPid: 42 },
    deadlineMs: 120_000,
    processAlive: (pid) => pid === 42,
  })
  assert.equal(live.emit, false)

  const first = planCrashLoop({
    context: 'alpha',
    recentExits: [],
    exitAt: 1000,
    windowMs: 60_000,
    threshold: 3,
  })
  assert.equal(first.emit, false)
  assert.deepEqual(first.recentExits, [1000])

  const loop = planCrashLoop({
    context: 'alpha',
    recentExits: [1000, 2000],
    exitAt: 3000,
    windowMs: 60_000,
    threshold: 3,
  })
  assert.equal(loop.emit, true)
  assert.equal(loop.kind, 'worker_crash_loop')
  assert.equal(loop.detail.count, 3)

  const once = planCrashLoop({
    context: 'alpha',
    recentExits: [1000, 2000, 3000],
    exitAt: 4000,
    windowMs: 60_000,
    threshold: 3,
    alreadyEmitted: true,
  })
  assert.equal(once.emit, false)

  assert.equal(planSpawnFailed({ context: 'alpha', pid: 9 }).emit, false)
  const spawnFail = planSpawnFailed({ context: 'alpha', pid: null })
  assert.equal(spawnFail.emit, true)
  assert.equal(spawnFail.kind, 'worker_spawn_failed')
})

test('wake triage wakes on anomaly kinds and absorbs single worker_closed', async () => {
  const { classify, shouldWake } = await import('../skills/supervisor/lib/wake-triage.mjs')
  assert.deepEqual(classify({ kind: 'worker_never_started', context: 'a' }), {
    action: 'wake',
    reason: 'worker_never_started',
  })
  assert.deepEqual(classify({ kind: 'worker_crash_loop', context: 'a' }), {
    action: 'wake',
    reason: 'worker_crash_loop',
  })
  assert.deepEqual(classify({ kind: 'worker_spawn_failed', context: 'a' }), {
    action: 'wake',
    reason: 'worker_spawn_failed',
  })
  assert.deepEqual(classify({ kind: 'worker_closed', context: 'a' }), {
    action: 'absorb',
    reason: 'worker_closed',
  })
  assert.deepEqual(classify({ kind: 'worker_started', context: 'a' }), {
    action: 'absorb',
    reason: 'worker_started',
  })
  assert.equal(shouldWake([
    { kind: 'worker_started' },
    { kind: 'worker_closed' },
  ]), false)
  assert.equal(shouldWake([
    { kind: 'worker_started' },
    { kind: 'worker_crash_loop', context: 'a' },
  ]), true)
})

test('fleet snapshot counts live Claim Leases as workers (no false empty-fleet)', async () => {
  const { buildProjectSnapshot, isEmptyFleetActionable } = await import('../skills/supervisor/lib/fleet-snapshot.mjs')
  const { countLiveClaims } = await import('../skills/supervisor/lib/orphan-claims.mjs')
  assert.equal(countLiveClaims({
    claims: { a: { context: 'web-oss-dashboard', status: 'building' } },
    runStatesByContext: {
      'web-oss-dashboard': { status: 'running', ownerPid: 1, childPid: 2 },
    },
    processAlive: (pid) => pid === 1 || pid === 2,
  }), 1)
  const project = buildProjectSnapshot({
    id: 'root',
    state: {
      status: 'running',
      workers: {},
      progress: { total: 26, integrated: 21 },
      pendingInputs: {},
      retryQueue: {},
    },
    liveClaimWorkers: 1,
  })
  assert.equal(project.workers, 1)
  assert.equal(project.emptyFleetActionable, false)
  assert.equal(isEmptyFleetActionable(null, {
    workers: 1,
    status: 'running',
    counts: { total: 26, integrated: 21 },
    pendingInputs: 0,
    retryQueueSize: 0,
  }), false)
})

test('failure-policy blocks coding exhaustion and routes quota/infra', async () => {
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

  const observation = routePendingInput({
    reason: 'grep-only audit should not start a server',
  })
  assert.equal(observation.action, 'repair_plan')
  assert.equal(observation.defectClass, 'observation_mismatch')
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
  const { readControlEvents, appendControlEvent } = await import('../skills/supervisor/lib/control-journal.mjs')
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

test('control journal steals dead writer lock instead of timing out', async () => {
  const {
    appendControlEvent, journalLockHolderAlive, journalPaths,
  } = await import('../skills/supervisor/lib/control-journal.mjs')
  const root = mkdtempSync(join(tmpdir(), 'journal-dead-lock-'))
  const { lock } = journalPaths(root)
  // Impossible PID — holder must be treated as dead and stolen on append.
  writeFileSync(lock, '999999999.dead-lock-token\n')
  assert.equal(journalLockHolderAlive(lock), false)
  const started = Date.now()
  const event = await appendControlEvent(root, { kind: 'run_started', runId: 'after-steal' })
  assert.ok(Date.now() - started < 5_000, 'dead lock steal must not wait for the 10s timeout')
  assert.equal(event.kind, 'run_started')
  assert.equal(existsSync(lock), false)
})

test('compose-shared refcount keeps infra up for sibling workers', async () => {
  const {
    acquireComposeShare,
    releaseComposeShare,
    composeShareCount,
    planComposeTeardown,
    composeShareSnapshot,
    isAppService,
    isSharedInfraService,
  } = await import('../skills/generator/lib/compose-shared.mjs')
  const root = mkdtempSync(join(tmpdir(), 'compose-share-'))
  assert.equal(isSharedInfraService('causeflow-postgres'), true)
  assert.equal(isSharedInfraService('hindsight'), true)
  assert.equal(isAppService('causeflow-api'), true)
  assert.equal(isAppService('causeflow-postgres'), false)

  acquireComposeShare(root, 'core', 'open-source-local-runtime', { pid: process.pid, worktree: '/wt/core', services: ['postgres'], ports: [5432] })
  acquireComposeShare(root, 'core', 'dashboard')
  assert.equal(composeShareCount(root, 'core'), 2)
  const snap = composeShareSnapshot(root)
  assert.equal(snap.projects.core.holders['open-source-local-runtime'].worktree, '/wt/core')
  assert.deepEqual(snap.projects.core.holders['open-source-local-runtime'].services, ['postgres'])

  const afterOne = releaseComposeShare(root, 'core', 'dashboard')
  assert.equal(afterOne.count, 1)
  assert.equal(afterOne.lastHolder, false)
  assert.equal(
    planComposeTeardown({ shareCount: afterOne.count }).mode,
    'app_services_only',
  )

  const afterLast = releaseComposeShare(root, 'core', 'open-source-local-runtime')
  assert.equal(afterLast.count, 0)
  assert.equal(afterLast.lastHolder, true)
  assert.equal(planComposeTeardown({ shareCount: 0 }).mode, 'full_down')
  assert.equal(planComposeTeardown({ shareCount: 1, force: true }).mode, 'full_down')

  const { planSharedRuntimeTeardown } = await import('../skills/generator/lib/compose-shared.mjs')
  acquireComposeShare(root, 'core', 'a', { pid: process.pid })
  acquireComposeShare(root, 'core', 'b', { pid: process.pid })
  const planned = planSharedRuntimeTeardown({
    commonGit: root,
    projectId: 'core',
    context: 'a',
  })
  assert.equal(planned.mode, 'app_services_only')
  assert.equal(planned.remaining, 1)
  assert.equal(planned.released.lastHolder, false)
  const last = planSharedRuntimeTeardown({
    commonGit: root,
    projectId: 'core',
    context: 'b',
  })
  assert.equal(last.mode, 'full_down')
  assert.equal(last.remaining, 0)
  assert.equal(
    planSharedRuntimeTeardown({ force: true }).mode,
    'full_down',
  )
  assert.equal(
    planSharedRuntimeTeardown({}).mode,
    'refused',
  )

  const bad = join(root, 'harness-locks', 'compose-shared.json')
  writeFileSync(bad, '{not-json')
  assert.throws(
    () => composeShareSnapshot(root),
    /compose shared registry unreadable/,
  )
})
test('composeDown refuses full-down when share state is unknown', async () => {
  const { composeDown } = await import('../skills/generator/lib/worktree-teardown.mjs')
  const root = mkdtempSync(join(tmpdir(), 'compose-down-refuse-'))
  writeFileSync(join(root, 'compose.yaml'), 'services:\n  api:\n    image: alpine\n')
  const refused = composeDown(root)
  assert.equal(refused.mode, 'refused')
  assert.equal(refused.skippedFullDown, true)
  assert.equal(refused.ran, false)
})

test('stopWorktreeApp prefers init.sh stop over app.pid', async () => {
  const { stopWorktreeApp } = await import('../skills/generator/lib/worktree-teardown.mjs')
  const root = mkdtempSync(join(tmpdir(), 'init-stop-'))
  mkdirSync(join(root, '.harness'), { recursive: true })
  writeFileSync(join(root, '.harness', 'app.pid'), '999999\n')
  writeFileSync(join(root, 'init.sh'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "stop" ]]; then
  echo stopped > "${join(root, 'stopped.flag')}"
  rm -f .harness/app.pid
  exit 0
fi
exit 2
`)
  chmodSync(join(root, 'init.sh'), 0o755)
  const result = stopWorktreeApp(root)
  assert.equal(result.stopped, true)
  assert.equal(result.via, 'init.sh')
  assert.equal(existsSync(join(root, 'stopped.flag')), true)
  assert.equal(existsSync(join(root, '.harness', 'app.pid')), false)
})

test('stopWorktreeApp falls back to app.pid when init.sh missing', async () => {
  const { stopWorktreeApp } = await import('../skills/generator/lib/worktree-teardown.mjs')
  const root = mkdtempSync(join(tmpdir(), 'pid-stop-'))
  mkdirSync(join(root, '.harness'), { recursive: true })
  // Non-existent PID: stopAppPid still reports stopped after attempting terminate + unlink.
  writeFileSync(join(root, '.harness', 'app.pid'), '999999999\n')
  const result = stopWorktreeApp(root)
  assert.equal(result.stopped, true)
  assert.equal(result.via, 'app.pid')
  assert.equal(existsSync(join(root, '.harness', 'app.pid')), false)
})

test('runtime manifest records exact resources for cleanup', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-manifest-'))
  assert.equal(appendOwnedRuntime(root, { context: 'core', pids: [123], containers: ['wi-ac-1'] }), true)
  const rows = readOwnedRuntime(root)
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].containers, ['wi-ac-1'])
})

test('control journal compaction preserves pending input lineage', async () => {
  const {
    appendControlEvent, readControlEvents, compactControlJournal, deriveSnapshot,
  } = await import('../skills/supervisor/lib/control-journal.mjs')
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

test('control journal compaction drops resolved input lineage from snapshot', async () => {
  const {
    appendControlEvent, compactControlJournal, readControlEvents,
  } = await import('../skills/supervisor/lib/control-journal.mjs')
  const { readFile } = await import('node:fs/promises')
  const root = mkdtempSync(join(tmpdir(), 'journal-resolved-'))
  for (let i = 0; i < 40; i++) {
    await appendControlEvent(root, { kind: 'progress', workers: i })
  }
  const input = await appendControlEvent(root, {
    kind: 'input_required', scope: 'context', context: 'core', reason: 'blocked', choices: ['retry'],
  })
  await appendControlEvent(root, {
    kind: 'input_received', requestId: input.id, scope: 'context', context: 'core', action: 'retry',
  })
  for (let i = 0; i < 20; i++) {
    await appendControlEvent(root, { kind: 'progress', workers: i })
  }
  const compacted = await compactControlJournal(root, { minTail: 10 })
  assert.equal(compacted.compacted, true)
  assert.equal(compacted.preservedLineage, 0)
  const snap = JSON.parse(await readFile(join(root, 'journal-snapshot.json'), 'utf8'))
  assert.equal(snap.preservedEvents.length, 0)
  const events = await readControlEvents(root, join(root, 'events.jsonl'))
  assert.equal(events.some((event) => event.id === input.id), false)
})

test('control journal maybeCompact gates on cheap metadata', async () => {
  const {
    appendControlEvent, maybeCompactControlJournal, readControlEvents,
  } = await import('../skills/supervisor/lib/control-journal.mjs')
  const below = mkdtempSync(join(tmpdir(), 'journal-maybe-below-'))
  for (let i = 0; i < 3; i++) {
    await appendControlEvent(below, { kind: 'progress', workers: i })
  }
  const skipped = await maybeCompactControlJournal(below, { minTail: 10 })
  assert.equal(skipped.compacted, false)
  assert.equal(skipped.skipped, true)
  assert.equal(skipped.reason, 'tail-below-threshold')
  assert.equal((await readControlEvents(below, join(below, 'events.jsonl'))).length, 3)

  const missingMeta = mkdtempSync(join(tmpdir(), 'journal-maybe-missing-meta-'))
  mkdirSync(missingMeta, { recursive: true })
  writeFileSync(join(missingMeta, 'events.jsonl'), `${JSON.stringify({ id: 1, kind: 'progress' })}\n`)
  const fallback = await maybeCompactControlJournal(missingMeta, { minTail: 10 })
  assert.equal(fallback.compacted, false)
  assert.equal(fallback.kept, 1)

  const above = mkdtempSync(join(tmpdir(), 'journal-maybe-above-'))
  for (let i = 0; i < 12; i++) {
    await appendControlEvent(above, { kind: 'progress', workers: i })
  }
  const compacted = await maybeCompactControlJournal(above, { minTail: 3 })
  assert.equal(compacted.compacted, true)

  const throttled = await maybeCompactControlJournal(above, {
    minTail: 3,
    minIntervalMs: 60_000,
    lastCompactAt: Date.now(),
  })
  assert.equal(throttled.compacted, false)
  assert.equal(throttled.skipped, true)
  assert.equal(throttled.reason, 'interval-throttle')
})

test('state heartbeat escalates after consecutive write failures', async () => {
  const { startStateHeartbeat } = await import('../skills/generator/lib/worker-lifecycle.mjs')
  let calls = 0
  let escalated = 0
  const timer = startStateHeartbeat(
    async () => {
      calls += 1
      throw new Error('fence lost')
    },
    {
      intervalMs: 10,
      maxConsecutiveFailures: 3,
      label: 'test-heartbeat',
      onEscalated: () => { escalated += 1 },
    },
  )
  await new Promise((resolve) => setTimeout(resolve, 80))
  clearInterval(timer)
  assert.ok(calls >= 3)
  assert.equal(escalated, 1)
})

test('control journal ignores caller id and keeps latest duplicate', async () => {
  const {
    appendControlEvent, readControlEvents, maxRawEventIdFromText,
  } = await import('../skills/supervisor/lib/control-journal.mjs')
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
  const { requestAdmission, observeCapacity, releaseAdmission } = await import('../skills/supervisor/lib/resource-governor.mjs')
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

test('host resources parse meminfo and expose swap pressure facts', () => {
  const meminfo = parseMeminfo('MemAvailable:       2097152 kB\nSwapTotal:          1048576 kB\nSwapFree:            262144 kB\n')
  assert.equal(meminfo.MemAvailable, 2048)
  assert.equal(meminfo.SwapTotal, 1024)
  const host = readHostResources({ meminfoText: 'MemAvailable:       2097152 kB\nSwapTotal:          1048576 kB\nSwapFree:            262144 kB\n' })
  assert.equal(host.memory.availableMb, 2048)
  assert.equal(host.swap.usedMb, 768)
  assert.ok(host.swap.usedRatio > 0.7)
})

test('resource governor accounts for weighted reservations', async () => {
  const { requestAdmission, observeCapacity, releaseAdmission, resourceCost } = await import('../skills/supervisor/lib/resource-governor.mjs')
  const tmp = mkdtempSync(join(tmpdir(), 'governor-weight-'))
  const commonGit = join(tmp, '.git')
  mkdirSync(commonGit, { recursive: true })
  assert.equal(resourceCost('browser'), 2)
  const opts = {
    maxWorkers: 3,
    quotaWorkers: 3,
    cpuPerWorker: 0.25,
    memoryPerWorkerMb: 1,
    reserveMemoryMb: 0,
    maxLoadRatio: 100,
    maxSwapUsedRatio: 1,
  }
  const first = await requestAdmission(commonGit, { projectId: 'root', context: 'browser', resourceClass: 'browser', ...opts })
  assert.equal(first.granted, true)
  const observed = await observeCapacity(commonGit, opts)
  assert.equal(observed.activeCost, 2)
  assert.ok(observed.available <= observed.limit - 2)
  await releaseAdmission(commonGit, first.reservation.id)
})

test('resource governor steals dead writer lock before timing out', async () => {
  const { requestAdmission, releaseAdmission } = await import('../skills/supervisor/lib/resource-governor.mjs')
  const tmp = mkdtempSync(join(tmpdir(), 'governor-lock-'))
  const commonGit = join(tmp, '.git')
  const governorDir = join(commonGit, 'harness-governor')
  mkdirSync(governorDir, { recursive: true })
  writeFileSync(join(governorDir, 'governor.lock'), '99999999.dead-writer\n')
  const admission = await requestAdmission(commonGit, {
    projectId: 'root',
    context: 'core',
    maxWorkers: 1,
    quotaWorkers: 1,
    cpuPerWorker: 0.25,
    memoryPerWorkerMb: 1,
    reserveMemoryMb: 0,
    maxLoadRatio: 100,
  })
  assert.equal(admission.granted, true)
  assert.equal(existsSync(join(governorDir, 'governor.lock')), false)
  await releaseAdmission(commonGit, admission.reservation.id)
})

test('resource governor denies admission when full', async () => {
  const { requestAdmission, observeCapacity, releaseAdmission } = await import('../skills/supervisor/lib/resource-governor.mjs')
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
  } = await import('../skills/supervisor/lib/supervisor-lease.mjs')
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

test('wake triage always wakes on input_required', async () => {
  const { classify } = await import('../skills/supervisor/lib/wake-triage.mjs')
  assert.deepEqual(classify({ kind: 'input_required', scope: 'context', context: 'core' }), {
    action: 'wake', reason: 'input required',
  })
  assert.deepEqual(classify({ kind: 'input_required', scope: 'goal', context: 'root' }), {
    action: 'wake', reason: 'goal-scoped input required',
  })
})

test('wake triage folds healthy progress and absorbs heartbeats', async () => {
  const { classify, shouldWake, foldProgress } = await import('../skills/supervisor/lib/wake-triage.mjs')
  const fleet = { workers: 2, counts: { total: 10, integrated: 3, blocked: 0 }, status: 'running' }
  const progress = { id: 1, kind: 'progress', workers: 2, total: 10, integrated: 3, blocked: 0 }
  assert.deepEqual(classify(progress, fleet), { action: 'fold', reason: 'routine progress snapshot' })
  assert.deepEqual(classify({ id: 2, kind: 'worker_health', verdict: 'healthy' }, fleet), {
    action: 'absorb', reason: 'healthy worker heartbeat',
  })
  assert.equal(shouldWake([progress, { id: 2, kind: 'worker_health', verdict: 'healthy' }], fleet), false)
  const folded = foldProgress([
    progress,
    { id: 2, kind: 'worker_health', verdict: 'healthy' },
    { id: 3, kind: 'progress', workers: 2, total: 10, integrated: 4, blocked: 0 },
  ], fleet)
  assert.equal(folded.foldedCount, 3)
  assert.equal(folded.progressCount, 2)
  assert.equal(folded.latestProgress.integrated, 4)
})

test('wake triage keeps empty-fleet progress actionable', async () => {
  const { classify, shouldWake } = await import('../skills/supervisor/lib/wake-triage.mjs')
  const { isEmptyFleetActionable, fleetSnapshotFromState } = await import('../skills/supervisor/lib/fleet-snapshot.mjs')
  const fleet = {
    workers: 0,
    counts: { total: 5, integrated: 2, blocked: 1 },
    pendingInputs: 0,
    status: 'running',
  }
  const progress = { id: 4, kind: 'progress', workers: 0, total: 5, integrated: 2, blocked: 1 }
  assert.equal(isEmptyFleetActionable(progress, fleet), true)
  assert.deepEqual(classify(progress, fleet), {
    action: 'wake',
    reason: 'empty fleet with remaining work or pending inputs',
  })
  assert.equal(shouldWake([progress], fleet), true)
  // fleetSnapshotFromState always materializes ghostClaims: []; empty ghosts must not
  // look "repaired" or remaining work would fold instead of wake.
  const fromState = fleetSnapshotFromState({
    status: 'running',
    workers: {},
    progress: { total: 5, integrated: 2, blocked: 1 },
    pendingInputs: {},
    retryQueue: {},
  })
  assert.deepEqual(fromState.ghostClaims, [])
  assert.deepEqual(classify(progress, fromState), {
    action: 'wake',
    reason: 'empty fleet with remaining work or pending inputs',
  })
})

test('wake triage wakes on stale Goal Review with integrated queue', async () => {
  const { classify, shouldWake } = await import('../skills/supervisor/lib/wake-triage.mjs')
  const { needsGoalReviewRetry } = await import('../skills/supervisor/lib/fleet-snapshot.mjs')
  const fleet = {
    workers: 0,
    counts: { total: 2, integrated: 2, blocked: 0 },
    pendingInputs: 0,
    retryQueueSize: 0,
    status: 'running',
    queueComplete: true,
    integrationHead: 'head-new',
    reviewedHead: 'head-old',
  }
  assert.equal(needsGoalReviewRetry(fleet), true)
  const progress = { id: 9, kind: 'progress', workers: 0, total: 2, integrated: 2, blocked: 0 }
  assert.deepEqual(classify(progress, fleet), {
    action: 'wake',
    reason: 'stale Goal Review with integrated queue',
  })
  assert.equal(shouldWake([progress], fleet), true)
})

test('wake triage wakes on stuck workers and immediate failures', async () => {
  const { classify, shouldWake } = await import('../skills/supervisor/lib/wake-triage.mjs')
  const stuck = { id: 5, kind: 'worker_stuck', context: 'core' }
  const health = { id: 6, kind: 'worker_health', verdict: 'stuck', context: 'core' }
  assert.deepEqual(classify(stuck), { action: 'wake', reason: 'worker_stuck' })
  assert.deepEqual(classify(health), { action: 'wake', reason: 'worker health stuck' })
  assert.equal(shouldWake([stuck, health]), true)
})

test('wake triage fleet snapshot from supervisor state', async () => {
  const { classify } = await import('../skills/supervisor/lib/wake-triage.mjs')
  const { fleetSnapshotFromState } = await import('../skills/supervisor/lib/fleet-snapshot.mjs')
  const fleet = fleetSnapshotFromState({
    status: 'running',
    workers: { core: { context: 'core' } },
    progress: { total: 3, integrated: 1, blocked: 0 },
    pendingInputs: { 7: { status: 'pending', kind: 'input_required' } },
    retryQueue: { ghost: { guidance: 'retry' } },
  })
  assert.equal(fleet.workers, 1)
  assert.equal(fleet.pendingInputs, 1)
  assert.equal(fleet.retryQueueSize, 1)
  const progress = { id: 8, kind: 'progress', workers: 0, total: 3, integrated: 1 }
  assert.deepEqual(classify(progress, fleet).action, 'fold')
  const staleProgress = { id: 9, kind: 'progress', workers: 0, total: 3, integrated: 1, blocked: 1 }
  const emptyFleet = fleetSnapshotFromState({
    status: 'running',
    workers: {},
    progress: { total: 3, integrated: 1, blocked: 1 },
    pendingInputs: {},
    retryQueue: {},
  }, { ghostClaims: [{ context: 'ghost' }] })
  assert.deepEqual(classify(staleProgress, emptyFleet).action, 'wake')
})

test('fleet snapshot builds structured multi-project bearings', async () => {
  const {
    FLEET_SNAPSHOT_SCHEMA,
    buildFleetSnapshot,
    buildProjectSnapshot,
    fleetSnapshotFromState,
  } = await import('../skills/supervisor/lib/fleet-snapshot.mjs')
  assert.equal(FLEET_SNAPSHOT_SCHEMA, 'harness-fleet-snapshot.v1')

  const stateA = {
    status: 'running',
    workers: { core: { type: 'background', pid: 42 } },
    workerHealth: { core: { verdict: 'healthy' }, ghost: { verdict: 'stuck', reason: 'no output' } },
    pendingInputs: { 3: { status: 'pending' } },
    retryQueue: {},
    capacity: { limit: 2, available: 1, slots: 1, active: 1 },
    progress: { total: 4, integrated: 2 },
  }
  const project = buildProjectSnapshot({
    id: 'appA',
    root: '/repo/appA',
    state: stateA,
    eventsTip: 17,
    wakeTriage: { shouldWake: true },
    processAlive: (pid) => pid === 42,
  })
  assert.equal(project.id, 'appA')
  assert.equal(project.journalTip, 17)
  assert.equal(project.workers, 1)
  assert.equal(project.pendingInputs, 1)
  assert.equal(project.stuck.length, 1)
  assert.equal(project.stuck[0].context, 'ghost')
  assert.deepEqual(project.wakeTriage, { shouldWake: true })

  const fleet = buildFleetSnapshot({
    projects: [
      {
        id: 'appA',
        root: '/repo/appA',
        state: stateA,
        eventsTip: 17,
        wakeTriage: { shouldWake: true },
        processAlive: (pid) => pid === 42,
      },
      { id: 'appB', state: { status: 'complete' }, eventsTip: 9 },
    ],
  })
  assert.equal(fleet.schema, FLEET_SNAPSHOT_SCHEMA)
  assert.equal(fleet.projects.length, 2)
  assert.equal(fleet.projects[1].status, 'complete')
  assert.equal(fleetSnapshotFromState(stateA, { processAlive: (pid) => pid === 42 }).workers, 1)
  const staleWorker = fleetSnapshotFromState({
    status: 'running',
    workers: { core: { type: 'background', pid: 99999999 } },
    progress: { total: 2, integrated: 0, blocked: 0 },
    pendingInputs: {},
    retryQueue: {},
  }, { processAlive: () => false })
  assert.equal(staleWorker.workers, 0)
  assert.equal(staleWorker.emptyFleetActionable, true)
  const opsProject = buildProjectSnapshot({
    state: stateA,
    hostResources: { memory: { availableMb: 1000 }, swap: { usedMb: 0 } },
    governorReservations: { activeCost: 2 },
    sharedRuntime: { projects: { root: { holders: { core: {} } } } },
    recoveryReasons: [{ kind: 'capacity_zero', reason: 'memory' }],
    pressureAdvice: 'admission deferred by memory',
  })
  assert.equal(opsProject.governorReservations.activeCost, 2)
  assert.equal(opsProject.sharedRuntime.projects.root.holders.core != null, true)
  assert.equal(opsProject.recoveryReasons[0].kind, 'capacity_zero')
})

test('runtime recovery planner emits deterministic repair events', () => {
  const plan = planRuntimeRecovery({
    active: 0,
    fleet: { emptyFleetActionable: true },
    ghostClaims: [{ context: 'core', health: { reason: 'dead-owner-or-child' } }],
    staleLocks: [{ lock: 'merge', reason: 'dead-holder' }],
    crashCounts: { core: 5 },
    snapshotCounts: { total: 2, integrated: 0 },
    pressureReason: 'swap',
  })
  assert.equal(plan.repaired, true)
  assert.deepEqual(plan.statePatch.crashCounts, {})
  assert.ok(plan.actions.some((action) => action.kind === 'abandon_ghost'))
  assert.ok(plan.events.some((event) => event.kind === 'dead_runtime'))
  const emptyFleet = plan.events.find((event) => event.kind === 'empty_fleet_actionable')
  assert.equal(emptyFleet.detail.pressureReason, 'swap')
  const unpressured = planRuntimeRecovery({ active: 0, fleet: { emptyFleetActionable: true } })
  assert.equal(unpressured.events.find((event) => event.kind === 'empty_fleet_actionable').detail.pressureReason, null)
})

test('empty fleet emit debounce suppresses only identical recent detail', () => {
  const detail = { workers: 0, ghostCount: 0, repaired: false, pressureReason: 'swap', remaining: { total: 2 } }
  assert.equal(shouldEmitEmptyFleet(null, detail, 1_000), true)
  const last = { detail, at: 1_000 }
  assert.equal(shouldEmitEmptyFleet(last, { ...detail }, 30_000), false)
  assert.equal(shouldEmitEmptyFleet(last, { ...detail, pressureReason: null }, 30_000), true)
  assert.equal(shouldEmitEmptyFleet(last, { ...detail }, 61_000), true)
})

test('tick context computes event-driven delay with poll fallback', () => {
  assert.equal(nextTickDelay({ pollMs: 2000, dirty: true }), 50)
  assert.equal(nextTickDelay({ pollMs: 2000, eventDriven: false, dirty: true }), 2000)
  const watched = tickWatchPaths({ controlRoot: '/c', runsDir: '/r', commonGit: '/g' })
  assert.ok(watched.includes('/c/responses'))
  assert.equal(watched.includes('/c'), false)
})

test('resolveGeneratorDir prefers complete harness-generator over incomplete generator alias', async () => {
  const {
    generatorRuntimeReady,
    resolveGeneratorDir,
    tickFailureDelay,
    GENERATOR_RUNTIME_MARKERS,
  } = await import('../skills/supervisor/lib/runtime-layout.mjs')
  const root = mkdtempSync(join(tmpdir(), 'harness-runtime-layout-'))
  const skills = join(root, 'skills')
  const scriptFile = join(skills, 'harness-supervisor', 'scripts', 'harness-control.mjs')
  mkdirSync(dirname(scriptFile), { recursive: true })
  writeFileSync(scriptFile, '// stub\n')

  const incomplete = join(skills, 'generator')
  mkdirSync(join(incomplete, 'lib'), { recursive: true })
  writeFileSync(join(incomplete, 'orchestrator.mjs'), '// incomplete\n')
  writeFileSync(join(incomplete, 'lib', 'observation-method.mjs'), '// present\n')
  // adapters/hosts.mjs intentionally missing

  const complete = join(skills, 'harness-generator')
  mkdirSync(join(complete, 'lib'), { recursive: true })
  mkdirSync(join(complete, 'adapters'), { recursive: true })
  for (const rel of GENERATOR_RUNTIME_MARKERS) {
    const abs = join(complete, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, '// ok\n')
  }

  assert.equal(generatorRuntimeReady(incomplete), false)
  assert.equal(generatorRuntimeReady(complete), true)
  assert.equal(resolveGeneratorDir(scriptFile), complete)

  assert.equal(tickFailureDelay({ pollMs: 2000, consecutiveFailures: 0 }), 2000)
  assert.equal(tickFailureDelay({ pollMs: 2000, consecutiveFailures: 1 }), 4000)
  assert.equal(tickFailureDelay({ pollMs: 2000, consecutiveFailures: 2 }), 8000)
  assert.ok(tickFailureDelay({ pollMs: 2000, consecutiveFailures: 20 }) <= 60_000)
})

test('mergeLockHolder tolerates missing owner file (ENOENT race)', async () => {
  const { mergeLockHolder } = await import('../skills/generator/lib/claim-lease.mjs')
  const root = mkdtempSync(join(tmpdir(), 'harness-merge-lock-'))
  mkdirSync(join(root, '.git'), { recursive: true })
  // No generator-merge dir → unlocked
  assert.deepEqual(mergeLockHolder(root), { busy: false, owner: '', host: '' })
  // Empty lock dir (no owner) → unlocked, must not throw
  mkdirSync(join(root, '.git', 'harness-locks', 'generator-merge'), { recursive: true })
  assert.deepEqual(mergeLockHolder(root), { busy: false, owner: '', host: '' })
})

test('fleet snapshot ops fields derive supervisor, ghosts, and run_completed summary', async () => {
  const {
    buildProjectSnapshot,
    fleetSnapshotFromState,
    lastRunCompletedSummaryFromEvents,
    deriveSupervisorLive,
    isEmptyFleetRepaired,
  } = await import('../skills/supervisor/lib/fleet-snapshot.mjs')

  const events = [
    { id: 1, kind: 'progress' },
    { id: 2, kind: 'run_completed', summary: 'Goal Review passed' },
  ]
  assert.equal(lastRunCompletedSummaryFromEvents(events), 'Goal Review passed')
  assert.equal(deriveSupervisorLive({ supervisorPid: process.pid }, {
    processAlive: (pid) => pid === process.pid,
    localHost: 'local',
  }), true)

  const project = buildProjectSnapshot({
    id: 'appA',
    state: {
      status: 'running',
      supervisorPid: null,
      workers: {},
      progress: { total: 3, integrated: 1, blocked: 1 },
      pendingInputs: {},
      retryQueue: {},
    },
    events,
    ghostClaims: [{ context: 'ghost' }],
    wakeExtended: {
      queueComplete: false,
      integrationHead: '',
      reviewedHead: '',
      retryGoalReview: false,
    },
  })
  assert.equal(project.supervisorLive, false)
  assert.equal(project.ghostClaims.length, 1)
  assert.equal(project.emptyFleetActionable, true)
  assert.equal(project.needsGoalReviewRetry, false)
  assert.equal(project.lastRunCompletedSummary, 'Goal Review passed')

  const repairedFleet = fleetSnapshotFromState(
    { status: 'running', workers: {}, progress: { total: 3, integrated: 1, blocked: 1 } },
    { ghostClaims: [], repaired: true },
  )
  assert.equal(isEmptyFleetRepaired(repairedFleet), true)
})

test('wake triage hybrid empty-fleet rules absorb repaired actionable events', async () => {
  const { classify, shouldWake } = await import('../skills/supervisor/lib/wake-triage.mjs')
  const fleet = {
    workers: 0,
    counts: { total: 5, integrated: 2, blocked: 1 },
    pendingInputs: 0,
    status: 'running',
    ghostClaims: [],
    repaired: true,
    emptyFleetActionable: true,
  }
  const progress = { id: 4, kind: 'progress', workers: 0, total: 5, integrated: 2, blocked: 1 }
  assert.deepEqual(classify(progress, fleet), {
    action: 'fold',
    reason: 'routine progress snapshot',
  })
  assert.deepEqual(classify({
    id: 5,
    kind: 'empty_fleet_actionable',
    workers: 0,
    ghostCount: 0,
    repaired: true,
  }, fleet), {
    action: 'absorb',
    reason: 'empty fleet repaired by tick',
  })
  assert.deepEqual(classify({
    id: 6,
    kind: 'dead_runtime',
    repaired: true,
    ghostContexts: [],
  }, fleet), {
    action: 'fold',
    reason: 'dead runtime repaired by tick',
  })
  assert.deepEqual(classify({
    id: 7,
    kind: 'dead_runtime',
    repaired: false,
    ghostContexts: ['ghost'],
  }, fleet), {
    action: 'wake',
    reason: 'dead runtime needs operator attention',
  })
  assert.equal(shouldWake([progress], fleet), false)
})

test('observation admission gate maps phase and blocks weak-only validation hosts', async () => {
  const {
    validationKindFromAdmission,
    observationAdmissionCheck,
    observationMethodsForQueue,
  } = await import('../skills/generator/lib/observation-method.mjs')
  assert.equal(validationKindFromAdmission({ mode: 'goal-review' }), 'GOAL_REVIEW')
  assert.equal(validationKindFromAdmission({ phase: 'qa' }), 'QA')
  assert.equal(validationKindFromAdmission({ phase: 'coding' }), null)

  const gate = observationAdmissionCheck({
    kind: 'QA',
    roles: { validation: [{ harness: 'pi', model: 'x' }] },
    observationMethods: ['http'],
    host: 'claude',
  })
  assert.equal(gate.ok, false)
  assert.match(gate.reason, /Observation Hard Gate/)

  const methods = observationMethodsForQueue([
    { id: 'WI-1', category: 'functional', description: 'GET /health returns 200', acceptance_checks: [] },
    { id: 'WI-2', category: 'static', description: 'grep LICENSE', acceptance_checks: [] },
  ])
  assert.ok(methods.includes('http'))
})

test('buildFleetSnapshot supports multi-project inputs', async () => {
  const { buildFleetSnapshot } = await import('../skills/supervisor/lib/fleet-snapshot.mjs')
  const fleet = buildFleetSnapshot({
    projects: [
      {
        id: 'appA',
        root: '/repo/appA',
        state: { status: 'running', workers: { core: {} }, progress: { total: 2, integrated: 1 } },
        eventsTip: 3,
        ghostClaims: [],
      },
      {
        id: 'appB',
        root: '/repo/appB',
        state: { status: 'running', workers: {}, progress: { total: 4, integrated: 0, blocked: 2 } },
        eventsTip: 8,
        ghostClaims: [{ context: 'ghost' }],
      },
    ],
  })
  assert.equal(fleet.projects.length, 2)
  assert.equal(fleet.projects[0].workers, 1)
  assert.equal(fleet.projects[1].emptyFleetActionable, true)
  assert.equal(fleet.projects[1].ghostClaims.length, 1)
})

test('evidence-corpus scans verdicts and proposes skill routes', async () => {
  const {
    scan,
    extractVerdicts,
    clusterDefects,
    recurrenceReport,
    proposeRoutes,
  } = await import('../skills/learning-loop/lib/evidence-corpus.mjs')
  const { VERDICT_BEGIN, VERDICT_END } = await import('../skills/generator/lib/worker-outcome.mjs')
  const tmp = mkdtempSync(join(tmpdir(), 'evidence-corpus-'))
  const evidenceDir = join(tmp, '.git', 'harness-evidence', 'root', 'run-a', 'core')
  mkdirSync(evidenceDir, { recursive: true })
  const verdictBody = `${VERDICT_BEGIN}\n${JSON.stringify({
    implementation: false,
    defects: ['empty title rejected'],
    notes: 'validation gap',
  })}\n${VERDICT_END}`
  writeFileSync(join(evidenceDir, 'WI-1-1-qa-abc.log'), [
    'project=root',
    'run=run-a',
    'context=core',
    'id=WI-1',
    'attempt=1',
    'kind=qa',
    'digest=abc',
    'at=2026-01-01T00:00:00.000Z',
    '',
    verdictBody,
  ].join('\n'))
  writeFileSync(join(evidenceDir, 'WI-2-1-qa-def.log'), [
    'project=root',
    'run=run-a',
    'context=core',
    'id=WI-2',
    'attempt=1',
    'kind=qa',
    'digest=def',
    'at=2026-01-02T00:00:00.000Z',
    '',
    verdictBody,
  ].join('\n'))
  writeFileSync(join(evidenceDir, 'broken.log'), 'partial header without body')
  writeFileSync(join(evidenceDir, 'bad-json.log'), [
    'project=root',
    'id=WI-3',
    'kind=qa',
    'attempt=1',
    '',
    '{not json',
  ].join('\n'))

  const corpus = await scan({ repo: tmp })
  assert.equal(corpus.count, 2)
  assert.ok(corpus.skipped.partial >= 1)
  assert.ok(corpus.skipped.nonJson >= 1)

  const verdicts = extractVerdicts(corpus)
  assert.equal(verdicts.length, 2)
  const clusters = clusterDefects(verdicts)
  const recurring = recurrenceReport(clusters, 2)
  assert.ok(recurring.length >= 1)
  const routes = proposeRoutes(recurring)
  assert.ok(routes.some((row) => row.route.startsWith('skills/')))
  assert.ok(routes.every((row) => !row.route.includes('..')))
})

test('control-beacon blocks soft stop and allows force when authorized', async () => {
  const {
    beaconSnapshot,
    stopAllowed,
    turnEndDrain,
    DEFAULT_REQUIRED_CONSUMERS,
  } = await import('../skills/supervisor/lib/control-beacon.mjs')

  const live = beaconSnapshot({
    workers: [{ context: 'core', pid: process.pid, live: true }],
    journalTip: 5,
    consumerCursors: { 'herdr-notify': { eventId: 5 } },
    pendingInputs: {},
    processAlive: (pid) => pid === process.pid,
  })
  assert.equal(stopAllowed('soft', live).allowed, false)
  assert.match(stopAllowed('soft', live).reason, /live workers/)

  const idle = beaconSnapshot({
    workers: [{ context: 'core', live: false }],
    journalTip: 5,
    consumerCursors: { 'herdr-notify': { eventId: 5 } },
    pendingInputs: {},
  })
  assert.equal(stopAllowed('soft', idle).allowed, true)

  const behind = beaconSnapshot({
    workers: [],
    journalTip: 10,
    consumerCursors: { 'herdr-notify': { eventId: 3 } },
    pendingInputs: {},
    requiredConsumers: DEFAULT_REQUIRED_CONSUMERS,
  })
  assert.equal(stopAllowed('soft', behind).allowed, false)
  assert.match(stopAllowed('soft', behind).reason, /behind journal tip/)

  const pending = beaconSnapshot({
    workers: [],
    journalTip: 2,
    consumerCursors: { 'herdr-notify': { eventId: 2 } },
    pendingInputs: { 1: { kind: 'input_required', status: 'pending' } },
  })
  assert.equal(stopAllowed('soft', pending).allowed, false)
  assert.match(stopAllowed('soft', pending).reason, /input_required/)

  assert.equal(stopAllowed('force', idle, { authorized: false }).allowed, false)
  assert.equal(stopAllowed('force', live, { authorized: true }).allowed, true)
  assert.deepEqual(turnEndDrain(), { waitForFinalizers: true })
})

test('control-beacon worker without pid and without live run-state is not live', async () => {
  const {
    resolveWorkerLive,
    beaconSnapshot,
    stopAllowed,
  } = await import('../skills/supervisor/lib/control-beacon.mjs')

  const dead = () => false
  const workerRow = { type: 'background', context: 'core' }

  assert.equal(resolveWorkerLive(workerRow, {
    processAlive: dead,
    runState: {},
  }), false)

  assert.equal(resolveWorkerLive(workerRow, {
    processAlive: dead,
    runState: { ownerPid: 42, status: 'running' },
  }), false)

  assert.equal(resolveWorkerLive(workerRow, {
    processAlive: (pid) => pid === 42,
    runState: { ownerPid: 42, status: 'running' },
  }), true)

  const staleWorker = beaconSnapshot({
    workers: [workerRow],
    journalTip: 5,
    consumerCursors: { 'herdr-notify': { eventId: 5 } },
    pendingInputs: {},
    processAlive: dead,
  })
  assert.equal(staleWorker.liveWorkerCount, 0)
  assert.equal(stopAllowed('soft', staleWorker).allowed, true)

  const liveWorker = beaconSnapshot({
    workers: [{
      ...workerRow,
      runState: { ownerPid: 99, status: 'running' },
    }],
    journalTip: 5,
    consumerCursors: { 'herdr-notify': { eventId: 5 } },
    pendingInputs: {},
    processAlive: (pid) => pid === 99,
  })
  assert.equal(liveWorker.liveWorkerCount, 1)
  assert.equal(stopAllowed('soft', liveWorker).allowed, false)
})
