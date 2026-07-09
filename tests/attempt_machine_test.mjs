import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { runAttemptLoop } from '../skills/generator/workflow/attempt-machine.mjs'

/**
 * Builds a minimal, in-memory fake of every port `runAttemptLoop` depends on.
 * `agentRunSequence` is a queue of `{ kind, result }` steps consumed in call order;
 * each step's `kind` is asserted against the actual call to catch drift early.
 */
function makeFakePorts({ featureId = 'WI-1', context = 'core', agentRunSequence = [] } = {}) {
  const workdir = '/fake/workdir'
  const queueDb = [{ id: featureId, context, implementation: false, qa: false, integration: false, retries: 0 }]
  let fakeState = {}
  let heartbeatTimer = null
  const calls = { agentRun: [], planRepair: 0, integrate: 0, block: 0, stopApp: 0 }
  const remaining = [...agentRunSequence]

  const findFeature = (id) => queueDb.find((item) => String(item.id) === String(id))

  async function updateFeature(_workdir, id, changes) {
    const feature = findFeature(id)
    Object.assign(feature, changes)
    return feature
  }

  const ports = {
    wanted: [featureId],
    options: { workdir },
    context,
    constants: { MAX_ATTEMPTS: 3, MAX_OPERATIONAL_FAILURES: 3, reconcileScript: '/fake/reconcile.mjs' },
    fail: (message) => { throw new Error(message) },
    command: () => ({ status: 0, stdout: '', stderr: '' }),
    join,
    state: {
      get: () => fakeState,
      set: (next) => { fakeState = next },
      write: async (change = {}) => { fakeState = { ...fakeState, ...change }; return fakeState },
      readJson: async () => ({}),
      stateFile: '/fake/state.json',
      journal: async () => '/fake/journal.md',
      commitPaths: () => {},
      block: async (feature, attempt, reason, defects = []) => {
        calls.block++
        await updateFeature(workdir, feature.id, { implementation: false, qa: false, integration: false, retries: attempt })
        return { id: feature.id, status: 'blocked', reason, defects }
      },
      setHeartbeatTimer: (timer) => { heartbeatTimer = timer },
      getHeartbeatTimer: () => heartbeatTimer,
    },
    queue: {
      readFeatures: async () => ({ list: queueDb.map((item) => ({ ...item })) }),
      updateFeature,
    },
    agent: {
      run: async (kind, _prompt, id, attempt) => {
        const step = remaining.shift()
        if (!step) throw new Error(`agent.run called with no scripted step left (kind=${kind}, attempt=${attempt})`)
        assert.equal(kind, step.kind, `expected agent.run(${step.kind}, ...) but got agent.run(${kind}, ...)`)
        calls.agentRun.push({ kind, id, attempt })
        return step.result
      },
      featurePrompt: (kind) => `prompt-for-${kind}`,
      planRepair: async (feature, attempt) => {
        calls.planRepair++
        await updateFeature(workdir, feature.id, { implementation: false, qa: false, integration: false, retries: attempt })
        return { summary: 'repair planned', rootCause: 'defect', actions: ['fix it'], validation: [] }
      },
      backoffIfRateLimited: async () => {},
      lastCoder: () => null,
      bumpStrike: () => {},
      buildPlan: () => null,
      readRoles: async () => null,
      setItemPlan: () => {},
      getItemPlan: () => null,
    },
    integrate: {
      run: async () => { calls.integrate++; return { passed: true } },
      stopApp: async () => { calls.stopApp++ },
      appPid: async () => null,
    },
    verifyFirst: {
      cache: new Map(),
      isVerifyFirst: async () => false,
    },
  }

  return { ports, calls, queueDb }
}

test('happy path: coding ok -> QA ok -> integrate passed -> complete', async () => {
  const { ports, calls } = makeFakePorts({
    agentRunSequence: [
      { kind: 'CODING', result: { ok: true, parsed: { implementation: true }, detail: '', artifact: 'coding.log' } },
      { kind: 'QA', result: { ok: true, parsed: { implementation: true, qa: true }, detail: '', artifact: 'qa.log' } },
    ],
  })

  const result = await runAttemptLoop(ports)

  assert.equal(result.total, 1)
  assert.equal(result.passed, 1)
  assert.deepEqual(result.stuck, [])
  assert.deepEqual(result.results, [{ id: 'WI-1', status: 'passed' }])
  assert.deepEqual(calls.agentRun.map((call) => call.kind), ['CODING', 'QA'])
  assert.equal(calls.integrate, 1)
  assert.equal(calls.block, 0)
  assert.equal(calls.stopApp, 1)
  assert.equal(ports.state.get().status, 'complete')
})

test('QA fail -> planRepair -> second attempt -> pass', async () => {
  const { ports, calls } = makeFakePorts({
    agentRunSequence: [
      { kind: 'CODING', result: { ok: true, parsed: { implementation: true }, detail: '', artifact: 'coding-1.log' } },
      { kind: 'QA', result: { ok: true, parsed: { implementation: true, qa: false, defects: ['button missing'] }, detail: '', artifact: 'qa-1.log' } },
      { kind: 'CODING', result: { ok: true, parsed: { implementation: true }, detail: '', artifact: 'coding-2.log' } },
      { kind: 'QA', result: { ok: true, parsed: { implementation: true, qa: true }, detail: '', artifact: 'qa-2.log' } },
    ],
  })

  const result = await runAttemptLoop(ports)

  assert.equal(result.total, 1)
  assert.equal(result.passed, 1)
  assert.deepEqual(result.stuck, [])
  assert.deepEqual(result.results, [{ id: 'WI-1', status: 'passed' }])
  assert.deepEqual(calls.agentRun.map((call) => call.kind), ['CODING', 'QA', 'CODING', 'QA'])
  assert.deepEqual(calls.agentRun.map((call) => call.attempt), [1, 1, 2, 2])
  assert.equal(calls.planRepair, 1)
  assert.equal(calls.integrate, 1)
  assert.equal(calls.block, 0)
  assert.equal(ports.state.get().status, 'complete')
})
