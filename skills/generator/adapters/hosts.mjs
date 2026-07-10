import { parseObject } from '../lib/verdict.mjs'
import { spawnHostAgent, hostSpawnVisible, terminateHostProcess } from '../lib/agent-spawn.mjs'
import { createAgentStreamFormatter, withVisibleAgentMode } from '../lib/agent-stream.mjs'

export const hostCommands = {
  claude: (prompt) => ['claude', ['-p', prompt]],
  codex: (prompt) => ['codex', ['exec', '--dangerously-bypass-approvals-and-sandbox', prompt]],
  opencode: (prompt) => ['opencode', ['run', '--model', 'opencode-go/deepseek-v4-flash', prompt]],
  pi: (prompt) => ['pi', ['--model', 'opencode-go/deepseek-v4-flash', '-p', prompt]],
  // Lean MCP: --trust without --approve-mcps so disabled Playwright/Crawl4AI
  // are not auto-approved and do not block first-token streaming on herdr panes.
  agent: (prompt) => ['agent', ['-p', '--force', '--trust', '--sandbox', 'disabled', prompt]],
}

export const roleNames = {
  CODING: 'coding',
  QA: 'validation',
  INTEGRATION_QA: 'validation',
  REPAIR_PLAN: 'repairPlanning',
  MERGE: 'coding',
  GOAL_REVIEW: 'goalReview',
}

/** Build a host CLI invocation for `.harness/roles.json` routing with an optional model override. */
export function buildHostCommand(harness, prompt, model) {
  switch (harness) {
    case 'claude':
      return model ? ['claude', ['-p', '--model', model, prompt]] : hostCommands.claude(prompt)
    case 'codex':
      return model
        ? ['codex', ['exec', '--model', model, '--dangerously-bypass-approvals-and-sandbox', prompt]]
        : hostCommands.codex(prompt)
    case 'opencode':
      return ['opencode', ['run', ...(model ? ['--model', model] : []), prompt]]
    case 'pi':
      return ['pi', [...(model ? ['--model', model] : []), '-p', prompt]]
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

/**
 * Spawn a host CLI, stream pane output, and terminate early when a harness verdict arrives.
 * Returns { ok, code, detail, stdout, stderr, parsed, timedOut, childRef }.
 */
export async function runHostAgentSession({
  program,
  args,
  cwd,
  env = {},
  visible = hostSpawnVisible(),
  timeoutMs = Number(process.env.HARNESS_AGENT_TIMEOUT_MS || 1_800_000),
  heartbeatMs = Number(process.env.HARNESS_PANE_HEARTBEAT_MS || 20_000),
  onChildPid = null,
  onAgentOutput = null,
  writePane = null,
  writeErr = null,
} = {}) {
  const spawnArgs = withVisibleAgentMode(program, args, visible)
  const formatter = visible ? createAgentStreamFormatter() : null
  const paneOut = writePane || ((chunk) => { process.stdout.write(chunk) })
  const paneErr = writeErr || ((chunk) => { process.stderr.write(chunk) })

  return await new Promise((resolveRun) => {
    let child = spawnHostAgent(program, spawnArgs, { cwd, env, visible })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let lastPaneAt = Date.now()
    let verdictSeen = false
    let sawAgentStream = false
    let paneHeartbeat = null

    const terminate = (signal = 'SIGTERM') => {
      terminateHostProcess(child, signal)
    }

    const finish = (result) => {
      if (settled) return
      settled = true
      if (paneHeartbeat) clearInterval(paneHeartbeat)
      child = null
      resolveRun(result)
    }

    const notePaneActivity = (fromAgent = false) => {
      lastPaneAt = Date.now()
      if (fromAgent && onAgentOutput) onAgentOutput()
      if (fromAgent) sawAgentStream = true
    }

    if (visible && heartbeatMs > 0) {
      paneOut(`agent: started (${program}${spawnArgs.includes('--model') ? ` ${spawnArgs[spawnArgs.indexOf('--model') + 1] || ''}` : ''})\n`)
      paneOut('agent: waiting for first token (MCP/plugin warmup can take ~30–90s before thinking/tools appear)…\n')
      notePaneActivity(false)
      paneHeartbeat = setInterval(() => {
        if (settled) return
        const quietSec = Math.round((Date.now() - lastPaneAt) / 1000)
        if (quietSec < Math.max(15, heartbeatMs / 1000 - 1)) return
        let phase
        if (verdictSeen) phase = 'verdict received — waiting for agent exit'
        else if (!sawAgentStream) phase = 'still waiting for first token / MCP warmup'
        else phase = 'still working'
        paneOut(`agent: ${phase} (${quietSec}s since last log)\n`)
        notePaneActivity(false)
      }, heartbeatMs)
    }

    if (onChildPid) onChildPid(child)

    const maybeEarlyExitOnVerdict = () => {
      if (verdictSeen || settled) return
      const assistant = formatter?.assistantText() || ''
      const parsed = parseObject(assistant)
      if (!parsed || typeof parsed !== 'object' || !parsed.id) return
      verdictSeen = true
      if (visible) {
        paneOut(`agent: harness verdict received (id=${parsed.id}) — stopping agent\n`)
        notePaneActivity(false)
      }
      setTimeout(() => { if (!settled) terminate('SIGTERM') }, 500)
      setTimeout(() => { if (!settled) terminate('SIGKILL') }, 4_000)
    }

    child.stdout?.on('data', (data) => {
      stdout = `${stdout}${data}`.slice(-1_000_000)
      if (visible) {
        const text = String(data)
        if (/^BUSY\n?$/.test(text.trim())) return
        const paneText = formatter ? formatter.push(text) : text
        if (paneText) {
          paneOut(paneText)
          notePaneActivity(true)
        }
      }
      maybeEarlyExitOnVerdict()
    })

    child.stderr?.on('data', (data) => {
      stderr = `${stderr}${data}`.slice(-1_000_000)
      if (visible) {
        paneErr(data)
        notePaneActivity(true)
      }
      maybeEarlyExitOnVerdict()
    })

    const timeout = setTimeout(() => { timedOut = true; terminate() }, timeoutMs)

    child.on('close', async (code) => {
      clearTimeout(timeout)
      if (formatter) {
        const rest = formatter.flush()
        if (rest) paneOut(rest)
      }
      const assistant = formatter?.assistantText()?.trim() || ''
      const detail = (stderr || assistant || stdout || '').trim()
      const parseSource = assistant || stdout || stderr
      const parsed = parseObject(parseSource)
      const ok = (!timedOut && (code === 0 || (verdictSeen && parsed)))
      finish({
        ok,
        code,
        detail,
        stdout: assistant || stdout,
        stderr,
        parsed,
        timedOut,
      })
    })

    child.on('error', (error) => {
      clearTimeout(timeout)
      if (formatter) formatter.flush()
      finish({ ok: false, detail: error.message, stdout, stderr, parsed: null, timedOut: false })
    })
  })
}

export { terminateHostProcess, hostSpawnVisible, spawnHostAgent }
