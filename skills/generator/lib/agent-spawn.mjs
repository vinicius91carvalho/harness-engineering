import { spawn, spawnSync } from 'node:child_process'

export function hostSpawnVisible() {
  return process.env.HARNESS_HERDR_PANE === '1' || process.env.HARNESS_DISPLAY === 'herdr'
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function commandExists(cmd) {
  return spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0
}

/** Spawn a host CLI so herdr panes get a PTY (thinking/TUI) while stdout/stderr are still captured. */
export function spawnHostAgent(program, args, { cwd, env = {}, visible = hostSpawnVisible() } = {}) {
  const mergedEnv = { ...process.env, ...env }
  const usePty = visible && commandExists('script')
  if (usePty) {
    const cmd = [program, ...args].map(shellQuote).join(' ')
    return spawn('script', ['-q', '-e', '-c', cmd, '/dev/null'], {
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
