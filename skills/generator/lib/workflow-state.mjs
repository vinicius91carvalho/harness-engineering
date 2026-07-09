import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

export function createWorkflowState({
  stateFile,
  leaseToken,
  context,
  readJson,
  atomicJson,
  hostname,
  process,
  fail,
  dirname,
  join,
  mkdir,
  appendFile,
  writeFile,
  readFile,
  git,
  workdir,
  terminateChild,
}) {
  let state = {}

  function getState() {
    return state
  }

  function setState(next) {
    state = next
  }

  async function writeState(change = {}) {
    const current = await readJson(stateFile, {})
    if (current.leaseToken && current.leaseToken !== leaseToken && current.ownerHost === hostname() && current.ownerPid && current.ownerPid !== process.pid) {
      try { process.kill(current.ownerPid, 0); fail(`Claim Lease for ${context} is owned by live pid ${current.ownerPid}`) } catch {}
    }
    const nextStatus = change.status || state.status
    state = {
      ...state,
      ...change,
      context,
      leaseToken,
      ownerHost: hostname(),
      ownerPid: nextStatus === 'blocked' || nextStatus === 'complete' ? null : process.pid,
      heartbeat: new Date().toISOString(),
      heartbeatEpoch: Math.floor(Date.now() / 1000),
    }
    await atomicJson(stateFile, state)
  }

  function writeInterruptedState(signal) {
    try {
      terminateChild()
      const value = {
        ...state, context, leaseToken, ownerHost: hostname(), ownerPid: null, childPid: null,
        status: 'interrupted', lastResult: `orchestrator received ${signal}`,
        heartbeat: new Date().toISOString(), heartbeatEpoch: Math.floor(Date.now() / 1000),
      }
      const temporary = `${stateFile}.tmp.${process.pid}.${randomUUID()}`
      mkdirSync(dirname(stateFile), { recursive: true })
      writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
      renameSync(temporary, stateFile)
    } finally { process.exit(130) }
  }

  async function readFeatures(targetWorkdir = workdir) {
    const file = join(targetWorkdir, 'feature_list.json')
    let parsed
    try { parsed = JSON.parse(await readFile(file, 'utf8')) } catch (error) { fail(`cannot read ${file}: ${error.message}`) }
    if (!Array.isArray(parsed)) fail('feature_list.json must be an array')
    return { file, parsed, list: parsed }
  }

  async function updateFeature(workdir, id, changes) {
    const { file, parsed, list } = await readFeatures(workdir)
    const feature = list.find((item) => String(item.id) === String(id))
    if (!feature) fail(`unknown Work Item ${id}`)
    Object.assign(feature, changes)
    await atomicJson(file, parsed)
    return feature
  }

  function journalPath(targetWorkdir = workdir, name = context) {
    return join(targetWorkdir, 'harness-progress', `${name}.md`)
  }

  async function journal(workdir, title, fields, name = context) {
    const file = journalPath(workdir, name)
    await mkdir(dirname(file), { recursive: true })
    let exists = true
    try { await readFile(file) } catch { exists = false }
    if (!exists) await writeFile(file, `# ${name} workflow journal\n`)
    const lines = Object.entries(fields).filter(([, value]) => value !== undefined && value !== '')
      .map(([key, value]) => `- ${key}: ${Array.isArray(value) ? value.join('; ') : value}`)
    await appendFile(file, `\n## ${new Date().toISOString()} — ${title}\n\n${lines.join('\n')}\n`)
    return file
  }

  function commitPaths(workdir, paths, message) {
    const relative = paths.map((path) => path.replace(`${workdir}/`, ''))
    git(['add', '--', ...relative], workdir)
    const staged = git(['diff', '--cached', '--quiet'], workdir, true)
    if (staged.status !== 0) git(['commit', '-m', message], workdir)
  }

  return {
    writeState,
    writeInterruptedState,
    readFeatures,
    updateFeature,
    journal,
    commitPaths,
    journalPath,
    getState,
    setState,
  }
}
