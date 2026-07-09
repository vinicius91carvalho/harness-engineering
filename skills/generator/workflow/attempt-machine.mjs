/** Attempt loop for Work Items — coding, QA, integration, repair planning. */

export async function runAttemptLoop(ctx) {
  const {
    wanted,
    options,
    getState,
    setState,
    stateFile,
    reconcileScript,
    MAX_ATTEMPTS,
    MAX_OPERATIONAL_FAILURES,
    fail,
    command,
    readFeatures,
    updateFeature,
    journal,
    commitPaths,
    writeState,
    verifyFirstCache,
    isVerifyFirst,
    buildPlan,
    readRoles,
    block,
    planRepair,
    integrate,
    runAgent,
    featurePrompt,
    stopApp,
    join,
    context,
    setHeartbeatTimer,
    setItemPlan,
    lastCoder,
    bumpStrike,
    backoffIfRateLimited,
    appPid,
  } = ctx

  if (!wanted.length) fail('--features is required outside goal-review mode')
  command(process.execPath, [reconcileScript, options.workdir, '--check'], options.workdir)
  const initialState = await ctx.readJson(stateFile, {})
  setState(initialState)
  let state = getState()

  if (initialState.status === 'blocked' && !options.guidance) fail('blocked work requires --guidance for explicit Resume')
  if (initialState.status === 'blocked') {
    const id = initialState.currentFeatureId || wanted[0]
    await updateFeature(options.workdir, id, { implementation: false, qa: false, integration: false, retries: 0 })
    const file = await journal(options.workdir, 'Explicit Resume', {
      WorkItem: id, Outcome: 'user authorized a new Attempt cycle', Guidance: options.guidance, NextAction: 'Coding Attempt 1',
    })
    commitPaths(options.workdir, [file, join(options.workdir, 'feature_list.json')], `chore(harness): resume ${id} with guidance`)
    setState({
      ...initialState, phase: 'resume', attempt: 1, nextAction: 'coding',
      repairPlan: { summary: 'User guidance', rootCause: 'user-directed', actions: [options.guidance], validation: [] },
    })
    state = getState()
  } else if (initialState.status === 'resuming' || initialState.status === 'interrupted') {
    const file = await journal(options.workdir, 'Resumed', {
      WorkItem: initialState.currentFeatureId || wanted[0], PreviousPhase: initialState.previousPhase || initialState.phase,
      Attempt: initialState.attempt, NextAction: initialState.nextAction,
    })
    commitPaths(options.workdir, [file], `chore(harness): resume ${context}`)
  }
  await writeState({ status: 'running', phase: state.phase || 'starting', nextAction: state.nextAction || 'coding', featureIds: wanted })
  setHeartbeatTimer(setInterval(() => writeState().catch(() => {}), 15_000))
  verifyFirstCache.set(options.workdir, await isVerifyFirst(options.workdir))
  const initial = await readFeatures()
  const selected = wanted.map((id) => initial.list.find((feature) => String(feature.id) === id))
  if (selected.some((feature) => !feature)) fail(`unknown Work Item id in --features: ${wanted.join(',')}`)
  const results = []

  for (const original of selected) {
    let state = getState()
    let current = (await readFeatures()).list.find((item) => String(item.id) === String(original.id))
    if (current.integration === true) { results.push({ id: current.id, status: 'passed' }); continue }
    setItemPlan(buildPlan(await readRoles()))
    const itemPlan = ctx.getItemPlan()
    const resumingCurrent = String(state.currentFeatureId) === String(current.id)
    let attempt = resumingCurrent ? Number(state.attempt || current.retries + 1 || 1) : Number(current.retries || 0) + 1
    let repairPlan = resumingCurrent ? state.repairPlan : null
    let operationalFailures = 0

    if (attempt > MAX_ATTEMPTS) { results.push(await block(current, MAX_ATTEMPTS, 'Attempt budget already exhausted')); break }
    if (resumingCurrent && state.nextAction === 'repair-plan' && state.defectReport) {
      repairPlan = await planRepair(current, attempt, state.defectReport)
      attempt++
    }
    while (attempt <= MAX_ATTEMPTS) {
      current = (await readFeatures()).list.find((item) => String(item.id) === String(original.id))
      if (current.implementation !== true) {
        await writeState({ currentFeatureId: current.id, attempt, nextAction: 'coding', repairPlan })
        const coded = await runAgent('CODING', featurePrompt('CODING', current, attempt, repairPlan), current.id, attempt)
        if (coded.ok && coded.parsed?.implementation === true) {
          await updateFeature(options.workdir, current.id, { implementation: true })
          commitPaths(options.workdir, [join(options.workdir, 'feature_list.json')], `chore(harness): record coding ${current.id}`)
        }
        current = (await readFeatures()).list.find((item) => String(item.id) === String(original.id))
        if (coded.ok && coded.parsed?.implementation === false) {
          const declineEvidence = [coded.parsed.notes || coded.detail]
          if (!itemPlan) { results.push(await block(current, attempt, 'coding agent declined the Work Item', declineEvidence)); break }
          itemPlan.coderDeclines = (itemPlan.coderDeclines || 0) + 1
          const poolSize = itemPlan.sortedRoles.coding.length + (itemPlan.roles.noCredits?.length || 0)
          if (Math.floor((attempt - 1) / Number(process.env.HARNESS_REPAIR_BUDGET || 2)) + itemPlan.coderDeclines >= poolSize) {
            results.push(await block(current, attempt, 'every coding candidate declined the Work Item', declineEvidence)); break
          }
          continue
        }
        if (!coded.ok || current.implementation !== true) {
          operationalFailures++
          if (operationalFailures >= MAX_OPERATIONAL_FAILURES) { results.push(await block(current, attempt, 'coding agent failed three times', [coded.detail])); break }
          await backoffIfRateLimited(coded.detail)
          continue
        }
        operationalFailures = 0
        await writeState({ appPid: await appPid(options.workdir) })
      }

      if (current.qa !== true) {
        await writeState({ nextAction: 'qa', phase: 'qa' })
        const checked = await runAgent('QA', featurePrompt('QA', current, attempt), current.id, attempt)
        if (checked.ok && checked.parsed?.implementation === true && checked.parsed?.qa === true) {
          await updateFeature(options.workdir, current.id, { implementation: true, qa: true })
          commitPaths(options.workdir, [join(options.workdir, 'feature_list.json')], `chore(harness): record QA ${current.id}`)
          const coder = itemPlan && lastCoder()
          if (coder) bumpStrike('quality', `quality|coding|${coder}`, -1)
        }
        current = (await readFeatures()).list.find((item) => String(item.id) === String(original.id))
        if (!checked.ok && !checked.parsed) {
          operationalFailures++
          if (operationalFailures >= MAX_OPERATIONAL_FAILURES) { results.push(await block(current, attempt, 'QA agent failed three times', [checked.detail])); break }
          await backoffIfRateLimited(checked.detail)
          continue
        }
        operationalFailures = 0
        await writeState({ appPid: await appPid(options.workdir) })
        if (current.implementation !== true || current.qa !== true) {
          const defectReport = {
            defects: checked.parsed?.defects?.length ? checked.parsed.defects : [checked.detail.slice(-2000) || 'QA failed'],
            evidence: checked.artifact,
          }
          await writeState({ phase: 'qa-defect', nextAction: 'repair-plan', defectReport, attempt })
          if (attempt >= MAX_ATTEMPTS) { results.push(await block(current, attempt, 'QA failed after Attempt 3', defectReport.defects)); break }
          const coder = itemPlan && lastCoder()
          if (coder) bumpStrike('quality', `quality|coding|${coder}`, 1)
          repairPlan = await planRepair(current, attempt, defectReport)
          attempt++
          continue
        }
      }

      const integrated = await integrate(current, attempt)
      if (integrated.passed) { results.push({ id: current.id, status: 'passed' }); break }
      if (integrated.operational) {
        results.push(await block(current, attempt, 'integration could not complete', integrated.defects)); break
      }
      await writeState({
        phase: 'integration-defect', nextAction: 'repair-plan',
        defectReport: { defects: integrated.defects, evidence: integrated.evidence }, attempt,
      })
      if (attempt >= MAX_ATTEMPTS) { results.push(await block(current, attempt, 'Integrated Verification failed after Attempt 3', integrated.defects)); break }
      repairPlan = await planRepair(current, attempt, { defects: integrated.defects, evidence: integrated.evidence })
      attempt++
    }
    if (results.at(-1)?.status === 'blocked') break
  }

  await stopApp(options.workdir)
  const heartbeatTimer = ctx.getHeartbeatTimer()
  clearInterval(heartbeatTimer)
  const stuck = results.filter((result) => result.status === 'blocked')
  await writeState({ status: stuck.length ? 'blocked' : 'complete', phase: stuck.length ? 'blocked' : 'complete', nextAction: stuck.length ? 'user-guidance' : 'release-claim', childPid: null })
  return { total: selected.length, passed: results.filter((result) => result.status === 'passed').length, stuck, results }
}
