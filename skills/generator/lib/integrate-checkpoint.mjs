/** Integrated Verification checkpoint: merge to the plan integration branch, resolve conflicts, run integration QA. */

import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join as pathJoin, relative as pathRelative } from 'node:path'
import { mergeDo, mergeRelease } from './claim-lease.mjs'

/** Map a git conflict path (repo-root-relative) to an absolute filesystem path. */
export function resolveGitRelPath(integrationDir, relPath, git) {
  const topResult = git(['rev-parse', '--show-toplevel'], integrationDir, true)
  const toplevel = (topResult.stdout || '').trim()
  if (!toplevel || topResult.status !== 0) {
    return pathJoin(integrationDir, relPath)
  }
  const integRel = pathRelative(toplevel, integrationDir).replace(/\\/g, '/')
  if (integRel && integRel !== '.' && !relPath.startsWith(`${integRel}/`) && relPath !== integRel) {
    return pathJoin(integrationDir, relPath)
  }
  return pathJoin(toplevel, relPath)
}

/** Cwd for git pathspec commands (e.g. add) when conflict paths are repo-root-relative. */
export function gitPathspecCwd(integrationDir, relPath, git) {
  const topResult = git(['rev-parse', '--show-toplevel'], integrationDir, true)
  const toplevel = (topResult.stdout || '').trim()
  if (!toplevel || topResult.status !== 0) {
    return integrationDir
  }
  const integRel = pathRelative(toplevel, integrationDir).replace(/\\/g, '/')
  if (integRel && integRel !== '.' && relPath.startsWith(`${integRel}/`)) {
    return toplevel
  }
  return integrationDir
}

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

/** Append-only union for harness-progress journals (ours + unique theirs lines). */
export function unionAppendOnly(ours, theirs) {
  const a = String(ours || '')
  const b = String(theirs || '')
  if (!a) return b
  if (!b) return a
  if (a.includes(b)) return a
  if (b.includes(a)) return b
  const sep = a.endsWith('\n') ? '' : '\n'
  return `${a}${sep}${b.startsWith('\n') ? b.slice(1) : b}`
}

export function autoResolveHarnessProgressConflicts(git, integrationDir, conflictedFiles) {
  const resolved = []
  const remaining = []
  for (const relPath of conflictedFiles || []) {
    if (!/(^|\/)harness-progress\//.test(relPath)) {
      remaining.push(relPath)
      continue
    }
    const ours = git(['show', `:2:${relPath}`], integrationDir, true)
    const theirs = git(['show', `:3:${relPath}`], integrationDir, true)
    if (ours.status !== 0 && theirs.status !== 0) {
      remaining.push(relPath)
      continue
    }
    const merged = unionAppendOnly(ours.stdout || '', theirs.stdout || '')
    const absPath = resolveGitRelPath(integrationDir, relPath, git)
    const parentDir = dirname(absPath)
    if (!existsSync(parentDir)) {
      remaining.push(relPath)
      continue
    }
    try {
      writeFileSync(absPath, merged.endsWith('\n') ? merged : `${merged}\n`)
      git(['add', '--', relPath], gitPathspecCwd(integrationDir, relPath, git))
      resolved.push(relPath)
    } catch {
      remaining.push(relPath)
    }
  }
  return { resolved, remaining }
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
    syncWorkdirWithIntegration,
    join,
    acquireMergeLock,
  } = ctx

  await stopApp(workdir)
  const integrationDir = await acquireMergeLock()
  const preMergeSha = git(['rev-parse', 'HEAD'], integrationDir).stdout.trim()
  try {
    // Plan branch already records this WI as integrated — sync flags to the
    // worktree and skip merge/QA thrash (worktree feature_list often lags).
    const onPlan = (await readFeatures(integrationDir)).list.find((item) => String(item.id) === String(feature.id))
    if (onPlan?.integration === true) {
      await updateFeature(workdir, feature.id, { implementation: true, qa: true, integration: true })
      commitPaths(workdir, [join(workdir, 'feature_list.json')], `chore(harness): sync integrated ${feature.id}`)
      syncWorkdirWithIntegration(workdir)
      await writeState({ phase: 'integrated', nextAction: 'next-work-item', lastResult: 'Already integrated on plan branch' })
      return { passed: true }
    }

    const journalFile = await journal(workdir, 'Checkpoint ready', {
      Attempt: `${attempt}/${maxAttempts}`, WorkItem: feature.id, Outcome: 'isolated QA passed', NextAction: 'Integrated Verification',
    })
    commitPaths(workdir, [journalFile], `chore(harness): checkpoint ${feature.id}`)
    const checkpointSha = git(['rev-parse', 'HEAD'], workdir).stdout.trim()

    await writeState({ phase: 'merge', nextAction: 'merge', integrationDir })
    const merged = mergeDo(repo, feature.context, integrationDir)
    if (merged.status === 'conflict') {
      const conflictedFiles = merged.paths || []
      const auto = autoResolveHarnessProgressConflicts(git, integrationDir, conflictedFiles)
      let unmerged = git(['diff', '--name-only', '--diff-filter=U'], integrationDir).stdout.trim()
      let stillMarked = stillMarkedConflictFiles(git, integrationDir, auto.remaining.length ? auto.remaining : conflictedFiles)
      let resolved = { artifact: null }
      if (unmerged || stillMarked) {
        resolved = await runAgent('MERGE', featurePrompt('MERGE', feature, attempt, null, integrationDir), feature.id, attempt, integrationDir)
        unmerged = git(['diff', '--name-only', '--diff-filter=U'], integrationDir).stdout.trim()
        stillMarked = stillMarkedConflictFiles(git, integrationDir, conflictedFiles)
      }
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
      return { passed: false, operational: true, defects: ['Checkpoint was not integrated into the integration branch'] }
    }

    await writeState({ phase: 'integration-qa', nextAction: 'integration-qa' })
    const verified = await runAgent('INTEGRATION_QA', featurePrompt('INTEGRATION_QA', feature, attempt, null, integrationDir), feature.id, attempt, integrationDir)
    if (verified?.observationGateFailure) {
      return { passed: false, operational: true, observationGateFailure: true, defects: [verified.detail] }
    }
    await stopApp(integrationDir)
    if (verified.ok && verified.parsed?.implementation === true && verified.parsed?.integration === true) {
      await updateFeature(integrationDir, feature.id, { implementation: true, qa: true, integration: true })
      await updateFeature(workdir, feature.id, { implementation: true, qa: true, integration: true })
    }
    const current = (await readFeatures(integrationDir)).list.find((item) => String(item.id) === String(feature.id))
    if (verified.ok && current?.implementation === true && current?.qa === true && current?.integration === true) {
      const file = await journal(integrationDir, 'Integrated Verification passed', {
        Attempt: `${attempt}/${maxAttempts}`, WorkItem: feature.id, AcceptanceChecks: feature.acceptance_checks || [],
        Outcome: 'passed on integrated branch', Evidence: verified.artifact, NextAction: 'next Ready Work Item',
      })
      commitPaths(integrationDir, [file], `verify(harness): integrate ${feature.id}`)
      commitPaths(workdir, [join(workdir, 'feature_list.json')], `chore(harness): record integrated ${feature.id}`)
      syncWorkdirWithIntegration(workdir)
      await writeState({ phase: 'integrated', nextAction: 'next-work-item', lastResult: 'Integrated Verification passed' })
      return { passed: true }
    }

    const defects = verified.parsed?.defects?.length ? verified.parsed.defects : [verified.detail.slice(-2000) || 'Integrated Verification failed']
    await updateFeature(integrationDir, feature.id, { implementation: false, qa: false, integration: false, retries: attempt })
    await updateFeature(workdir, feature.id, { implementation: false, qa: false, integration: false, retries: attempt })
    const file = await journal(integrationDir, 'Integrated Verification defect', {
      Attempt: `${attempt}/${maxAttempts}`, WorkItem: feature.id, Defects: defects, Evidence: verified.artifact, NextAction: 'Repair Plan',
    })
    commitPaths(integrationDir, [file], `qa(${feature.context}): ${feature.id} integration defect`)
    syncWorkdirWithIntegration(workdir)
    return { passed: false, defects, evidence: verified.artifact }
  } finally {
    mergeRelease(repo, process.pid)
  }
}
