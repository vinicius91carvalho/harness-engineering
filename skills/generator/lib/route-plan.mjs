import { readStrikes as readStrikesFromLease, strike } from './claim-lease.mjs'
import { filterCandidatesForObservation } from './observation-method.mjs'

export function mkey(harness, model) {
  return `${harness}|${model || ''}`
}

/** Strike Count: infra strikes are global; quality strikes are per-role. */
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

/** Demotion: bump strike so the candidate sorts to the back of its role list. */
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

/**
 * Build the ordered candidate pool for one routing decision.
 * noCredits tier: free fallback appended only for CODING after paid role candidates.
 */
export function candidatePool({ plan, kind, attempt, roleNames, roleList = null }) {
  const roles = plan?.roles
  if (!roles) return null

  const role = roleNames[kind]
  const repairBudget = Number(process.env.HARNESS_REPAIR_BUDGET || 2)
  const paid = roleList || [...plan.sortedRoles[role]]
  const free = kind === 'CODING' && Array.isArray(roles.noCredits) ? [...roles.noCredits] : []
  const pool = [...paid, ...free]
  const offset = kind === 'CODING'
    ? Math.min(Math.floor((attempt - 1) / repairBudget) + (plan.coderDeclines || 0), Math.max(pool.length - 1, 0))
    : 0
  return pool.slice(offset)
}

export function buildCandidates({
  plan,
  kind,
  attempt,
  options,
  roleNames,
  codedBy,
  state,
  observationMethods = [],
}) {
  const roles = plan?.roles
  const direct = !roles
  const role = roleNames[kind]
  const strikes = plan?.strikes || {}

  if (direct) {
    return filterCandidatesForObservation([{ harness: options.host }], observationMethods, kind)
  }

  let roleList = [...plan.sortedRoles[role]]
  if (['QA', 'INTEGRATION_QA', 'GOAL_REVIEW'].includes(kind)) {
    const avoid = codedBy || roles.coding[0].harness
    roleList.sort((a, b) => (Number(a.harness === avoid) - Number(b.harness === avoid))
      || (strikeOf(role, a.harness, a.model, strikes) - strikeOf(role, b.harness, b.model, strikes)))
  }

  const pool = candidatePool({ plan, kind, attempt, roleNames, roleList })
  return filterCandidatesForObservation(pool, observationMethods, kind)
}

/** True when a candidate comes from the noCredits free tier. */
export function isNoCreditsCandidate(candidate, roles) {
  if (!roles?.noCredits?.length || !candidate?.harness) return false
  const key = mkey(candidate.harness, candidate.model)
  return roles.noCredits.some((entry) => mkey(entry.harness, entry.model) === key)
}
