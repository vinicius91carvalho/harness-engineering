import { appendFile, mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { processAlive } from './orphan-claims.mjs'

/**
 * Append-only Control Journal.
 * Fail-closed on torn/malformed tails. IDs allocated under an exclusive lock file.
 * Optional compaction folds prefix into a snapshot while preserving Input Request lineage.
 */

export function journalPaths(controlRoot) {
  return {
    events: join(controlRoot, 'events.jsonl'),
    meta: join(controlRoot, 'journal-meta.json'),
    snapshot: join(controlRoot, 'journal-snapshot.json'),
    lock: join(controlRoot, 'journal.lock'),
  }
}

/** Token format: `${pid}.${uuid}`. Live holder → true; missing/unreadable/dead → false. */
export function journalLockHolderAlive(lockPath) {
  if (!existsSync(lockPath)) return false
  try {
    const token = String(readFileSync(lockPath, 'utf8') || '').trim()
    const pid = Number(String(token).split('.')[0])
    if (!Number.isFinite(pid) || pid <= 0) return false
    return processAlive(pid)
  } catch {
    return false
  }
}

async function stealDeadJournalLock(lockPath) {
  if (!existsSync(lockPath)) return false
  if (journalLockHolderAlive(lockPath)) return false
  try {
    await unlink(lockPath)
    return true
  } catch {
    return false
  }
}

async function withJournalLock(lockPath, fn) {
  await mkdir(dirname(lockPath), { recursive: true })
  const token = `${process.pid}.${randomUUID()}`
  const started = Date.now()
  let stoleDead = false
  while (true) {
    try {
      const { open } = await import('node:fs/promises')
      const handle = await open(lockPath, 'wx')
      await handle.writeFile(token)
      await handle.close()
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      // Crashed writers leave journal.lock behind; steal once so initialize() cannot
      // brick the supervisor with "control journal lock timeout".
      if (!stoleDead && await stealDeadJournalLock(lockPath)) {
        stoleDead = true
        continue
      }
      if (Date.now() - started > 10_000) throw new Error('control journal lock timeout')
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  try {
    return await fn()
  } finally {
    try { await unlink(lockPath) } catch {}
  }
}

function parseJsonl(text) {
  if (!text.trim()) return []
  const lines = text.split('\n')
  const events = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch (error) {
      const err = new Error(`control journal corrupt at line ${i + 1}: ${error.message}`)
      err.code = 'CONTROL_JOURNAL_CORRUPT'
      err.partialEvents = events
      throw err
    }
  }
  return events
}

export function deriveSnapshot(events) {
  const snapshot = {
    runId: null,
    status: 'not_started',
    pendingInputs: {},
    startedAt: null,
    completedAt: null,
    lastProgress: null,
  }
  for (const event of events) {
    switch (event.kind) {
      case 'run_started':
        snapshot.runId = event.runId
        snapshot.status = 'running'
        snapshot.startedAt = event.at
        break
      case 'run_completed':
        snapshot.status = 'complete'
        snapshot.completedAt = event.at
        break
      case 'supervisor_stopped':
        snapshot.status = 'interrupted'
        break
      case 'supervisor_failed':
        snapshot.status = 'needs_input'
        break
      case 'input_required':
        snapshot.pendingInputs[event.id] = { ...event, status: 'pending' }
        if (event.scope === 'goal') snapshot.status = 'needs_input'
        break
      case 'input_received':
        if (snapshot.pendingInputs[event.requestId]) {
          snapshot.pendingInputs[event.requestId] = {
            ...snapshot.pendingInputs[event.requestId],
            status: 'responded',
            response: { action: event.action, guidance: event.guidance },
          }
          if (event.action === 'pause') snapshot.status = 'paused'
          else if (event.action === 'abort') snapshot.status = 'stopped'
          else if (event.action === 'retry') snapshot.status = 'running'
        }
        break
      case 'input_auto_responded':
        if (snapshot.pendingInputs[event.requestId]) {
          snapshot.pendingInputs[event.requestId] = {
            ...snapshot.pendingInputs[event.requestId],
            status: 'responded',
            response: { action: event.action, auto: true },
          }
        }
        break
      case 'progress':
        snapshot.lastProgress = event
        break
      default:
        break
    }
  }
  return snapshot
}

function inputLineageIds(events) {
  const keep = new Set()
  const derived = deriveSnapshot(events)
  for (const [id, row] of Object.entries(derived.pendingInputs)) {
    if (row.status !== 'pending') continue
    const numId = Number(id)
    keep.add(numId)
    for (const event of events) {
      if (event.kind === 'input_required' && event.id === numId) keep.add(event.id)
      if (event.requestId === numId) keep.add(event.id)
    }
  }
  return keep
}

/** Max numeric id in a raw JSONL file (ignores dedupe). Used to bootstrap journal-meta. */
export function maxRawEventIdFromText(text) {
  let max = 0
  for (const event of parseJsonl(text || '')) {
    const id = Number(event?.id)
    if (Number.isFinite(id) && id > max) max = id
  }
  return max
}

export async function readControlEvents(controlRootOrFile, maybeFile) {
  const controlRoot = maybeFile ? controlRootOrFile : dirname(controlRootOrFile)
  const eventsFile = maybeFile || controlRootOrFile
  const paths = journalPaths(controlRoot)
  const preserved = []
  if (existsSync(paths.snapshot)) {
    try {
      const snap = JSON.parse(await readFile(paths.snapshot, 'utf8'))
      if (Array.isArray(snap.preservedEvents)) preserved.push(...snap.preservedEvents)
    } catch (error) {
      const err = new Error(`control journal snapshot corrupt: ${error.message}`)
      err.code = 'CONTROL_JOURNAL_CORRUPT'
      throw err
    }
  }
  if (!existsSync(eventsFile)) {
    return preserved.sort((a, b) => a.id - b.id)
  }
  const tail = parseJsonl(await readFile(eventsFile, 'utf8'))
  // File order: later duplicate ids win so recycled/corrupt journals still surface
  // the newest input_required (needed by harness-control respond).
  const byId = new Map()
  for (const event of [...preserved, ...tail]) byId.set(event.id, event)
  return [...byId.values()].sort((a, b) => a.id - b.id)
}

export async function appendControlEvent(controlRoot, event, lease = null) {
  const paths = journalPaths(controlRoot)
  if (lease?.token) {
    const { assertSupervisorLease } = await import('./supervisor-lease.mjs')
    await assertSupervisorLease(controlRoot, lease)
  }
  return withJournalLock(paths.lock, async () => {
    let meta = { lastId: 0, compactedThroughId: 0 }
    if (existsSync(paths.meta)) {
      meta = JSON.parse(await readFile(paths.meta, 'utf8'))
    } else if (existsSync(paths.events)) {
      // Bootstrap from RAW max id — deduped reads under-count when ids were recycled.
      meta.lastId = maxRawEventIdFromText(await readFile(paths.events, 'utf8'))
    }
    const id = meta.lastId + 1
    // Allocated id/at must win over any caller-supplied fields (e.g. spread health objects).
    const record = { ...event, id, at: new Date().toISOString() }
    await mkdir(dirname(paths.events), { recursive: true })
    await appendFile(paths.events, `${JSON.stringify(record)}\n`)
    const temporary = `${paths.meta}.tmp.${process.pid}.${randomUUID()}`
    await writeFile(temporary, `${JSON.stringify({ ...meta, lastId: id }, null, 2)}\n`)
    await rename(temporary, paths.meta)
    return record
  })
}

/**
 * Compact the journal prefix into a derived snapshot.
 * Pending Input Requests and their lineage events are never dropped.
 */
export async function compactControlJournal(controlRoot, {
  minTail = 50,
  lease = null,
} = {}) {
  const paths = journalPaths(controlRoot)
  if (lease?.token) {
    const { assertSupervisorLease } = await import('./supervisor-lease.mjs')
    await assertSupervisorLease(controlRoot, lease)
  }
  return withJournalLock(paths.lock, async () => {
    const all = await readControlEvents(controlRoot, paths.events)
    if (all.length <= minTail) return { compacted: false, kept: all.length }

    const lineage = inputLineageIds(all)
    const sorted = [...all].sort((a, b) => a.id - b.id)
    const tailCut = sorted[sorted.length - minTail].id
    const keep = new Set(sorted.filter((event) => event.id >= tailCut || lineage.has(event.id)).map((event) => event.id))
    const preserved = sorted.filter((event) => !keep.has(event.id))
    const tail = sorted.filter((event) => keep.has(event.id))
    if (!preserved.length) return { compacted: false, kept: all.length }

    const compactedThroughId = Math.max(...preserved.map((event) => event.id))
    const derived = deriveSnapshot(all)
    const lineagePreserved = preserved.filter((event) =>
      event.kind === 'input_required'
      || event.kind === 'input_received'
      || event.kind === 'input_auto_responded',
    )
    const snapshotBody = {
      compactedThroughId,
      derived,
      preservedEvents: lineagePreserved,
      at: new Date().toISOString(),
    }
    const snapTmp = `${paths.snapshot}.tmp.${process.pid}.${randomUUID()}`
    await writeFile(snapTmp, `${JSON.stringify(snapshotBody, null, 2)}\n`)
    await rename(snapTmp, paths.snapshot)

    const eventsTmp = `${paths.events}.tmp.${process.pid}.${randomUUID()}`
    await writeFile(eventsTmp, tail.map((event) => `${JSON.stringify(event)}\n`).join(''))
    await rename(eventsTmp, paths.events)

    let meta = { lastId: sorted.at(-1)?.id || 0, compactedThroughId: 0 }
    if (existsSync(paths.meta)) meta = JSON.parse(await readFile(paths.meta, 'utf8'))
    meta.compactedThroughId = compactedThroughId
    meta.lastId = sorted.at(-1)?.id || meta.lastId
    const metaTmp = `${paths.meta}.tmp.${process.pid}.${randomUUID()}`
    await writeFile(metaTmp, `${JSON.stringify(meta, null, 2)}\n`)
    await rename(metaTmp, paths.meta)

    return {
      compacted: true,
      compactedThroughId,
      tailCount: tail.length,
      preservedLineage: lineagePreserved.length,
    }
  })
}

export async function maybeCompactControlJournal(controlRoot, {
  minTail = 50,
  lease = null,
} = {}) {
  const paths = journalPaths(controlRoot)
  try {
    const meta = existsSync(paths.meta) ? JSON.parse(await readFile(paths.meta, 'utf8')) : null
    if (!meta || !Number.isFinite(Number(meta.lastId))) {
      return await compactControlJournal(controlRoot, { minTail, lease })
    }
    const compactedThroughId = Number(meta.compactedThroughId || 0)
    const tailEstimate = Number(meta.lastId) - compactedThroughId
    if (tailEstimate <= minTail) {
      return {
        compacted: false,
        skipped: true,
        reason: 'tail-below-threshold',
        kept: tailEstimate,
      }
    }
  } catch {
    return await compactControlJournal(controlRoot, { minTail, lease })
  }
  return await compactControlJournal(controlRoot, { minTail, lease })
}
