#!/usr/bin/env node
/**
 * Durable ops heartbeat: check fleet health, auto-remediate host stalls, escalate.
 *
 * Intended for systemd --user timers. Does not depend on Cursor chat being awake.
 *
 * usage:
 *   node ops-remediate.mjs --repo /path/to/project [--project root] [--notify]
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const out = {
    repo: null,
    project: null,
    notify: false,
    wakeHost: true,
    invokeAgent: process.env.HARNESS_WAKE_INVOKE === '1',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--repo') out.repo = argv[++i]
    else if (a === '--project' || a === '--projects') out.project = argv[++i]
    else if (a === '--notify') out.notify = true
    else if (a === '--wake-host') out.wakeHost = true
    else if (a === '--no-wake-host') out.wakeHost = false
    else if (a === '--invoke-agent') out.invokeAgent = true
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

function resolveControl() {
  const candidates = [
    process.env.HARNESS_CONTROL,
    join(here, '../../supervisor/scripts/harness-control.mjs'),
    join(here, '../../../harness-supervisor/scripts/harness-control.mjs'),
    `${process.env.HOME}/.agents/skills/supervisor/scripts/harness-control.mjs`,
    `${process.env.HOME}/.agents/skills/harness-supervisor/scripts/harness-control.mjs`,
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  throw new Error('harness-control.mjs not found; set HARNESS_CONTROL')
}

function run(node, args, env) {
  return spawnSync(node, args, { encoding: 'utf8', env, maxBuffer: 20 * 1024 * 1024 })
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.repo) {
    process.stdout.write(
      'usage: ops-remediate.mjs --repo <path> [--project root] [--notify] [--wake-host|--no-wake-host] [--invoke-agent]\n',
    )
    process.exit(args.help ? 0 : 2)
  }
  const repo = resolve(args.repo)
  const control = resolveControl()
  const checkScript = join(here, 'ops-cron-check.mjs')
  const wakeScript = join(here, 'wake-control-host.mjs')
  const env = { ...process.env }

  // 1) Auto-remediate first (free slots / clear locks), then check.
  const remediateArgs = [control, 'remediate', '--repo', repo, '--host', process.env.HARNESS_HOST || 'agent']
  const rem = run(process.execPath, remediateArgs, env)
  if (rem.stdout) process.stdout.write(rem.stdout)
  if (rem.status && rem.status !== 0) {
    process.stderr.write(rem.stderr || `remediate exit ${rem.status}\n`)
  }

  // 2) Health check (+ optional desktop notify every tick).
  const checkArgs = [checkScript, '--repo', repo]
  if (args.project) checkArgs.push('--project', args.project)
  if (args.notify) checkArgs.push('--notify')
  const check = run(process.execPath, checkArgs, env)
  if (check.stdout) process.stdout.write(check.stdout)
  if (check.stderr) process.stderr.write(check.stderr)

  // 3) Representative Control Host: progress brief + judgment wake bridge.
  if (args.wakeHost && existsSync(wakeScript)) {
    const wakeArgs = [wakeScript, '--repo', repo, '--brief']
    if (args.notify) wakeArgs.push('--notify')
    if (args.invokeAgent) wakeArgs.push('--invoke-agent')
    const wake = run(process.execPath, wakeArgs, env)
    if (wake.stdout) process.stdout.write(wake.stdout)
    if (wake.stderr) process.stderr.write(wake.stderr)
  }

  let remJson = null
  try { remJson = JSON.parse(rem.stdout || '{}') } catch { /* ignore */ }
  if (remJson?.escalate) process.exit(1)
  process.exit(check.status === 0 ? 0 : (check.status || 1))
}

main()
