import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  applyLedgerToCatalog,
  ledgerPath,
  readLedger,
  updateLedgerItem,
} from './execution-ledger.mjs'

const PROGRESS_FIELDS = new Set(['implementation', 'qa', 'integration', 'blocked', 'retries'])

export function createWorkflowState({
  stateFile,
  leaseToken,
  context,
  commonGit,
  projectId,
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
  const ledgerFile = ledgerPath(commonGit, projectId)
  let state = {}

  function getState() {
    return state
  }

  function setState(next) {
    state = next
  }

  async function writeState(change = {}) {
    const current = await readJson(stateFile, {})
    if (current.leaseToken && current.leaseToken !== leaseToken) {
      let liveOwner = false
      if (current.ownerPid && current.ownerHost === hostname()) {
        try { process.kill(current.ownerPid, 0); liveOwner = true } catch {}
      }
      if (liveOwner) {
        fail(`Claim Lease for ${context} is fenced by token ${current.leaseToken}; refusing stale writer`)
      }
    }
    if (current.ownerHost === hostname() && current.ownerPid && current.ownerPid !== process.pid) {
      try { process.kill(current.ownerPid, 0); fail(`Claim Lease for ${context} is owned by live pid ${current.ownerPid}`) } catch {}
    }
    const nextStatus = change.status || state.status
    const prevGen = Number(current.fenceGeneration || state.fenceGeneration || 0)
    state = {
      ...state,
      ...change,
      context,
      leaseToken,
      fenceGeneration: change.fenceBump ? prevGen + 1 : (prevGen || 1),
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

  async function readCatalog(targetWorkdir = workdir) {
    const file = join(targetWorkdir, 'feature_list.json')
    let parsed
    try { parsed = JSON.parse(await readFile(file, 'utf8')) } catch (error) { fail(`cannot read ${file}: ${error.message}`) }
    if (!Array.isArray(parsed)) fail('feature_list.json must be an array')
    return { file, parsed }
  }

  async function readFeatures(targetWorkdir = workdir) {
    const { file, parsed } = await readCatalog(targetWorkdir)
    const ledger = await readLedger(ledgerFile)
    const list = applyLedgerToCatalog(parsed, ledger)
    return { file, parsed, list, ledgerFile }
  }

  async function updateFeature(targetWorkdir, id, changes) {
    const { parsed } = await readCatalog(targetWorkdir)
    const catalogItem = parsed.find((item) => String(item.id) === String(id))
    if (!catalogItem) fail(`unknown Work Item ${id}`)
    const progress = {}
    for (const [key, value] of Object.entries(changes)) {
      if (PROGRESS_FIELDS.has(key)) progress[key] = value
    }
    if (!Object.keys(progress).length) fail(`updateFeature for ${id} requires progress fields`)
    await updateLedgerItem(ledgerFile, id, progress)
    const ledger = await readLedger(ledgerFile)
    return applyLedgerToCatalog([catalogItem], ledger)[0]
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
    ledgerFile,
    getState,
    setState,
  }
}
