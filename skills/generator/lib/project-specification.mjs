/** Canonical Project Specification parse + validate. Single owner for XML semantics. */
export function attribute(text, name) {
  const match = text.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`))
  return match?.[2]?.trim() || ''
}

export function body(text, tag) {
  return text.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`))?.[1]
    ?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || ''
}

export function sectionInner(xml, tag) {
  return xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] || ''
}

/**
 * @returns {{
 *   projectName: string,
 *   mode: string,
 *   projectGoal: string,
 *   checks: Array<{id:string,context:string,category:string,observation:string,description:string,dependsOn:string[]}>,
 *   technologySections: Record<string,string>,
 * }}
 */
export function parseProjectSpecification(xml) {
  if (!xml || typeof xml !== 'string') throw new Error('project_specs.xml is empty')
  const projectName = body(xml, 'project_name')
  const mode = body(xml, 'mode') || 'new-project'
  const projectGoal = body(xml, 'project_goal')
  if (!projectGoal) throw new Error('project_specs.xml requires <project_goal>')

  const checks = [...xml.matchAll(/<acceptance_check\b([^>]*)>([\s\S]*?)<\/acceptance_check>/g)]
    .map((match) => {
      const id = attribute(match[1], 'id')
      const context = attribute(match[1], 'context')
      const dependsOn = attribute(match[1], 'depends_on').split(',').map((v) => v.trim()).filter(Boolean)
      return {
        id,
        context,
        category: attribute(match[1], 'category') || 'functional',
        observation: attribute(match[1], 'observation') || '',
        description: body(match[2], 'description'),
        dependsOn,
        dependencies: dependsOn,
      }
    })

  if (!checks.length) throw new Error('project_specs.xml has no <acceptance_check> entries; run the planner first')

  const ids = new Set()
  for (const check of checks) {
    if (!check.id || !check.context || !check.description) {
      throw new Error('every acceptance_check needs id, context, and description')
    }
    if (ids.has(check.id)) throw new Error(`duplicate acceptance check id: ${check.id}`)
    ids.add(check.id)
  }
  for (const check of checks) {
    for (const dependency of check.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`${check.id} depends on unknown acceptance check ${dependency}`)
    }
  }
  validateAcyclic(checks)

  const planningDecisions = parsePlanningDecisions(xml, checks)
  const technologySections = {}
  for (const tag of ['technology_stack', 'integrations', 'prerequisites']) {
    technologySections[tag] = sectionInner(xml, tag)
  }

  return { projectName, mode, projectGoal, checks, planningDecisions, technologySections }
}

const DECISION_TOPICS = new Set(['ambiguous-requirement', 'architectural-tradeoff', 'edge-case'])

/**
 * Parse <planning_decisions> when present.
 * Legacy specs without the section are accepted.
 * When present (and not body `removed`), every decision must link only to known
 * Acceptance Checks, and each topic must appear as a decision or under <deferred>.
 */
export function parsePlanningDecisions(xml, checks) {
  const inner = sectionInner(xml, 'planning_decisions')
  if (!inner.trim()) return { present: false, decisions: [], deferred: '' }
  const stripped = inner.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim()
  if (/^removed$/i.test(stripped)) {
    return { present: true, removed: true, decisions: [], deferred: body(inner, 'deferred') || 'removed' }
  }

  const checkIds = new Set(checks.map((c) => c.id))
  const decisions = [...inner.matchAll(/<decision\b([^>]*)>([\s\S]*?)<\/decision>/g)].map((match) => {
    const id = attribute(match[1], 'id')
    const topic = attribute(match[1], 'topic')
    const acceptanceChecks = body(match[2], 'acceptance_checks')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
    return {
      id,
      topic,
      question: body(match[2], 'question'),
      options: body(match[2], 'options'),
      choice: body(match[2], 'choice'),
      rationale: body(match[2], 'rationale'),
      acceptanceChecks,
    }
  })
  const deferred = body(inner, 'deferred')

  if (!decisions.length && !deferred) {
    throw new Error('planning_decisions must contain <decision> entries or a non-empty <deferred> reason')
  }

  const seen = new Set()
  const topics = new Set()
  for (const decision of decisions) {
    if (!decision.id || !decision.topic || !decision.question || !decision.choice) {
      throw new Error('every planning decision needs id, topic, question, and choice')
    }
    if (!DECISION_TOPICS.has(decision.topic)) {
      throw new Error(`planning decision ${decision.id} has unknown topic ${decision.topic}`)
    }
    if (seen.has(decision.id)) throw new Error(`duplicate planning decision id: ${decision.id}`)
    seen.add(decision.id)
    topics.add(decision.topic)
    for (const ac of decision.acceptanceChecks) {
      if (!checkIds.has(ac)) {
        throw new Error(`planning decision ${decision.id} links unknown acceptance check ${ac}`)
      }
    }
    if (decision.topic === 'edge-case' && decision.choice && !/defer/i.test(decision.choice) && !decision.acceptanceChecks.length) {
      throw new Error(`edge-case decision ${decision.id} must link Acceptance Checks or explicitly defer in <choice>`)
    }
  }

  for (const topic of DECISION_TOPICS) {
    if (topics.has(topic)) continue
    const named = Boolean(deferred) && (
      deferred.toLowerCase().includes(topic)
      || deferred.toLowerCase().includes(topic.replace(/-/g, ' '))
    )
    if (!named) {
      throw new Error(`planning_decisions must cover topic ${topic} (add a <decision> or name it under <deferred>)`)
    }
  }

  return { present: true, removed: false, decisions, deferred }
}

export function validateAcyclic(checks) {
  const visiting = new Set()
  const visited = new Set()
  const byId = new Map(checks.map((check) => [check.id, check]))
  function visit(id) {
    if (visiting.has(id)) throw new Error(`acceptance check dependency cycle includes ${id}`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of byId.get(id).dependsOn || byId.get(id).dependencies || []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const check of checks) visit(check.id)
}

/** Validate Work Item catalog deps against checks + queue-local depends_on cycles. */
export function validateCatalogDependencies(checks, catalog) {
  const validIds = new Set(checks.map((c) => c.id))
  const workIds = new Set()
  for (const item of catalog) {
    if (!item.id || workIds.has(String(item.id))) throw new Error(`missing or duplicate Work Item id: ${item.id || ''}`)
    workIds.add(String(item.id))
    if (!Array.isArray(item.acceptance_checks) || !item.acceptance_checks.length) {
      throw new Error(`work item ${item.id} has no Acceptance Check mapping`)
    }
    for (const id of item.acceptance_checks) {
      if (!validIds.has(id)) throw new Error(`work item ${item.id} maps unknown acceptance check ${id}`)
    }
  }
  for (const item of catalog) {
    for (const dep of item.depends_on || []) {
      if (!validIds.has(dep) && !workIds.has(String(dep))) {
        throw new Error(`work item ${item.id} depends_on unknown id ${dep}`)
      }
    }
  }
  const byWork = new Map(catalog.map((item) => [String(item.id), item]))
  const visiting = new Set()
  const visited = new Set()
  function visit(id) {
    if (visiting.has(id)) throw new Error(`work item dependency cycle includes ${id}`)
    if (visited.has(id)) return
    const item = byWork.get(id)
    if (!item) return
    visiting.add(id)
    for (const dep of item.depends_on || []) {
      if (byWork.has(String(dep))) visit(String(dep))
    }
    visiting.delete(id)
    visited.add(id)
  }
  for (const item of catalog) visit(String(item.id))
}
