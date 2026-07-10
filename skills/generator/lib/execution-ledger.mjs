import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicJson } from './fs-json.mjs'
import { sanitizeKey } from './project-keys.mjs'

/** Execution Ledger: mutable Work Item progress, separate from feature_list.json catalog. */
export function ledgerPath(commonGit, projectId) {
  return join(commonGit, 'harness-ledger', `${sanitizeKey(projectId || 'root')}.json`)
}

export function emptyLedger() {
  return { version: 1, items: {}, updatedAt: null }
}

function parseLedgerFile(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  return JSON.parse(raw)
}

function normalizeLedger(value, file) {
  if (!value) return emptyLedger()
  if (typeof value !== 'object' || value.version !== 1 || typeof value.items !== 'object') {
    throw new Error(`malformed Execution Ledger: ${file}`)
  }
  return value
}

export function readLedgerSync(file) {
  return normalizeLedger(parseLedgerFile(file), file)
}

export async function readLedger(file) {
  return readLedgerSync(file)
}

export async function writeLedger(file, ledger) {
  const next = {
    version: 1,
    items: ledger.items || {},
    updatedAt: new Date().toISOString(),
  }
  await atomicJson(file, next)
  return next
}

export async function updateLedgerItem(file, workItemId, changes) {
  const ledger = await readLedger(file)
  const key = String(workItemId)
  ledger.items[key] = {
    implementation: false,
    qa: false,
    integration: false,
    blocked: false,
    retries: 0,
    ...(ledger.items[key] || {}),
    ...changes,
  }
  return writeLedger(file, ledger)
}

/** Merge ledger progress onto catalog rows for readiness/completion views. */
export function applyLedgerToCatalog(catalog, ledger) {
  if (!ledger?.items) return catalog
  return catalog.map((item) => {
    const progress = ledger.items[String(item.id)]
    if (!progress) return item
    return { ...item, ...progress }
  })
}
