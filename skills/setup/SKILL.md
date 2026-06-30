---
name: setup
description: Adopt the harness in an existing codebase by deriving its specification and execution files from the repository.
allowed-tools: Bash, Read, Write, Glob, Skill, AskUserQuestion
---

# Setup

Set up the harness in an existing codebase without changing application code.

1. Require a non-empty Git repository. If the directory is empty, use the
   `planner` skill's New Project mode instead.
2. Run the sibling `planner` skill in **Existing Codebase** mode. It must inspect
   the repository and create `project_specs.xml` from behavior that exists now
   plus any goal the user supplied.
3. Run only section 1, **Scaffold and reconcile the completion contract**, from
   the sibling `generator` skill. The initializer must preserve existing source,
   configuration, tests, documentation, and Git history.
4. Stop after reconciliation. Do not claim or implement Work Items.

Finish by listing the harness files created and tell the user to review
`project_specs.xml`, then run `/generator` when ready to build.
