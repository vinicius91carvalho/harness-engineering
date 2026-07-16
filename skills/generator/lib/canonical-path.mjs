import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'

/** Resolve symlinks so /var/... and /private/var/... compare equal on macOS. */
export function canonicalPath(pathLike) {
  const abs = resolve(pathLike)
  if (!existsSync(abs)) return abs
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}

/** True when `node this-module.mjs` was invoked, even across symlinked argv paths. */
export function isCliEntry(argvPath, modulePath) {
  if (!argvPath) return false
  return canonicalPath(argvPath) === canonicalPath(modulePath)
}
