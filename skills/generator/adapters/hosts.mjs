import { hasCompleteVerdict, parseVerdict } from '../lib/worker-outcome.mjs'
import { spawnHostAgent, terminateHostProcess } from '../lib/worker-lifecycle.mjs'

/** Default models for hosts that require one when roles.json omits model. */
const DEFAULT_HOST_MODELS = {
  opencode: 'opencode-go/deepseek-v4-flash',
  pi: 'opencode-go/deepseek-v4-flash',
}

/** Build a host CLI invocation for `.harness/roles.json` routing with an optional model override. */
export function buildHostCommand(harness, prompt, model) {
  switch (harness) {
    case 'claude':
      return model ? ['claude', ['-p', '--model', model, prompt]] : ['claude', ['-p', prompt]]
    case 'codex':
      return model
        ? ['codex', ['exec', '--model', model, '--dangerously-bypass-approvals-and-sandbox', prompt]]
        : ['codex', ['exec', '--dangerously-bypass-approvals-and-sandbox', prompt]]
    case 'opencode': {
      const resolved = model || DEFAULT_HOST_MODELS.opencode
      return ['opencode', ['run', '--model', resolved, prompt]]
    }
    case 'pi': {
      const resolved = model || DEFAULT_HOST_MODELS.pi
      return ['pi', ['--model', resolved, '-p', prompt]]
    }
    case 'agent': {
      const base = ['-p', '--force', '--trust', '--sandbox', 'disabled']
      return model
        ? ['agent', [...base, '--model', model, prompt]]
        : ['agent', [...base, prompt]]
    }
    default:
      throw new Error(`unknown harness: ${harness}`)
  }
}

/** Direct-host shortcuts; same default model policy as `buildHostCommand`. */
export const hostCommands = {
  claude: (prompt) => buildHostCommand('claude', prompt),
  codex: (prompt) => buildHostCommand('codex', prompt),
  opencode: (prompt) => buildHostCommand('opencode', prompt),
  pi: (prompt) => buildHostCommand('pi', prompt),
  agent: (prompt) => buildHostCommand('agent', prompt),
}

export const roleNames = {
  CODING: 'coding',
  QA: 'validation',
  INTEGRATION_QA: 'validation',
  REPAIR_PLAN: 'repairPlanning',
  MERGE: 'coding',
  GOAL_REVIEW: 'goalReview',
}

/**
 * Spawn a host CLI, capture output, and terminate early when a harness verdict arrives.
 * Returns { ok, code, detail, stdout, stderr, parsed, timedOut }.
 */
export async function runHostAgentSession({
  program,
  args,
  cwd,
  env = {},
  timeoutMs = Number(process.env.HARNESS_AGENT_TIMEOUT_MS || 1_800_000),
  onChildPid = null,
  onAgentOutput = null,
} = {}) {
  return await new Promise((resolveRun) => {
    let child = spawnHostAgent(program, args, { cwd, env })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let verdictSeen = false
    let parsedVerdict = null

    const terminate = (signal = 'SIGTERM') => {
      terminateHostProcess(child, signal)
    }

    const finish = (result) => {
      if (settled) return
      settled = true
      child = null
      resolveRun(result)
    }

    if (onChildPid) onChildPid(child)

    const maybeEarlyExitOnVerdict = () => {
      if (verdictSeen || settled) return
      if (!hasCompleteVerdict(stdout)) return
      const parsed = parseVerdict(stdout)
      if (!parsed || typeof parsed !== 'object' || !parsed.id) return
      verdictSeen = true
      parsedVerdict = parsed
      setTimeout(() => { if (!settled) terminate('SIGTERM') }, 500)
      setTimeout(() => { if (!settled) terminate('SIGKILL') }, 4_000)
    }

    child.stdout?.on('data', (data) => {
      stdout = `${stdout}${data}`.slice(-1_000_000)
      if (onAgentOutput) onAgentOutput(data, 'stdout')
      maybeEarlyExitOnVerdict()
    })

    child.stderr?.on('data', (data) => {
      stderr = `${stderr}${data}`.slice(-1_000_000)
      if (onAgentOutput) onAgentOutput(data, 'stderr')
      maybeEarlyExitOnVerdict()
    })

    const timeout = setTimeout(() => { timedOut = true; terminate() }, timeoutMs)

    child.on('close', async (code) => {
      clearTimeout(timeout)
      const detail = (stderr || stdout || '').trim()
      const parseSource = stdout || stderr
      const parsed = parsedVerdict || parseVerdict(parseSource)
      const ok = (!timedOut && (code === 0 || (verdictSeen && parsed)))
      finish({
        ok,
        code,
        detail,
        stdout,
        stderr,
        parsed,
        timedOut,
      })
    })

    child.on('error', (error) => {
      clearTimeout(timeout)
      finish({ ok: false, detail: error.message, stdout, stderr, parsed: null, timedOut: false })
    })
  })
}

export { terminateHostProcess, spawnHostAgent }
