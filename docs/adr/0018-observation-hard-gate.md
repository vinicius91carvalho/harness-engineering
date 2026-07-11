# Observation Hard Gate at validation spawn

Validation and Goal Review host selection must match the Work Item's Observation Methods.
When `http` or `browser` is required and no eligible strong host remains in the candidate pool, the Supervisor raises a durable Input Request (fail closed) instead of admitting a weak host or waiting silently.
Coding keeps the full host pool and only soft-aligns its prompt to the Work Item's methods — a separate Observation Hard Gate on coding would starve the Attempt loop without improving QA independence.
Do not invent a pre black-box contract phase; contracts already live in Acceptance Checks projected into the catalog.
