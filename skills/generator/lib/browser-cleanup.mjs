import { killMatchingPatterns } from './worker-lifecycle.mjs'

/**
 * Tear down browsers owned by this run only.
 * Requires port and/or workdir; never matches global headless chromium.
 */
export function cleanupBrowserOrphans({ port, workdir, profileDir } = {}) {
  if (process.platform === 'win32') return { killed: 0 }
  if (!port && !workdir && !profileDir) return { killed: 0 }
  const patterns = [
    port && `-remote-debugging-port=${port}`,
    port && `--remote-debugging-port=${port}`,
    port && `playwright.*${port}`,
    profileDir && `chrome.*--user-data-dir=${profileDir}`,
    profileDir && `chromium.*--user-data-dir=${profileDir}`,
    workdir && `chrome.*${workdir}`,
    workdir && `chromium.*${workdir}`,
    workdir && `playwright.*${workdir}`,
  ]
  return { killed: killMatchingPatterns(patterns) }
}
