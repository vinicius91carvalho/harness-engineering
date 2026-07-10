import { spawn, spawnSync } from 'node:child_process'

/** Kill a host agent child and its PTY wrapper process group. */
export function terminateHostProcess(child, signal = 'SIGTERM') {
  if (!child?.pid) return
  const pid = child.pid
  const sig = signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM'
  try {
    if (process.platform !== 'win32') {
      spawnSync('pkill', [`-${sig === 'SIGKILL' ? '9' : '15'}`, '-P', String(pid)], { stdio: 'ignore' })
      try { process.kill(-pid, sig) } catch {}
    }
  } catch {}
  try { child.kill(sig) } catch {}
}

export function hostSpawnVisible() {
  return process.env.HARNESS_HERDR_PANE === '1' || process.env.HARNESS_DISPLAY === 'herdr'
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function commandExists(cmd) {
  return spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0
}

/**
 * Spawn a host CLI so herdr panes show live agent thinking/tool output.
 * Uses `script -f` for a flushed PTY; stdout/stderr stay piped so the
 * orchestrator can capture the verdict while mirroring every chunk to the pane.
 */
export function spawnHostAgent(program, args, { cwd, env = {}, visible = hostSpawnVisible() } = {}) {
  const mergedEnv = { ...process.env, ...env }
  if (visible) mergedEnv.PYTHONUNBUFFERED = mergedEnv.PYTHONUNBUFFERED || '1'
  const usePty = visible && commandExists('script')
  if (usePty) {
    const cmd = [program, ...args].map(shellQuote).join(' ')
    // -f flushes after each write so thinking/tool logs appear in the pane live,
    // not only when the agent process exits.
    return spawn('script', ['-q', '-e', '-f', '-c', cmd, '/dev/null'], {
      cwd,
      env: mergedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
  return spawn(program, args, {
    cwd,
    detached: visible ? false : process.platform !== 'win32',
    env: mergedEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** Build the argv used for herdr-visible agent spawns (testable). */
export function visibleScriptArgv(program, args) {
  const cmd = [program, ...args].map(shellQuote).join(' ')
  return ['script', ['-q', '-e', '-f', '-c', cmd, '/dev/null']]
}
