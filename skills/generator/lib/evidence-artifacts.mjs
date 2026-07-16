import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { sanitizeKey } from './project-keys.mjs'

/**
 * Immutable Evidence Artifact store.
 * Paths are project/run/context/attempt scoped and create-only.
 */
export function evidenceRoot(commonGit, projectId) {
  return join(commonGit, 'harness-evidence', sanitizeKey(projectId || 'root'))
}

export async function putEvidenceArtifact({
  commonGit,
  projectId,
  runId,
  context,
  workItemId,
  attempt,
  kind,
  detail,
  route = null,
}) {
  const dir = join(
    evidenceRoot(commonGit, projectId),
    sanitizeKey(runId || 'run'),
    sanitizeKey(context),
  )
  await mkdir(dir, { recursive: true })
  const digest = createHash('sha256').update(String(detail)).digest('hex').slice(0, 16)
  const base = [
    sanitizeKey(String(workItemId)),
    String(attempt),
    sanitizeKey(String(kind).toLowerCase()),
    digest,
  ].join('-')
  const file = join(dir, `${base}.log`)
  const header = [
    `project=${projectId}`,
    `run=${runId || ''}`,
    `context=${context}`,
    `id=${workItemId}`,
    `attempt=${attempt}`,
    `kind=${kind}`,
    `digest=${digest}`,
    route ? `route=${JSON.stringify(route)}` : '',
    `at=${new Date().toISOString()}`,
  ].filter(Boolean).join('\n')
  // wx: create-only; concurrent same-digest writers treat EEXIST as success.
  try {
    const handle = await open(file, 'wx')
    try {
      await handle.writeFile(`${header}\n\n${detail}`)
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  return { path: file, digest, immutable: true }
}

export function newRunId() {
  return randomUUID()
}
