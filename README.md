<p align="center">
  <img src="assets/banner.svg" alt="harness-engineering" width="660">
</p>

<p align="center">
  <a href="https://github.com/vinicius91carvalho/harness-engineering/releases/latest"><img alt="Version" src="https://img.shields.io/github/v/release/vinicius91carvalho/harness-engineering?sort=semver&label=version&color=2496ED"></a>
  <a href="https://github.com/vinicius91carvalho/harness-engineering"><img alt="AI Harness Engineering System" src="https://img.shields.io/badge/AI%20Harness%20Engineering-System-8A2BE2"></a>
  <a href="https://github.com/vinicius91carvalho/harness-engineering/releases"><img alt="Last update" src="https://img.shields.io/github/release-date/vinicius91carvalho/harness-engineering?label=last%20update&color=2EA44F"></a>
</p>

<p align="center"><b>A curated developer workflow for any AI harness.</b></p>

## About

> *"Not all those who wander are lost."*

`harness-engineering` is a plugin marketplace and a portable
**spec → build → QA → Goal Review** workflow for Claude Code, OpenCode, and
Codex. It keeps long-running AI work resumable, independently checked, and
grounded in durable files instead of chat history.

For a complete Hermes + Telegram + OpenCode walkthrough, use the
**[step-by-step setup guide](https://vinicius91carvalho.github.io/harness-engineering/)**.

### Why use this harness?

Typical agent workflows keep the plan in a conversation, let the implementing
agent judge its own work, and treat a completed task list as success. That works
for short changes, but becomes unreliable across long sessions, parallel workers,
retries, and context resets.

This harness makes different tradeoffs:

- **The goal is the authority.** A stable specification defines observable proof;
  queue state and agent confidence cannot declare success.
- **QA is independent.** The coding agent does not grade its own implementation.
- **Integration is tested.** Passing in an isolated worktree is not enough; the
  same checks run again after merging into the latest `main`.
- **Failures become repair plans.** QA records expected versus observed behavior,
  evidence, and affected checks before another bounded attempt begins.
- **State survives conversations.** Work, ownership, attempts, evidence, and next
  actions live in files that a new session can inspect and resume.
- **Parallelism has boundaries.** Independent contexts can run concurrently while
  claims, dependencies, resource limits, and serialized merges prevent collisions.
- **Hosts remain replaceable.** Claude Code, OpenCode, and Codex use the same
  workflow state machine and keep their configured model.

## Install

Install one supported CLI first, then run:

```sh
curl -sSL https://raw.githubusercontent.com/vinicius91carvalho/harness-engineering/main/install.sh | sh
```

The installer detects available hosts and lets you choose the harness, optional
plugins, MCP servers, shared configuration, and status line. Repeated runs are
safe.

For non-interactive OpenCode setup:

```sh
curl -sSL https://raw.githubusercontent.com/vinicius91carvalho/harness-engineering/main/install.sh \
  | sh -s -- --cli opencode --no
```

Native Windows users can run [`install.ps1`](install.ps1). See the
[installer reference](docs/installer/README.md) for all flags.

## Framework

The harness has four user-facing skills:

| Skill | Purpose |
| --- | --- |
| `/harness:planner` | Turn an idea into `project_specs.xml` with stable Acceptance Checks. |
| `/harness:generator` | Build, independently test, integrate, retry, and resume the work. |
| `/harness:evaluator` | Run the final Goal Review against integrated `main`. |
| `/harness:control-host` | Let Hermes, nanobot, or pi supervise long-running workers and notifications. |

```text
idea → project_specs.xml → feature_list.json → coding → QA → integration → Goal Review
                                      ↑          │
                                      └── repair ┘
```

### How the workflow runs

1. **Plan:** the planner turns the idea into one Project Goal and stable,
   dependency-aware Acceptance Checks in `project_specs.xml`.
2. **Reconcile:** the generator maps every check into an append-only Work Item in
   `feature_list.json`. Missing mappings and invalid dependencies block execution.
3. **Claim:** each generator session atomically claims one ready context and gets
   its own branch, worktree, port, and Run State.
4. **Build and inspect:** the coding agent implements a Work Item. A separate QA
   agent verifies the mapped checks through a browser or real HTTP boundary.
5. **Repair when needed:** a defect produces evidence and a Repair Plan. The
   workflow allows at most three coding → QA → integration attempts before asking
   the user for guidance.
6. **Integrate:** passing work merges into the latest `main`, then QA reruns the
   checks against the combined product.
7. **Review the goal:** after every Work Item integrates, an independent Goal
   Review exercises the whole specification. Only persisted `goal:true` means done.

Multiple generator sessions may process different ready contexts concurrently.
If a session closes, running the generator again resumes durable state instead of
starting the project over.

### `project_specs.xml`: the completion contract

The specification captures the product goal, technical direction, feature areas,
and observable proof. Acceptance Check IDs are stable and append-only because the
queue, QA evidence, dependencies, and repairs refer back to them.

```xml
<project_specification>
  <project_name>Notes</project_name>
  <project_goal>
    A visitor can publish a note and find it again after reloading.
  </project_goal>

  <core_features>
    <notes>
      - Create and persist a note
      - List saved notes after reload
    </notes>
  </core_features>

  <acceptance_checks>
    <acceptance_check
      id="AC-001"
      context="notes"
      category="functional"
      depends_on="">
      <description>
        Publish a note, reload the page, and observe the same title and text.
      </description>
    </acceptance_check>
  </acceptance_checks>
</project_specification>
```

The important fields are:

| Field | Meaning |
| --- | --- |
| `id` | Permanent identity used by work, evidence, and repairs. |
| `context` | Collision boundary: checks likely to touch the same area run together. |
| `category` | `foundation`, `functional`, or `style`. |
| `depends_on` | Check IDs that must integrate before this check becomes ready. |
| `description` | An action and result that QA can observe, not an implementation claim. |

### `feature_list.json`: the execution queue

The generator derives Work Items from the specification. This file records
progress; it does not redefine success.

```json
[
  {
    "id": "WI-AC-001",
    "context": "notes",
    "description": "A published note survives reload",
    "acceptance_checks": ["AC-001"],
    "depends_on": [],
    "implementation": false,
    "qa": false,
    "integration": false,
    "retries": 0
  }
]
```

The three proof flags deliberately mean different things:

| Flag | Evidence |
| --- | --- |
| `implementation` | The coding agent completed the change and produced a commit. |
| `qa` | Independent QA observed the behavior in the isolated worktree. |
| `integration` | The behavior still passed after merging into current `main`. |

Only `integration:true` satisfies dependencies. Even when every item is integrated,
the complete Project Goal still requires Goal Review.

### Durable state and evidence

The workflow stores its state in:

| Path | Purpose |
| --- | --- |
| `project_specs.xml` | Goal and stable Acceptance Checks. |
| `feature_list.json` | Dependency-aware execution queue. |
| `harness-progress/` | Human-readable workflow journals. |
| `.git/harness-runs/` | Worker state, attempts, and evidence. |
| `.git/harness-control/` | Supervisor state and notification events. |

## Learning loop

`/harness:learning-loop` reviews a completed session and suggests durable skills,
rules, agents, or memory only when a useful pattern is likely to recur.

## Documentation

| Guide | Contents |
| --- | --- |
| [End-to-end setup](https://vinicius91carvalho.github.io/harness-engineering/) | Hermes, Telegram, OpenCode, commands, generated files, and verification. |
| [Plugins](docs/plugins.md) | Available integrations and host compatibility. |
| [Extras](docs/extras.md) | Status line, shared config, and MCP servers. |
| [Installer](docs/installer/README.md) | Host selection, flags, scopes, and dry runs. |
| [Backup](docs/backup-sync.md) | Portable configuration backup and restore. |
| [Architecture decisions](docs/adr/) | Why the workflow uses durable goals, independent QA, and governed workers. |

## Releases

Releases are generated from Conventional Commit subjects pushed to `main`.
See the [release history](https://github.com/vinicius91carvalho/harness-engineering/releases).

Feedback and contributions are welcome through
[issues](https://github.com/vinicius91carvalho/harness-engineering/issues) and pull requests.
