export const meta = {
  name: 'generator-orchestrator',
  description: 'Inner coding→QA loop for one claimed context: implement each feature, QA it, retry with model escalation.',
  phases: [
    { title: 'Build', detail: 'coding-agent implements each feature in the worktree' },
    { title: 'QA', detail: 'qa-agent verifies each feature through the UI' },
  ],
}

// args = { workdir, port, mode, features: [{id, context, description}] }
const { workdir, port, mode = 'full', features = [] } = args || {}
if (!workdir || !features.length) {
  return { error: 'orchestrator needs args.workdir and a non-empty args.features', features }
}

const CODING_SCHEMA = {
  type: 'object',
  required: ['id', 'implementation'],
  properties: {
    id: { type: 'string' },
    implementation: { type: 'boolean' },
    notes: { type: 'string' },
  },
}
const QA_SCHEMA = {
  type: 'object',
  required: ['id', 'qa', 'implementation'],
  properties: {
    id: { type: 'string' },
    qa: { type: 'boolean' },
    implementation: { type: 'boolean' },
    defects: { type: 'array', items: { type: 'string' } },
  },
}

const env = `WORKDIR=${workdir}\nPORT=${port}\nFRONTEND_PORT=${port}\nBACKEND_PORT=${port + 1000}`
const codePrompt = (f) =>
  `You are the coding-agent. Implement EXACTLY this one feature, then stop.\n${env}\n` +
  `Feature id=${f.id} context=${f.context}: ${f.description}\n` +
  `cd into WORKDIR, bring up the app on PORT (Monitor the log), implement + verify the feature ` +
  `end-to-end through the UI, write specification-style (black-box, refactor-proof) tests, flip ` +
  `ONLY this feature's "implementation" false→true after screenshot-verified success, commit.`
const qaPrompt = (f) =>
  `You are the qa-agent. Independently QA EXACTLY this one feature as a black-box specification.\n${env}\n` +
  `Feature id=${f.id} context=${f.context}: ${f.description}\n` +
  `cd into WORKDIR, bring up the app on PORT (Monitor the log), verify the feature through the real ` +
  `UI (no internals, no curl-only). On pass set "qa" true; on any defect set "implementation" false ` +
  `and list the defects. Commit your flag change.`

const total = features.length
let built = 0, passed = 0
const results = []

for (let i = 0; i < features.length; i++) {
  const f = features[i]
  let retries = 0, done = false

  while (!done) {
    if (mode !== 'qa') {
      const model = retries >= 2 ? 'opus' : 'sonnet'
      const r = await agent(codePrompt(f), {
        label: `code:${f.context}#${f.id}${retries ? `(retry${retries},${model})` : ''}`,
        phase: 'Build', agentType: 'coding-agent', model, schema: CODING_SCHEMA,
      })
      if (!r || r.implementation !== true) {
        retries++
        log(`feature ${f.id} not implemented (retry ${retries})`)
        if (retries >= 3) {
          results.push({ id: f.id, status: 'stuck-implementation', notes: r?.notes })
          done = true // escalate: leave for the skill to surface to the user
          continue
        }
        continue
      }
      built++
    }

    const q = await agent(qaPrompt(f), {
      label: `qa:${f.context}#${f.id}`,
      phase: 'QA', agentType: 'qa-agent', schema: QA_SCHEMA,
    })
    if (q && q.qa === true) {
      passed++
      results.push({ id: f.id, status: 'passed' })
      done = true
    } else {
      // QA found a defect → feature kicked back to coding (implementation now false)
      retries++
      log(`feature ${f.id} failed QA: ${(q?.defects || []).join('; ') || 'unknown'} (retry ${retries})`)
      if (mode === 'qa' || retries >= 3) {
        results.push({ id: f.id, status: 'stuck-qa', defects: q?.defects })
        done = true
      }
    }
  }
  log(`progress: built ${built}/${total}, passed ${passed}/${total}`)
}

const stuck = results.filter((r) => r.status.startsWith('stuck'))
return { context: features[0]?.context, total, built, passed, stuck, results }
