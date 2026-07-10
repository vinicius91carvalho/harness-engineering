#!/usr/bin/env node
/**
 * Exact bundle projection: copy only declared files for a catalog module.
 * Usage: node scripts/project-bundle.mjs <moduleId> <destDir> [--dry-run]
 */
import { projectBundle } from './install-reconcile.mjs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const moduleId = process.argv[2]
const dest = process.argv[3]
const dryRun = process.argv.includes('--dry-run')

if (!moduleId || !dest) {
  console.error('usage: project-bundle.mjs <moduleId> <destDir> [--dry-run]')
  process.exit(2)
}

try {
  const result = await projectBundle(root, moduleId, dest, { dryRun })
  console.log(JSON.stringify(result))
} catch (err) {
  console.error(err.message || err)
  process.exit(2)
}
