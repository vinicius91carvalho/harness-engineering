/**
 * Resolve shared workflow-active helper from supervisor lib (HE tree or ~/.agents).
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const candidates = [
  join(here, '../../supervisor/lib/workflow-active.mjs'),
  join(here, '../../harness-supervisor/lib/workflow-active.mjs'),
  `${process.env.HOME || ''}/.agents/skills/supervisor/lib/workflow-active.mjs`,
  `${process.env.HOME || ''}/.agents/skills/harness-supervisor/lib/workflow-active.mjs`,
].filter(Boolean)

const found = candidates.find((p) => existsSync(p))
if (!found) {
  throw new Error(`workflow-active.mjs not found; tried: ${candidates.join(', ')}`)
}
const mod = await import(pathToFileURL(found).href)
export const remainingFromProgress = mod.remainingFromProgress
export const projectWorkflowActive = mod.projectWorkflowActive
export const fleetWorkflowActive = mod.fleetWorkflowActive
