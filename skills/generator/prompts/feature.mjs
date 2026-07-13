import { VERDICT_HINT } from '../lib/worker-outcome.mjs'

export { VERDICT_HINT }

export function sharedRootWarning(integrationBranch = 'main') {
  return `You are operating directly on this repository's shared integration branch (${integrationBranch}) for the active Project Goal — used by every Work Item and subproject in this monorepo. Never commit, merge, push, or cherry-pick to main/master while this plan is in flight; isolated Work Items land on gen/* branches and merge only into ${integrationBranch}. Never run \`git reset\` (soft, mixed, or hard), \`git checkout -- .\`, \`git clean -f\`, or any other command that discards or rewrites committed history. If you are ever unsure whether an action is safe, stop and report the problem instead of guessing. Run every git command one at a time and wait for it to finish before running the next — never issue two git commands in parallel or overlapping tool calls, even independent-looking ones like \`git status\` alongside \`git add\`. Two git processes writing to this same working tree at once collide on \`.git/index.lock\` (\`fatal: Unable to create .../index.lock: File exists\`) and the Work Item gets reported as failed even though nothing was actually wrong with your resolution.`
}

export const SHARED_ROOT_WARNING = sharedRootWarning('main')

/** Mandatory end-of-task teardown injected into coding/QA/integration prompts. */
export const RESOURCE_CLEANUP_RULE =
  'RESOURCE CLEANUP: emit the harness verdict FIRST, then tear down resources you started. ' +
  'Never run `pkill -f` / `killall` with WORKDIR, PORT, or other substrings that appear in ' +
  'this agent\'s own command line (that suicides the worker and drops the verdict). ' +
  'Stop the worktree server only via the exact PID in `.harness/app.pid` ' +
  '(`kill "$(cat .harness/app.pid)"` — nothing broader). ' +
  'SHARED COMPOSE INFRA: if postgres/redis/hindsight (or other documented infra) are already ' +
  'healthy on their published ports, REUSE them — do not bring up a second full stack and do ' +
  'not `docker compose down` shared infra while sibling harness workers may need it. Prefer ' +
  '`docker compose up -d --no-deps <app-services>` / rebuild only services under test ' +
  '(api/worker/website/dashboard/test-app). Tear down only app services you started ' +
  '(`docker compose rm -sf <app-services>` or stop those exact containers). Full ' +
  '`docker compose down --remove-orphans` is allowed only when you are the last user of that ' +
  'stack (no healthy shared infra still required by another live worker). ' +
  'If you create private runtime resources, record exact PIDs/container names in `.harness/runtime-owned.jsonl` when practical. ' +
  'For named WI/AC containers you created: `docker rm -f` on those exact names ' +
  '(wi-ac-*, ac0*). Do not tear down compose stacks or containers you did not start. ' +
  'Cleanup failures belong in notes/defects; never skip the verdict to clean up.'
/**
 * Cursor Agent / host AGENTS.md often tells the "main" agent to spawn Task
 * subagents. Harness workers ARE the assigned worker — nested Task/subagent
 * re-delegation burns provider quota and never returns a harness verdict.
 */
export const NO_REDELEGATE_RULE =
  'You ARE the assigned harness worker for this Work Item. Execute it yourself ' +
  'with your own tools. Do NOT spawn Task/subagents, do NOT re-delegate to another ' +
  'coding-agent/qa-agent, and ignore any AGENTS.md / CLAUDE.md rule that says the ' +
  'main agent must only orchestrate — that rule does not apply inside this worker session.'

function resolveObservationMethods(feature, options = {}) {
  if (Array.isArray(options.observationMethods) && options.observationMethods.length) {
    return options.observationMethods
  }
  if (Array.isArray(feature.observation_methods) && feature.observation_methods.length) {
    return feature.observation_methods
  }
  if (feature.observation_method) return [feature.observation_method]
  return []
}

/** Soft-align coding verification steps to the Work Item observation methods (ADR-0018). */
export function codingObservationAlign(methods = []) {
  if (!methods.length) {
    return 'Bring up the app on the assigned ports and run black-box behavior tests at a real external boundary.'
  }
  const parts = []
  if (methods.includes('grep')) {
    parts.push('For grep/static audit checks, exercise via file and grep audit — do not start a server or browser for those checks.')
  }
  if (methods.includes('cli')) {
    parts.push('For CLI checks, verify via command invocation and exit codes.')
  }
  if (methods.includes('http')) {
    parts.push('For HTTP checks, bring up the app on the assigned ports and exercise real HTTP endpoints.')
  }
  if (methods.includes('browser')) {
    parts.push('For browser checks, bring up the app and exercise behavior through a real browser.')
  }
  return parts.join(' ')
}

function verifyFirstBoundaryHint(methods = []) {
  if (methods.length && !methods.some((m) => m === 'http' || m === 'browser')) {
    return 'First exercise every mapped Acceptance Check against the EXISTING code using the observation methods they require (grep/file audit, CLI exit code — no server or browser unless http/browser is required).'
  }
  return 'First exercise every mapped Acceptance Check against the EXISTING code at a real external boundary (HTTP or browser as required).'
}

export function featurePrompt(kind, feature, attempt, repairPlan = null, workdir, options = {}) {
  const port = options.port ?? '5170'
  const getVerifyFirst = options.getVerifyFirst ?? (() => false)
  const base = `WORKDIR=${workdir}\nPORT=${port}\nWork Item id=${feature.id} context=${feature.context}\n` +
    `Acceptance Checks=${(feature.acceptance_checks || []).join(',')}\nDescription=${feature.description || ''}\n`
  if (kind === 'CODING') {
    const methods = resolveObservationMethods(feature, options)
    const verifyAlign = codingObservationAlign(methods)
    const verifyFirst = feature.verify_first === undefined ? getVerifyFirst(workdir) : feature.verify_first === true
    const head = verifyFirst
      ? `You are the coding-agent in VERIFY-FIRST mode (existing codebase). ${verifyFirstBoundaryHint(methods)} If all pass, set implementation=true and make NO code changes (a zero-diff checkpoint is valid; commit only if you intentionally changed tracked files). If any check fails, fix only the root cause with the smallest possible diff — do not refactor, restructure, or rewrite working code. The bar is "the AC passes at a real boundary," not "the code is idiomatic."\n${base}`
      : `You are the coding-agent. Implement exactly this Work Item, then stop.\n${base}`
    return head +
      `${NO_REDELEGATE_RULE} ` +
      `${repairPlan ? `Follow this Repair Plan from the orchestrator:\n${JSON.stringify(repairPlan)}\n` : ''}` +
      `Read the exact queue entry and Workflow Journal. ${verifyAlign} Do NOT edit feature_list.json, Execution Ledger flags, or Workflow Journal files — return product commits and a verdict only; the orchestrator owns workflow transitions. ${RESOURCE_CLEANUP_RULE} Return one JSON object: {"id":"...","implementation":true|false,"notes":"..."}. ${VERDICT_HINT}`
  }
  if (kind === 'QA') return `You are the qa-agent. Independently test exactly this Work Item in its isolated worktree.\n${base}` +
    `${NO_REDELEGATE_RULE} ` +
    `Exercise the mapped Acceptance Checks using the observation method they specify (grep/file audit, CLI exit code, real HTTP, or real browser). Do not start a server or browser for a check that is already a static audit. Once the checks pass or fail, emit the harness verdict immediately — do not keep re-analyzing. Do NOT edit feature_list.json or Workflow Journal files; the orchestrator records qa/implementation flags from your verdict. ${RESOURCE_CLEANUP_RULE} Return only JSON: {"id":"...","qa":true|false,"implementation":true|false,"defects":["expected ...; observed ...; evidence ..."]}. ${VERDICT_HINT}`
  if (kind === 'INTEGRATION_QA') {
    const branch = options.integrationBranch || 'main'
    return `You are the qa-agent performing Integrated Verification on latest ${branch}.\n${base}` +
    `${NO_REDELEGATE_RULE} ` +
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
