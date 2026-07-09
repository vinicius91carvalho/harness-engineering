import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'

export function git(repo, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  if (!allowFailure && result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'git failed').trim())
  }
  return result
}

export function gitCommonDir(repo) {
  const raw = git(repo, ['rev-parse', '--git-common-dir']).stdout.trim()
  return isAbsolute(raw) ? raw : resolve(repo, raw)
}

export function gitRoot(repo) {
  return git(repo, ['rev-parse', '--show-toplevel']).stdout.trim()
}

export function projectPrefix(repo) {
  return git(repo, ['rev-parse', '--show-prefix']).stdout.trim()
}

export function readFeatureListFromMain(repo) {
  const prefix = projectPrefix(repo)
  const spec = prefix ? `main:${prefix}feature_list.json` : 'main:feature_list.json'
  const result = git(repo, ['show', spec], { allowFailure: true })
  if (result.status !== 0) return null
  return JSON.parse(result.stdout)
}

export function portInUse(port) {
  const result = spawnSync('bash', ['-c', `echo >/dev/tcp/127.0.0.1/${port}`], { encoding: 'utf8' })
  return result.status === 0
}

export function processAlive(pid) {
  if (!pid) return false
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}

export function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp.${process.pid}.${randomUUID()}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temporary, file)
}
