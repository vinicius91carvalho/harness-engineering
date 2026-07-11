/**
 * Goal Review treats the integration checkout as read-only, but workers
 * legitimately leave ephemeral runtime files under `.harness/` (app.pid, etc.).
 * Those must not fail the dirty check.
 */
const RUNTIME_DIRT = /(?:^|\/)\.harness\/[^/\s]+\.pid$/

/** Path column from one `git status --porcelain` line. */
export function porcelainPath(line) {
  const text = String(line || '')
  // Rename: `R  old -> new` / copy: `C  old -> new`
  const arrow = text.indexOf(' -> ')
  if (arrow >= 0) return text.slice(arrow + 4).trim()
  // Standard: XY<space>path (XY may include ?/!)
  return text.replace(/^.. /, '').trim()
}

export function isRuntimeCheckoutDirt(line) {
  return RUNTIME_DIRT.test(porcelainPath(line))
}

/** Filter porcelain output down to dirt that blocks Goal Review. */
export function meaningfulCheckoutDirt(porcelain) {
  return String(porcelain || '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => !isRuntimeCheckoutDirt(line))
    .join('\n')
}
