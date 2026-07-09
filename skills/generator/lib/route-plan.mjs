import { readStrikes as readStrikesFromLease, strike } from './claim-lease.mjs'

export function mkey(harness, model) {
  return `${harness}|${model || ''}`
}

export function strikeOf(role, harness, model, strikes) {
  return (strikes[`infra|${mkey(harness, model)}`] || 0) + (strikes[`quality|${role}|${mkey(harness, model)}`] || 0)
}

export function readStrikes(repo) {
  try {
    return readStrikesFromLease(repo) || {}
  } catch {
    return {}
  }
}

export function bumpStrike(repo, key, delta) {
  try {
    strike(repo, key, delta)
  } catch {
    /* best-effort */
  }
}

export function buildPlan(repo, roles) {
  if (!roles) return null
  const strikes = readStrikes(repo)
  const sortedRoles = {}
  for (const role of ['coding', 'validation', 'repairPlanning', 'goalReview']) {
    sortedRoles[role] = [...roles[role]].sort((a, b) =>
      strikeOf(role, a.harness, a.model, strikes) - strikeOf(role, b.harness, b.model, strikes))
  }
  return { roles, sortedRoles, strikes }
}

export function lastCoder(state) {
  const route = [...(state.routeHistory || [])].reverse().find((r) => r.kind === 'CODING' && r.outcome === 'selected')
  return route ? mkey(route.harness, route.model) : null
}

export function buildCandidates({
  plan,
  kind,
  attempt,
  options,
  roleNames,
  codedBy,
  state,
}) {
  const roles = plan?.roles
  const direct = !roles
  const role = roleNames[kind]
  const strikes = plan?.strikes || {}

  if (direct) {
    return [{ harness: options.host }]
  }

  const roleList = [...plan.sortedRoles[role]]
  if (['QA', 'INTEGRATION_QA', 'GOAL_REVIEW'].includes(kind)) {
    const avoid = codedBy || roles.coding[0].harness
    roleList.sort((a, b) => (Number(a.harness === avoid) - Number(b.harness === avoid))
      || (strikeOf(role, a.harness, a.model, strikes) - strikeOf(role, b.harness, b.model, strikes)))
  }
  const repairBudget = Number(process.env.HARNESS_REPAIR_BUDGET || 2)
  const pool = [...roleList, ...(roles.noCredits || [])]
  const offset = kind === 'CODING'
    ? Math.min(Math.floor((attempt - 1) / repairBudget) + (plan.coderDeclines || 0), pool.length - 1)
    : 0
  return pool.slice(offset)
}
