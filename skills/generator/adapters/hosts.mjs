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
      // Lean MCP profile: trust workspace, disable sandbox, do not --approve-mcps
      // (avoids Playwright/Crawl4AI warmup silence on generator panes).
      const base = ['-p', '--force', '--trust', '--sandbox', 'disabled']
      return model
        ? ['agent', [...base, '--model', model, prompt]]
        : ['agent', [...base, prompt]]
    }
    default:
      throw new Error(`unknown harness: ${harness}`)
  }
}
