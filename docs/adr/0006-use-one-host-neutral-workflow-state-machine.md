# Use one host-neutral workflow state machine

One host-neutral state machine owns scheduling, Claim Leases, Attempts, Run State, Workflow Journals, repair planning, integration, and completion checks. Claude, Codex, and OpenCode provide only thin adapters for launching their configured agents and returning structured results. This removes semantic drift while keeping model selection entirely host-controlled.
