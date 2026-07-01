---
name: setup
description: Adopt the harness in an existing codebase by deriving its specification and execution files from the repository.
allowed-tools: Bash, Read, Write, Glob, Skill, AskUserQuestion
---

# Setup

Set up the harness in an existing codebase without changing application code.

## Resolve monorepo projects first

Treat the Git top-level and the harness project root as separate directories. At
the Git top-level, detect project boundaries from workspace manifests, nested
package/build manifests, Compose services, deployment units, and architecture
docs. Do not treat dependency packages as projects unless they have an independently
runnable or deployable product boundary.

When more than one project exists, create or update `.harness/projects.json` at
the Git top-level:

```json
{"projects":[{"id":"frontend","path":"apps/frontend","description":"Customer web application"}]}
```

Paths are Git-root-relative directories; IDs are stable and unique. Preserve
existing entries and descriptions. Explain the discovered projects, then ask
which project(s) to set up. Run every remaining step separately with each selected
project directory as `PROJECT`. At the Git root, never create an aggregate
`project_specs.xml` or `feature_list.json`; the registry is routing metadata, not
a completion contract. If only one runnable project exists, use the repository
root as `PROJECT` and do not create the registry.

1. Require a non-empty Git repository. If `PROJECT` is empty, use the
   `planner` skill's New Project mode instead.
2. Before planning, inspect all authoritative product sources: product documentation
   (for example `docs/product/**`), the root README, architecture/domain docs, manifests and installed dependencies,
   environment examples and runtime configuration, Compose/IaC, API routes, and
   integration adapters relevant to `PROJECT`, including shared monorepo dependencies.
   Build `PROJECT/.harness-technology-inventory.json` before writing
   the spec. Each material technology names its target section (`technology_stack`,
   `integrations`, or `prerequisites`) and one or more evidence objects containing a
   repository-relative `path` and `kind` (`documentation`, `manifest`,
   `configuration`, `adapter`, or `iac`). Do not use a fixed technology catalog:
   derive names from this repository. Validate the inventory with
   `node <this-skill>/inventory.mjs "$PROJECT" .harness-technology-inventory.json --inventory-only`.
3. Run the sibling `planner` in **Existing Codebase** mode. Cover runtime,
   frameworks, persistence, queues/cache; auth/billing; AI, agents, memory and LLM
   observability; cloud/deployment/security/operations; inbound alerts and outbound
   communications; code/docs/work/customer-network integrations; tests and local
   substitutes. For every integration, record in `<integrations>`:
   - exact responsibility and required/optional/feature-flagged status;
   - credentials/configuration, security mechanism, and tenant boundary;
   - unavailable behavior, production deployment, and local/test replacement;
   - affected APIs, modules, and user flows when relevant.
   Cross-check docs against code/configuration. Prefer current implementation when
   docs are stale, but record every contradiction explicitly in the spec; never
   silently resolve one.
4. Before initialization, run
   `node <this-skill>/inventory.mjs "$PROJECT" .harness-technology-inventory.json project_specs.xml`.
   It verifies every evidence-backed technology appears in its intended spec section
   and fails with a concise missing-technology report. Fix the spec and repeat until
   it passes.
5. Run only section 1, **Scaffold and reconcile the completion contract**, from
   the sibling `generator` skill. The initializer must preserve existing source,
   configuration, tests, documentation, and Git history.
6. Stop after reconciliation. Do not claim or implement Work Items. Create or
   reconcile only harness files (including the inventory); retain stable Acceptance Check IDs and preserve
   unrelated worktree changes.

The planner writes `<mode>existing-codebase</mode>` into `project_specs.xml`
during step 3. The generator honors it as **verify-first**: coding agents first
exercise the Acceptance Checks against the existing code at a real boundary, set
`implementation=true` with no code changes when they pass, and only repair the
root cause when a check fails. This makes `/generator` a safe audit pass over a
working codebase rather than a rewrite.

Finish by listing the harness files created and tell the user to review
each project-local `project_specs.xml`, then run `/generator` from that project
directory when ready to build. At the Git root, print the registry as a routing
table with project ID, path, and the command directory.
