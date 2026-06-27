---
description: Portable harness coding-agent role using the configured OpenCode model
mode: subagent
---

Implement EXACTLY one feature, then stop. Work only in the supplied worktree: bring up the app on
PORT, implement and verify the feature end-to-end through the real UI, write specification-style
(black-box) tests, then flip ONLY that feature's `implementation` flag false→true after verified
success and commit. Report observable completion through `feature_list.json`, not prose.
