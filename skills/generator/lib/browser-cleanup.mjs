import { spawnSync } from 'node:child_process'

function killPatterns(patterns) {
  let killed = 0
  for (const pattern of patterns) {
    if (!pattern) continue
    const probe = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' })
    if (probe.status !== 0 || !probe.stdout.trim()) continue
    const pkill = spawnSync('pkill', ['-f', pattern], { encoding: 'utf8' })
    if (pkill.status === 0) killed++
  }
  return killed
}

/** Tear down headless browsers Playwright MCP, Codex, and agents leave behind. */
export function cleanupBrowserOrphans({ port, workdir } = {}) {
  if (process.platform === 'win32') return { killed: 0 }
  const patterns = [
    port && `-remote-debugging-port=${port}`,
    port && `--remote-debugging-port=${port}`,
    port && `playwright.*${port}`,
    'playwright.*chromium',
    'playwright.*chrome',
    'ms-playwright.*chrome',
    'ms-playwright.*chromium',
    'chromium.*--headless',
    'chrome.*--headless',
    'google-chrome.*--headless',
    'chrome.*--user-data-dir=.*/playwright',
    'chrome.*--user-data-dir=/tmp/playwright',
    'chromium.*--user-data-dir=/tmp/playwright',
    'chrome.*--user-data-dir=.*/.cache/ms-playwright',
    'chromium.*--user-data-dir=.*/.cache/ms-playwright',
    'chrome.*--user-data-dir=.*/cursor-browser',
    'chrome.*--user-data-dir=.*/cursor-playwright',
    workdir && `chrome.*${workdir}`,
    workdir && `chromium.*${workdir}`,
  ]
  return { killed: killPatterns(patterns) }
}
