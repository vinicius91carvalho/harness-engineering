/**
 * Resolve generator / supervisor runtime trees after the harness-* rename.
 * Unprefixed `generator/` and `supervisor/` are import aliases (no SKILL.md);
 * discoverable skills live under `harness-generator` / `harness-supervisor`.
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Markers that prove a generator tree can load orchestrator + importLib. */
export const GENERATOR_RUNTIME_MARKERS = [
  'orchestrator.mjs',
  'reconcile.mjs',
  'lib/observation-method.mjs',
  'adapters/hosts.mjs',
]

export function generatorRuntimeReady(root) {
  if (!root || !existsSync(root)) return false
  return GENERATOR_RUNTIME_MARKERS.every((rel) => existsSync(join(root, rel)))
}

/**
 * Prefer a complete unprefixed alias, then harness-generator.
 * Never prefer an incomplete `generator/` over a complete namespaced tree —
 * that is what caused supervisor_tick_failed / worker_crash_loop spam.
 */
export function resolveGeneratorDir(scriptFile, override = null) {
  if (override) return resolve(override)
  const skillsRoot = resolve(dirname(scriptFile), '..', '..')
  const bundled = join(skillsRoot, 'generator')
  const namespaced = join(skillsRoot, 'harness-generator')
  if (generatorRuntimeReady(bundled)) return bundled
  if (generatorRuntimeReady(namespaced)) return namespaced
  if (existsSync(namespaced)) return namespaced
  return bundled
}

/** Backoff after repeated identical tick failures (caps journal spam). */
export function tickFailureDelay({
  pollMs = 2000,
  consecutiveFailures = 0,
} = {}) {
  const base = Math.max(250, Number(pollMs) || 2000)
  const n = Math.max(0, Number(consecutiveFailures) || 0)
  if (n < 1) return base
  // 1→2s, 2→4s, 3→8s … cap 60s (assuming base≥250)
  const factor = 2 ** Math.min(n, 8)
  return Math.min(60_000, Math.max(base, base * factor))
}
