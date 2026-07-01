---
name: setup
description: Adopt harness-engineering in one existing project.
---

Inspect the project, then invoke the installed harness setup workflow. Preserve
application files and stop after the specification and execution files exist.
Setup takes no goal, feature, or scope argument; derive its scope from the
repository and reject invocation text that tries to narrow or redefine it.
Do not start or recommend validation of all mapped features. Offer a scoped or
full generator audit only when the user asks for one.
Offer `roles.example.json` as an optional `.harness/roles.json`; let the user
change or remove model IDs before execution.
