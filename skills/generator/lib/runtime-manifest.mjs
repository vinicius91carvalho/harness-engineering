import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function runtimeManifestPath(workdir) {
  return workdir ? join(workdir, '.harness', 'runtime-owned.jsonl') : null
}

export function appendOwnedRuntime(workdir, row = {}) {
  const file = runtimeManifestPath(workdir)
  if (!file) return false
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`)
  return true
}

export function readOwnedRuntime(workdir) {
  const file = runtimeManifestPath(workdir)
  if (!file || !existsSync(file)) return []
  const rows = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object') rows.push(parsed)
    } catch {}
  }
  return rows
}
