/**
 * Goal Review treats the integration checkout as read-only, but workers
 * legitimately leave ephemeral runtime files under `.harness/` (app.pid, etc.),
 * build caches (`.turbo/cache`), Workflow Journal markdown under `harness-progress/`,
 * and monorepos often have unrelated untracked files outside the Project Goal.
 * Those must not fail the dirty check - only meaningful tracked product
 * modifications do.
 *
 * Ignoring `harness-progress/` matters: a Goal Review agent that writes
 * `harness-progress/goal-review.md` before the post-run dirty gate used to
 * return `blocked:true` and skip `reopened` for real AC defects (CauseFlow web
 * AC-014 /get-started staging redirect, 2026-07-12).
 */
const RUNTIME_DIRT = /(?:^|\/)\.harness\/[^/\s]+\.pid$/
/** Turbo / Next / Vite / package-manager caches that churn without product intent. */
const BUILD_CACHE_DIRT = /(?:^|\/)(?:\.turbo(?:\/|$)|\.next(?:\/|$)|\.nuxt(?:\/|$)|dist\/|\.cache(?:\/|$)|node_modules\/)/
/** Append-only harness Workflow Journals - not product code. */
const HARNESS_JOURNAL_DIRT = /(?:^|\/)harness-progress\//
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

export function isBuildCacheCheckoutDirt(line) {
  return BUILD_CACHE_DIRT.test(porcelainPath(line))
}

export function isHarnessJournalCheckoutDirt(line) {
  return HARNESS_JOURNAL_DIRT.test(porcelainPath(line))
}

/** Untracked (`??`) and ignored (`!!`) paths do not block Goal Review. */
export function isUntrackedOrIgnoredDirt(line) {
  return /^\?\?|^!!/.test(String(line || ''))
}

/** Filter porcelain output down to dirt that blocks Goal Review. */
export function meaningfulCheckoutDirt(porcelain) {
  return String(porcelain || '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => !isRuntimeCheckoutDirt(line))
    .filter((line) => !isBuildCacheCheckoutDirt(line))
    .filter((line) => !isHarnessJournalCheckoutDirt(line))
    .filter((line) => !isUntrackedOrIgnoredDirt(line))
    .join('\n')
}

/** True when porcelain has no tracked dirt that should block Goal Review. */
export function isCheckoutCleanForGoalReview(porcelain) {
  return meaningfulCheckoutDirt(porcelain) === ''
}
