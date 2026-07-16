#!/usr/bin/env node
/**
 * Thin Goal Review CLI for /evaluator.
 * Resolves PROJECT and the integration checkout, then shells to orchestrator --mode goal-review.
 */
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveProjectRoot } from '../generator/lib/project-topology.mjs'
import { resolveIntegrationCheckout } from '../generator/lib/integration-branch.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const genDir = join(__dirname, '..', 'generator')

function usage() {
  console.error(`usage: goal-review.mjs [--host <host>] [--port <port>] [--workdir <dir>] [projectDir]

Runs orchestrator --mode goal-review on the plan integration checkout
(not main/master while a plan pin exists).`)
  process.exit(1)
}

function parseArgs(argv) {
  let host = process.env.HARNESS_HOST || 'claude'
  let port = '5170'
  let workdir = null
  let projectDir = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--host') host = argv[++i] || host
    else if (arg === '--port') port = argv[++i] || port
    else if (arg === '--workdir') workdir = argv[++i] || null
    else if (arg === '--help' || arg === '-h') usage()
    else if (!arg.startsWith('-') && !projectDir) projectDir = arg
    else {
      console.error(`unknown argument: ${arg}`)
      usage()
    }
  }
  return { host, port, workdir, projectDir }
}

function main() {
  const { host, port, workdir: workdirArg, projectDir } = parseArgs(process.argv.slice(2))
  let project
  try {
    project = resolveProjectRoot(projectDir || process.cwd())
  } catch (error) {
    console.error(`goal-review: ${error.message}`)
    process.exit(1)
  }
  let workdir
  try {
    workdir = workdirArg ? resolve(workdirArg) : resolveIntegrationCheckout(project)
  } catch (error) {
    console.error(`goal-review: ${error.message}`)
    process.exit(1)
  }
  const orchestrator = join(genDir, 'orchestrator.mjs')
  const claimScript = join(genDir, 'claim.sh')
  const result = spawnSync(process.execPath, [
    orchestrator,
    '--host', host,
    '--repo', project,
    '--workdir', workdir,
    '--mode', 'goal-review',
    '--context', 'goal-review',
    '--port', String(port),
    '--claim-script', claimScript,
  ], { stdio: 'inherit', env: process.env })
  process.exit(result.status == null ? 1 : result.status)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
