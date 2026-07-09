import { join } from 'node:path'

export function sanitizeKey(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_')
}

export function projectIdFromPrefix(projectPrefix) {
  const trimmed = String(projectPrefix || '').replace(/\/$/, '')
  return trimmed ? trimmed.replace(/[^a-zA-Z0-9_-]/g, '_') : 'root'
}

export function claimKey(projectId, context) {
  return projectId === 'root' ? context : `${projectId}--${context}`
}

export function runStateFile(commonGit, projectPrefix, context) {
  const projectId = projectIdFromPrefix(projectPrefix)
  const name = sanitizeKey(projectPrefix ? `${projectId}--${context}` : context)
  return join(commonGit, 'harness-runs', `${name}.json`)
}

export function resultFileFromRunState(runStateFilePath) {
  return runStateFilePath.replace(/\.json$/, '.result.json')
}

export function scopeClaims(claims, projectPrefix) {
  if (!projectPrefix) return claims
  const projectId = projectIdFromPrefix(projectPrefix)
  const prefix = `${projectId}--`
  return Object.fromEntries(Object.entries(claims).filter(([key]) => key.startsWith(prefix)))
}
