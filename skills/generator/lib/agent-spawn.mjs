import { spawn } from 'node:child_process'
import { terminateProcessTree } from './worker-lifecycle.mjs'

/** Kill a host agent child and its process group. */
export function terminateHostProcess(child, signal = 'SIGTERM') {
  if (!child?.pid) return
  terminateProcessTree(child.pid, signal)
  try { child.kill(signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM') } catch {}
}

/** Spawn a host CLI as a detached background child with piped stdout/stderr. */
export function spawnHostAgent(program, args, { cwd, env = {} } = {}) {
  return spawn(program, args, {
    cwd,
    detached: process.platform !== 'win32',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}
