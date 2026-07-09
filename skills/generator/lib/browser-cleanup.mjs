import { spawnSync } from 'node:child_process'

export function cleanupBrowserOrphans({ port } = {}) {
  if (process.platform === 'win32' || !port) return { killed: 0 }
  const patterns = [
    `-remote-debugging-port=${port}`,
    `--remote-debugging-port=${port}`,
    `playwright.*-remote-debugging-port=${port}`,
    `chromium.*-remote-debugging-port=${port}`,
    `chrome.*-remote-debugging-port=${port}`,
  ]
  let killed = 0
  for (const pattern of patterns) {
    const probe = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' })
    if (probe.status !== 0 || !probe.stdout.trim()) continue
    const pkill = spawnSync('pkill', ['-f', pattern], { encoding: 'utf8' })
    if (pkill.status === 0) killed++
  }
  return { killed }
}
