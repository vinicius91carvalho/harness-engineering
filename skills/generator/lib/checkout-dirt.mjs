/**
 * Goal Review treats the integration checkout as read-only, but workers
 * legitimately leave ephemeral runtime files under `.harness/` (app.pid, etc.),
 * build caches (`.turbo/cache`), Workflow Journal markdown under `harness-progress/`,
 * Cursor/Agent harness skill mirrors under `.cursor/`, and monorepos often have
 * unrelated untracked files outside the Project Goal.
 * Those must not fail the dirty check - only meaningful tracked product
 * modifications do.
 *
 * Ignoring `harness-progress/` matters: a Goal Review agent that writes
 * `harness-progress/goal-review.md` before the post-run dirty gate used to
 * return `blocked:true` and skip `reopened` for real AC defects (CauseFlow web
 * AC-014 /get-started staging redirect, 2026-07-12).
 *
 * Ignoring `.cursor/plugins/local/harness/` + `.cursor/skills/` matters:
 * harness-* rename / install-reconcile sync leaves tracked M/D under those
 * trees while the Execution Ledger is fully integrated. That dirt is not
 * product code, but it used to keep `goalReviewAdmissible` at `dirty-checkout`
 * with `needsGoalReviewRetry=true` and an empty fleet forever (CauseFlow root
 * OSS, 2026-07-17, after WI-AC-026 integrate).
 *
 * Ignoring tracked `.harness/wi-ac-*` / `goal-review*` / `gr-*` probe artifacts
 * matters: Goal Review black-box runs rewrite verify-first JSON and compose
 * probe logs under `.harness/`. Those used to fail the post-run dirty gate with
 * `blocked:true` and skip reopen of real AC defects (CauseFlow root 2026-07-17:
 * AC-025/AC-026 Ornith compose `127.0.0.1:8081` unreachable masked by
 * `M .harness/wi-ac-*-verify-first.json`). Aligns with
 * `worker-outcome.isWorkerSideChannelArtifact`.
 *
 * Ignoring tracked `feature_list.json` matters: coding/QA/IV workers rewrite
 * implementation/qa/integration flags (and JSON unicode escapes) in the working
 * tree without committing. The Execution Ledger is the pass/fail source of truth
 * for Goal Review admission; leaving `M feature_list.json` used to keep
 * `goalReviewAdmissible` at `dirty-checkout` with `needsGoalReviewRetry=true`
 * and an empty fleet after N/N repair (CauseFlow root OSS, 2026-07-17, after
 * WI-AC-026 INTEGRATION_QA green).
 */
const RUNTIME_PID_DIRT = /(?:^|\/)\.harness\/[^/\s]+\.pid$/
/** Harness probe / side-channel artifacts under `.harness/` (not product code). */
const HARNESS_SIDECHANNEL_DIRT =
  /(?:^|\/)\.harness\/(?:runtime-owned\.jsonl|(?:wi[-_]ac[-_][^/\s]*|goal-review[^/\s]*|gr[-_][^/\s]*)\.(?:json|log|txt|mjs))$/i
/** Turbo / Next / Vite / package-manager caches that churn without product intent. */
const BUILD_CACHE_DIRT = /(?:^|\/)(?:\.turbo(?:\/|$)|\.next(?:\/|$)|\.nuxt(?:\/|$)|dist\/|\.cache(?:\/|$)|node_modules\/)/
/** Append-only harness Workflow Journals - not product code. */
const HARNESS_JOURNAL_DIRT = /(?:^|\/)harness-progress\//
/**
 * Installed Cursor plugin + discoverable skill mirrors from harness sync.
 * Tracked churn here is workflow packaging, not Project Goal product code.
 */
const HARNESS_SKILL_MIRROR_DIRT = /(?:^|\/)\.cursor\/(?:plugins\/local\/harness\/|skills\/)/
/**
 * Work Item catalog flags / status rewritten by harness workers.
 * Ledger owns integration truth for Goal Review; do not block on catalog churn.
 */
const FEATURE_LIST_DIRT = /(?:^|\/)feature_list\.json$/
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
  const path = porcelainPath(line)
  return RUNTIME_PID_DIRT.test(path) || HARNESS_SIDECHANNEL_DIRT.test(path)
}

export function isBuildCacheCheckoutDirt(line) {
  return BUILD_CACHE_DIRT.test(porcelainPath(line))
}

export function isHarnessJournalCheckoutDirt(line) {
  return HARNESS_JOURNAL_DIRT.test(porcelainPath(line))
}

export function isHarnessSkillMirrorCheckoutDirt(line) {
  return HARNESS_SKILL_MIRROR_DIRT.test(porcelainPath(line))
}

/** Harness-owned Work Item catalog flag/status churn (not product source). */
export function isFeatureListCheckoutDirt(line) {
  return FEATURE_LIST_DIRT.test(porcelainPath(line))
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
    .filter((line) => !isHarnessSkillMirrorCheckoutDirt(line))
    .filter((line) => !isFeatureListCheckoutDirt(line))
    .filter((line) => !isUntrackedOrIgnoredDirt(line))
    .join('\n')
}

/** True when porcelain has no tracked dirt that should block Goal Review. */
export function isCheckoutCleanForGoalReview(porcelain) {
  return meaningfulCheckoutDirt(porcelain) === ''
}
