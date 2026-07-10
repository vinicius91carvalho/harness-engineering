# Integrate and verify each Work Item

Each Work Item becomes a Checkpoint after isolated QA passes, then integrates with the latest Plan integration branch instead of waiting for its entire context.
Its mapped Acceptance Checks are marked passed only after Integrated Verification on that plan branch.
An integration defect returns the Work Item to the Defect Report and Repair Plan loop.
This adds merge coordination per Work Item but prevents a late blocked item from stranding a large context and exposes cross-context regressions earlier.
While a plan is in flight, Work Items never merge into `main`/`master`.
