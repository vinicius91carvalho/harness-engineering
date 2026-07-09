/** Integrated Verification checkpoint: merge to main, resolve conflicts, run integration QA. */

import { mergeDo, mergeRelease } from './claim-lease.mjs'

export const MARKER_PATTERN = /^(<{7} |={7}$|>{7} )/m

export function hasMergeMarkers(content) {
  return MARKER_PATTERN.test(content)
}

export function stillMarkedConflictFiles(git, integrationDir, conflictedFiles) {
  return conflictedFiles.some((relPath) => {
    const shown = git(['show', `HEAD:${relPath}`], integrationDir, true)
    return shown.status === 0 && hasMergeMarkers(shown.stdout)
  })
}

export async function integrateCheckpoint(ctx) {
  const {
    feature,
    attempt,
    workdir,
    repo,
    maxAttempts,
    git,
    runAgent,
    featurePrompt,
    stopApp,
    journal,
    commitPaths,
    updateFeature,
    readFeatures,
    writeState,
    syncWorkdirWithMain,
    join,
    acquireMergeLock,
  } = ctx

  await stopApp(workdir)
  const journalFile = await journal(workdir, 'Checkpoint ready', {
    Attempt: `${attempt}/${maxAttempts}`, WorkItem: feature.id, Outcome: 'isolated QA passed', NextAction: 'Integrated Verification',
  })
  commitPaths(workdir, [journalFile], `chore(harness): checkpoint ${feature.id}`)
  const checkpointSha = git(['rev-parse', 'HEAD'], workdir).stdout.trim()
  const integrationDir = await acquireMergeLock()
  const preMergeSha = git(['rev-parse', 'HEAD'], integrationDir).stdout.trim()
  try {
    await writeState({ phase: 'merge', nextAction: 'merge', integrationDir })
    const merged = mergeDo(repo, feature.context, integrationDir)
    if (merged.status === 'conflict') {
      const conflictedFiles = merged.paths || []
      const resolved = await runAgent('MERGE', featurePrompt('MERGE', feature, attempt, null, integrationDir), feature.id, attempt, integrationDir)
      const unmerged = git(['diff', '--name-only', '--diff-filter=U'], integrationDir).stdout.trim()
      const stillMarked = stillMarkedConflictFiles(git, integrationDir, conflictedFiles)
      if (unmerged || stillMarked) {
        git(['merge', '--abort'], integrationDir, true)
        if (git(['rev-parse', 'HEAD'], integrationDir).stdout.trim() !== preMergeSha) {
          git(['reset', '--hard', preMergeSha], integrationDir, true)
        }
        const reason = stillMarked && !unmerged ? 'merge conflict markers were committed without being resolved' : 'merge conflict could not be resolved'
        return { passed: false, operational: true, defects: [reason], evidence: resolved.artifact }
      }
      const mergeHead = git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], integrationDir, true)
      if (mergeHead.status === 0) git(['commit', '--no-edit'], integrationDir)
    } else if (merged.status === 'error') {
      return { passed: false, operational: true, defects: [merged.message || 'merge failed'] }
    }
    if (git(['merge-base', '--is-ancestor', checkpointSha, 'HEAD'], integrationDir, true).status !== 0) {
      git(['merge', '--abort'], integrationDir, true)
      return { passed: false, operational: true, defects: ['Checkpoint was not integrated into main'] }
    }

    await writeState({ phase: 'integration-qa', nextAction: 'integration-qa' })
    const verified = await runAgent('INTEGRATION_QA', featurePrompt('INTEGRATION_QA', feature, attempt, null, integrationDir), feature.id, attempt, integrationDir)
    await stopApp(integrationDir)
    if (verified.ok && verified.parsed?.implementation === true && verified.parsed?.integration === true) {
      await updateFeature(integrationDir, feature.id, { implementation: true, qa: true, integration: true })
    }
    const current = (await readFeatures(integrationDir)).list.find((item) => String(item.id) === String(feature.id))
    if (verified.ok && current?.implementation === true && current?.qa === true && current?.integration === true) {
      const file = await journal(integrationDir, 'Integrated Verification passed', {
        Attempt: `${attempt}/${maxAttempts}`, WorkItem: feature.id, AcceptanceChecks: feature.acceptance_checks || [],
        Outcome: 'passed on integrated main', Evidence: verified.artifact, NextAction: 'next Ready Work Item',
      })
      commitPaths(integrationDir, [join(integrationDir, 'feature_list.json'), file], `verify(harness): integrate ${feature.id}`)
      syncWorkdirWithMain(workdir)
      await writeState({ phase: 'integrated', nextAction: 'next-work-item', lastResult: 'Integrated Verification passed' })
      return { passed: true }
    }

    const defects = verified.parsed?.defects?.length ? verified.parsed.defects : [verified.detail.slice(-2000) || 'Integrated Verification failed']
    await updateFeature(integrationDir, feature.id, { implementation: false, qa: false, integration: false, retries: attempt })
    const file = await journal(integrationDir, 'Integrated Verification defect', {
      Attempt: `${attempt}/${maxAttempts}`, WorkItem: feature.id, Defects: defects, Evidence: verified.artifact, NextAction: 'Repair Plan',
    })
    commitPaths(integrationDir, [join(integrationDir, 'feature_list.json'), file], `qa(${feature.context}): ${feature.id} integration defect`)
    syncWorkdirWithMain(workdir)
    return { passed: false, defects, evidence: verified.artifact }
  } finally {
    mergeRelease(repo, process.pid)
  }
}
