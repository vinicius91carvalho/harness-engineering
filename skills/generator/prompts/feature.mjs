import { VERDICT_HINT } from '../lib/verdict.mjs'

export { VERDICT_HINT }

export function sharedRootWarning(integrationBranch = 'main') {
  return `You are operating directly on this repository's shared integration branch (${integrationBranch}) for the active Project Goal — used by every Work Item and subproject in this monorepo. Never commit, merge, push, or cherry-pick to main/master while this plan is in flight; isolated Work Items land on gen/* branches and merge only into ${integrationBranch}. Never run \`git reset\` (soft, mixed, or hard), \`git checkout -- .\`, \`git clean -f\`, or any other command that discards or rewrites committed history. If you are ever unsure whether an action is safe, stop and report the problem instead of guessing. Run every git command one at a time and wait for it to finish before running the next — never issue two git commands in parallel or overlapping tool calls, even independent-looking ones like \`git status\` alongside \`git add\`. Two git processes writing to this same working tree at once collide on \`.git/index.lock\` (\`fatal: Unable to create .../index.lock: File exists\`) and the Work Item gets reported as failed even though nothing was actually wrong with your resolution.`
}

export const SHARED_ROOT_WARNING = sharedRootWarning('main')

/** Mandatory end-of-task teardown injected into coding/QA/integration prompts. */
export const RESOURCE_CLEANUP_RULE =
  'RESOURCE CLEANUP (mandatory before the verdict, pass or fail): tear down every ' +
  'resource this Work Item / this agent session started. That includes `docker compose down ' +
  '--remove-orphans` (or `docker compose -p <project> down --remove-orphans`) for compose ' +
  'stacks you brought up, `docker rm -f` for named WI/AC containers you created ' +
  '(for example wi-ac-*, ac0*), stopping this worktree\'s init.sh/dev server ' +
  '(.harness/app.pid), and killing browsers/Playwright processes scoped to this PORT/WORKDIR. ' +
  'Do not leave containers or servers running for a later task. ' +
  'Do not tear down compose stacks or containers you did not start ' +
  '(other subprojects or live sibling contexts). ' +
  'Cleanup failures belong in notes/defects; still emit the verdict.'

export function featurePrompt(kind, feature, attempt, repairPlan = null, workdir, options = {}) {
  const port = options.port ?? '5170'
  const getVerifyFirst = options.getVerifyFirst ?? (() => false)
  const base = `WORKDIR=${workdir}\nPORT=${port}\nWork Item id=${feature.id} context=${feature.context}\n` +
    `Acceptance Checks=${(feature.acceptance_checks || []).join(',')}\nDescription=${feature.description || ''}\n`
  if (kind === 'CODING') {
    const verifyFirst = feature.verify_first === undefined ? getVerifyFirst(workdir) : feature.verify_first === true
    const head = verifyFirst
      ? `You are the coding-agent in VERIFY-FIRST mode (existing codebase). First exercise every mapped Acceptance Check against the EXISTING code at a real external boundary (HTTP or browser). If all pass, set implementation=true and make NO code changes (a zero-diff checkpoint is valid; commit only if you intentionally changed tracked files). If any check fails, fix only the root cause with the smallest possible diff — do not refactor, restructure, or rewrite working code. The bar is "the AC passes at a real boundary," not "the code is idiomatic."\n${base}`
      : `You are the coding-agent. Implement exactly this Work Item, then stop.\n${base}`
    return head +
      `${repairPlan ? `Follow this Repair Plan from the orchestrator:\n${JSON.stringify(repairPlan)}\n` : ''}` +
      `Read the exact queue entry and Workflow Journal. Bring up the app on the assigned ports and run black-box behavior tests. Do NOT edit feature_list.json, Execution Ledger flags, or Workflow Journal files — return product commits and a verdict only; the orchestrator owns workflow transitions. ${RESOURCE_CLEANUP_RULE} Return one JSON object: {"id":"...","implementation":true|false,"notes":"..."}. ${VERDICT_HINT}`
  }
  if (kind === 'QA') return `You are the qa-agent. Independently test exactly this Work Item in its isolated worktree.\n${base}` +
    `Exercise the mapped Acceptance Checks using the observation method they specify (grep/file audit, CLI exit code, real HTTP, or real browser). Do not start a server or browser for a check that is already a static audit. Once the checks pass or fail, emit the harness verdict immediately — do not keep re-analyzing. Do NOT edit feature_list.json or Workflow Journal files; the orchestrator records qa/implementation flags from your verdict. ${RESOURCE_CLEANUP_RULE} Return only JSON: {"id":"...","qa":true|false,"implementation":true|false,"defects":["expected ...; observed ...; evidence ..."]}. ${VERDICT_HINT}`
  if (kind === 'INTEGRATION_QA') {
    const branch = options.integrationBranch || 'main'
    return `You are the qa-agent performing Integrated Verification on latest ${branch}.\n${base}` +
    `Run the mapped Acceptance Checks using the observation method they specify (grep/file audit, CLI, real HTTP, or real browser). Do not start a server or browser for a static audit check. Emit the harness verdict as soon as the checks pass or fail. Do NOT edit feature_list.json or Workflow Journal files; the orchestrator records integration flags from your verdict. ${RESOURCE_CLEANUP_RULE} Return only JSON: {"id":"...","integration":true|false,"implementation":true|false,"defects":["expected ...; observed ...; evidence ..."]}. ${VERDICT_HINT}\n${sharedRootWarning(branch)}`
  }
  if (kind === 'REPAIR_PLAN') return `Act as the orchestrator repair planner. Do not modify files. Diagnose the QA Defect Report against the Work Item and repository.\n${base}` +
    `Defect Report=${JSON.stringify(repairPlan)}\nReturn only concise JSON: {"summary":"...","rootCause":"...","actions":["..."],"validation":["..."]}. ${VERDICT_HINT}`
  if (kind === 'MERGE') {
    const branch = options.integrationBranch || 'main'
    return `You are resolving integration conflicts for one verified Checkpoint.\n${base}` +
    `Resolve only the current Git conflicts. Keep Work Items append-only; a newer Defect Report overrides older true flags. Run affected black-box checks, commit, and return only JSON: {"resolved":true|false,"notes":"..."}. ${VERDICT_HINT}\n` +
    `${sharedRootWarning(branch)} The only git operations you need are \`git add\`/\`git commit\` to resolve conflicts, and \`git merge --abort\` if you cannot resolve them cleanly -- the orchestrator already handles an abort as a normal, safe outcome (it reports the conflict as unresolved and retries later).\n` +
    `Before running \`git add\` on any file that had a conflict, actually edit it -- open it and remove every \`<<<<<<<\`, \`=======\`, \`>>>>>>>\` marker line, keeping the correct combined content underneath. \`git add\` only clears Git's own unresolved-merge flag on a path; it does not check whether the marker lines are still sitting in the file. Staging and committing a file that still contains literal marker lines corrupts it (the orchestrator now also checks for this and will abort and retry if it happens, but do not rely on that -- verify the file has zero marker lines yourself before adding it).`
  }
}
