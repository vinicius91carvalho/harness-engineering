/** Event-driven supervisor tick helpers with polling fallback. */

/** Floor when a watch fires so self-writes under watched paths cannot busy-loop. */
const DIRTY_MIN_MS = 50

export function nextTickDelay({
  pollMs = 2000,
  eventDriven = true,
  dirty = false,
  dueAt = null,
  now = Date.now(),
} = {}) {
  const base = Math.max(250, Number(pollMs) || 2000)
  if (!eventDriven) return base
  if (dirty) return DIRTY_MIN_MS
  if (dueAt) return Math.max(0, Math.min(base, Number(dueAt) - now))
  return base
}

export function tickWatchPaths({ controlRoot, runsDir, commonGit } = {}) {
  return [
    controlRoot,
    controlRoot ? `${controlRoot}/responses` : null,
    runsDir,
    commonGit ? `${commonGit}/harness-locks` : null,
  ].filter(Boolean)
}
