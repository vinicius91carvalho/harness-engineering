/**
 * Supervisor-owned lifecycle for the host ops-cron systemd timer.
 * Arm on workflow start; disarm only when the whole fleet is idle/complete.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync as defaultSpawnSync } from 'node:child_process'
import { fleetWorkflowActive } from './workflow-active.mjs'

export function opsCronEnabled(env = process.env) {
  const raw = String(env.HARNESS_OPS_CRON ?? '1').trim().toLowerCase()
  return !['0', 'false', 'off', 'no'].includes(raw)
}

export function opsCronUnitName(env = process.env) {
  const fromEnv = String(env.HARNESS_OPS_CRON_UNIT || '').trim()
  return fromEnv || 'harness-ops-cron'
}

function skillsRoots(scriptFile, env = process.env) {
  const roots = []
  if (scriptFile) {
    // harness-control.mjs → skills/supervisor/scripts → skills/
    roots.push(resolve(dirname(scriptFile), '..', '..'))
  }
  const home = env.HOME || ''
  if (home) {
    roots.push(join(home, '.agents', 'skills'))
    roots.push(join(home, '.claude', 'skills'))
  }
  return roots
}

export function resolveOpsCronScript(kind, { scriptFile, env = process.env } = {}) {
  const name = kind === 'disable' ? 'disable-ops-cron.sh' : 'install-ops-cron.sh'
  const rels = [
    join('monorepo-supervisor-ops', 'scripts', name),
    join('harness-monorepo-supervisor-ops', 'scripts', name),
  ]
  for (const root of skillsRoots(scriptFile, env)) {
    for (const rel of rels) {
      const candidate = join(root, rel)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

function markerPath(commonGit) {
  return join(commonGit, 'harness-control', 'ops-cron-armed.json')
}

export function readOpsCronMarker(commonGit) {
  try {
    return JSON.parse(readFileSync(markerPath(commonGit), 'utf8'))
  } catch {
    return null
  }
}

export function writeOpsCronMarker(commonGit, payload) {
  const dir = join(commonGit, 'harness-control')
  mkdirSync(dir, { recursive: true })
  writeFileSync(markerPath(commonGit), `${JSON.stringify(payload, null, 2)}\n`)
}

export function clearOpsCronMarker(commonGit) {
  try {
    unlinkSync(markerPath(commonGit))
  } catch {
    /* ignore */
  }
}

function systemctlAvailable(spawnSync) {
  const direct = spawnSync('systemctl', ['--version'], { encoding: 'utf8' })
  return direct.status === 0
}

/**
 * Install/enable the ops-cron timer for the Git top-level (idempotent).
 * Best-effort: never throws; returns { ok, skipped, reason, ... }.
 */
export function ensureOpsCron({
  gitRoot,
  commonGit = null,
  scriptFile = null,
  env = process.env,
  spawnSync = defaultSpawnSync,
} = {}) {
  if (!opsCronEnabled(env)) return { ok: true, skipped: true, reason: 'disabled' }
  if (!gitRoot) return { ok: false, skipped: true, reason: 'missing-git-root' }
  if (!systemctlAvailable(spawnSync)) return { ok: false, skipped: true, reason: 'systemctl-missing' }

  const install = resolveOpsCronScript('install', { scriptFile, env })
  if (!install) return { ok: false, skipped: true, reason: 'install-script-missing' }

  const unitName = opsCronUnitName(env)
  const minutes = String(env.HARNESS_OPS_CRON_MINUTES || '5').replace(/\D/g, '') || '5'
  const args = [install, '--repo', gitRoot, '--minutes', minutes, '--unit-name', unitName]
  if (!['0', 'false', 'off', 'no'].includes(String(env.HARNESS_OPS_CRON_NOTIFY ?? '1').toLowerCase())) {
    args.push('--notify')
  }
  if (!['0', 'false', 'off', 'no'].includes(String(env.HARNESS_OPS_CRON_INVOKE ?? '1').toLowerCase())) {
    args.push('--invoke-agent')
  }

  const result = spawnSync('bash', args, { encoding: 'utf8', env })
  const ok = result.status === 0
  if (ok && commonGit) {
    writeOpsCronMarker(commonGit, {
      schema: 'harness-ops-cron-armed.v1',
      at: new Date().toISOString(),
      repo: gitRoot,
      unitName,
      install,
    })
  }
  return {
    ok,
    skipped: false,
    reason: ok ? 'armed' : 'install-failed',
    unitName,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  }
}

/**
 * Disable the ops-cron timer. Best-effort; never throws.
 */
export function disableOpsCron({
  commonGit = null,
  scriptFile = null,
  env = process.env,
  spawnSync = defaultSpawnSync,
  unitName = null,
} = {}) {
  if (!opsCronEnabled(env)) return { ok: true, skipped: true, reason: 'disabled' }
  if (!systemctlAvailable(spawnSync)) return { ok: false, skipped: true, reason: 'systemctl-missing' }

  const marker = commonGit ? readOpsCronMarker(commonGit) : null
  const resolvedUnit = unitName || marker?.unitName || opsCronUnitName(env)
  const disable = resolveOpsCronScript('disable', { scriptFile, env })
  let result
  if (disable) {
    result = spawnSync('bash', [disable, '--unit-name', resolvedUnit], { encoding: 'utf8', env })
  } else {
    result = spawnSync('systemctl', ['--user', 'disable', '--now', `${resolvedUnit}.timer`], {
      encoding: 'utf8',
      env,
    })
  }
  if (commonGit) clearOpsCronMarker(commonGit)
  return {
    ok: result.status === 0 || result.status == null,
    skipped: false,
    reason: 'disarmed',
    unitName: resolvedUnit,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  }
}

/**
 * Disable only when the fleet snapshot shows no active workflow.
 */
export function maybeDisableOpsCron({
  fleet = null,
  commonGit = null,
  scriptFile = null,
  env = process.env,
  spawnSync = defaultSpawnSync,
} = {}) {
  if (!opsCronEnabled(env)) return { ok: true, skipped: true, reason: 'disabled' }
  if (!fleet || !Array.isArray(fleet.projects)) {
    return { ok: false, skipped: true, reason: 'missing-fleet' }
  }
  if (fleetWorkflowActive(fleet, fleet.projects)) {
    return { ok: true, skipped: true, reason: 'workflow-active' }
  }
  return disableOpsCron({ commonGit, scriptFile, env, spawnSync })
}
