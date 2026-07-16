/**
 * Periodic Run State heartbeat with consecutive-failure escalation.
 * Clears the interval after maxConsecutiveFailures so a dead fence/IO path
 * cannot silently look like a live owner forever.
 */
export function startStateHeartbeat(writeState, {
  intervalMs = 15_000,
  maxConsecutiveFailures = 3,
  label = 'harness',
  onEscalated = null,
} = {}) {
  let failures = 0
  const timer = setInterval(() => {
    Promise.resolve()
      .then(() => writeState())
      .then(() => { failures = 0 })
      .catch((error) => {
        failures += 1
        const detail = error?.message || String(error)
        process.stderr.write(
          `${label} heartbeat write failed (${failures}/${maxConsecutiveFailures}): ${detail}\n`,
        )
        if (failures < maxConsecutiveFailures) return
        clearInterval(timer)
        try { onEscalated?.(error) } catch {}
      })
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return timer
}
