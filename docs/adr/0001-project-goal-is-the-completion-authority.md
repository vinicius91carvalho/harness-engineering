# Project Goal is the completion authority

`project_specs.xml` owns the Project Goal and planner-authored, stable Acceptance Checks.
`feature_list.json` is a reconciled Work Item catalog rather than the source of truth for completion.
Mutable execution progress lives in the Execution Ledger.
Validation rejects unmapped checks, and the workflow finishes only after every check passes on the integrated Plan integration branch and mandatory Goal Review confirms the goal.
This prevents requirements from disappearing during queue generation or an incomplete queue declaring success merely because all of its flags are true.
