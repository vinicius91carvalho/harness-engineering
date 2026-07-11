# Reject peer worker event buses

Workers (Code Agent, QA Agent, Initializer) never publish or subscribe to each other.
Transitions stay owned by the host-neutral Attempt machine (`orchestrator.mjs` / `attempt-machine.mjs`): Defect Reports, Repair Plans, Run State, and Evidence Artifacts are orchestrator-mediated handoffs, not peer chatter.
Control-plane events already live in the append-only Control Journal; zero-token Wake Triage may classify those events before a Control Host LLM turn, but that is not an agent-to-agent bus.
A peer bus would race the Execution Ledger, duplicate journal truth, and fight ADR-0006 / ADR-0007.
