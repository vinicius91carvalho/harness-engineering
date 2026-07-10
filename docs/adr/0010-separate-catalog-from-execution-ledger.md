# Separate Work Item catalog from Execution Ledger

`feature_list.json` is the immutable Work Item catalog projected from Acceptance Checks.
Mutable progress (implementation, QA, integration, Attempt counters, Blocking Scope) lives in an Execution Ledger under the shared Git directory.
Workers return verdicts and Evidence Artifacts; only the deterministic workflow transition module writes the ledger and Workflow Journal.
This prevents agent-side flag races and keeps the catalog mergeable as product-neutral metadata.
