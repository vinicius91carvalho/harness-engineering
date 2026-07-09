import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { gitRoot } from './git-repo.mjs'

export async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return fallback }
}

// feature_list.json is committed into target repos whose own Acceptance Checks may run
// a repo-wide formatter/linter (e.g. `biome check .`). Reformat it in place with whatever
// formatter the target already has installed, rather than guessing its rules, so the
// harness never introduces a violation of the target's own tooling. Only ever runs a
// binary the target repo itself installed under node_modules/.bin (never a bare `npx
// <name>`, which can silently resolve an unrelated same-named package from npx's cache).
function reformatFeatureList(file) {
  const dir = dirname(file)
  let root
  try { root = gitRoot(dir) } catch { root = dir }
  for (const [bin, args] of [['biome', ['format', '--write']], ['prettier', ['--write']]]) {
    const path = [dir, root].map((base) => join(base, 'node_modules', '.bin', bin)).find(existsSync)
    if (!path) continue
    const result = spawnSync(path, [...args, file], { cwd: dir, stdio: 'ignore' })
    if (result.status === 0) return
  }
}

export async function atomicJson(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.tmp.${process.pid}.${randomUUID()}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temporary, file)
  if (basename(file) === 'feature_list.json') reformatFeatureList(file)
}
