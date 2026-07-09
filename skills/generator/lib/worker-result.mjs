import { resultFileFromRunState } from './project-keys.mjs'
import { atomicJson, readJson } from './fs-json.mjs'

export { resultFileFromRunState }

export async function writeWorkerResult(runStateFilePath, result) {
  const file = resultFileFromRunState(runStateFilePath)
  await atomicJson(file, {
    at: new Date().toISOString(),
    exitCode: result.exitCode ?? 0,
    ...result.payload,
  })
  return file
}

export async function readWorkerResult(runStateFilePath) {
  const file = resultFileFromRunState(runStateFilePath)
  const value = await readJson(file, null)
  if (!value || typeof value !== 'object') return null
  return value
}

export async function clearWorkerResult(runStateFilePath) {
  const file = resultFileFromRunState(runStateFilePath)
  try { await import('node:fs/promises').then(({ unlink }) => unlink(file)) } catch {}
}
