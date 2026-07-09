export const hostCommands = {
  claude: (prompt) => ['claude', ['-p', prompt]],
  codex: (prompt) => ['codex', ['exec', '--dangerously-bypass-approvals-and-sandbox', prompt]],
  opencode: (prompt) => ['opencode', ['run', '--model', 'opencode-go/deepseek-v4-flash', prompt]],
  pi: (prompt) => ['pi', ['--model', 'opencode-go/deepseek-v4-flash', '-p', prompt]],
  agent: (prompt) => ['agent', ['-p', '--force', '--trust', prompt]],
}

export const roleNames = {
  CODING: 'coding',
  QA: 'validation',
  INTEGRATION_QA: 'validation',
  REPAIR_PLAN: 'repairPlanning',
  MERGE: 'coding',
  GOAL_REVIEW: 'goalReview',
}
