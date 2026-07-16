import { existsSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseProjectSpecification } from '../../generator/lib/project-specification.mjs'
import { registerProjectAt } from '../../generator/lib/project-topology.mjs'
import { pinIntegrationBranchIfAbsent } from '../../generator/lib/integration-branch.mjs'
import {
  loadDraft,
  loadFeedback,
  validateFeedbackShape,
  reviewStatus,
  paths,
} from './spec-draft.mjs'

/**
 * Write project_specs.xml from a confirmed draft, clear review artifacts,
 * after registry registration and integration-branch pin succeed.
 *
 * @returns {string} absolute path to project_specs.xml
 */
export function finalizeSpec(projectDir) {
  const report = reviewStatus(projectDir)
  if (!report.ready) {
    const err = new Error('cannot finalize: specification review is not complete')
    err.code = 'NOT_READY'
    err.report = report
    throw err
  }
  const draft = loadDraft(projectDir)
  const feedback = loadFeedback(projectDir)
  const shapeError = validateFeedbackShape(feedback, draft)
  if (shapeError) {
    const err = new Error(shapeError)
    err.code = 'BAD_FEEDBACK'
    throw err
  }
  try {
    parseProjectSpecification(draft.xml_draft)
  } catch (error) {
    const err = new Error(`cannot finalize: invalid project specification: ${error.message}`)
    err.code = 'BAD_SPEC'
    throw err
  }
  const root = resolve(projectDir)

  try {
    const registered = registerProjectAt(root)
    if (registered) {
      console.log(`spec-review: registered project ${registered.id} (${registered.path || '.'}) in ${registered.file}`)
    }
    const pin = pinIntegrationBranchIfAbsent(root, draft.project_name)
    if (pin?.pinned) {
      console.log(`spec-review: pinned integration branch ${pin.branch} in ${pin.file}`)
    }
  } catch (error) {
    const err = new Error(`cannot finalize: project registry or integration pin failed: ${error.message}`)
    err.code = 'REGISTRY_FAILED'
    throw err
  }

  const target = join(root, 'project_specs.xml')
  writeFileSync(target, draft.xml_draft.endsWith('\n') ? draft.xml_draft : `${draft.xml_draft}\n`, 'utf8')
  const p = paths(projectDir)
  for (const file of [p.draft, p.feedback, p.html, p.state, p.done]) {
    if (existsSync(file)) unlinkSync(file)
  }
  return target
}
