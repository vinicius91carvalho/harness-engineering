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

For a complete Omnigent + Tailscale + OpenCode walkthrough, use the
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
Omnigent control surface, plugins, MCP servers, shared configuration, and status
line. Repeated runs refresh installed plugins safely. Choosing `omnigent` uses
its official runtime installer when needed and refreshes the bundle at
`~/.omnigent/agents/harness-engineering`.

For the tested Omnigent workflow, authenticate OpenCode and Codex first. Keep
`harness` checked in the installer, toggle `omnigent`, then confirm once.

For non-interactive OpenCode setup:

```sh
curl -sSL https://raw.githubusercontent.com/vinicius91carvalho/harness-engineering/main/install.sh \
  | sh -s -- --cli opencode --no
```

Native Windows users can run [`install.ps1`](install.ps1). See the
[installer reference](docs/installer/README.md) for all flags.

## Framework

The harness has five user-facing skills:

| Skill | Purpose |
| --- | --- |
| `/harness:setup` | Adopt the harness in an existing codebase without changing application code. |
| `/harness:planner` | Turn an idea into `project_specs.xml` with stable Acceptance Checks. |
| `/harness:generator` | Build, independently test, integrate, retry, and resume the work. |
| `/harness:evaluator` | Run the final Goal Review against integrated `main`. |
| `/harness:control-host` | Run the native detached supervisor and durable notification interface. |

```text
idea → project_specs.xml → feature_list.json → coding → QA → integration → Goal Review
                                      ↑          │
                                      └── repair ┘
```

For an existing repository, run `/harness:setup [your goal]`. It inspects the
product docs, manifests, runtime configuration, integrations, and infrastructure;
builds a technology inventory; and refuses initialization if a discovered material
technology is missing from `project_specs.xml`. Each integration records its role,
configuration, security/tenant boundary, failure behavior, deployment, and local
substitute. Documentation/code contradictions are reported explicitly. Setup then
uses the planner to create `project_specs.xml`, and uses only
the generator's initialization stage to create `feature_list.json`, `init.sh`,
and any missing setup files. It preserves existing application files and stops before
claiming or implementing work; review the spec, then run `/harness:generator`.

### Monorepos

Setup detects independently runnable or deployable projects from workspace
manifests, nested manifests, Compose/deployment configuration, and architecture
docs. With multiple projects it writes a routing registry at the Git root:

```json
{
  "projects": [
    {"id": "frontend", "path": "apps/frontend", "description": "Customer web application"},
    {"id": "backend", "path": "services/backend", "description": "HTTP API and persistence"}
  ]
}
```

Each registered directory owns its own `project_specs.xml`, technology inventory,
`feature_list.json`, and workflow journals. Run planner, generator, evaluator, or
the control host from that directory. When invoked at the Git root, skills use
`.harness/projects.json` to list and select the owning project; they do not create
an aggregate specification or queue.

Git coordination remains repository-wide, while claims, branches, worktree paths,
Run State, supervisor state, and Goal Review are project-namespaced. Therefore two
projects may both have a `core` context without colliding. A project specification
may require edits to shared packages or sibling services, but cross-project queue
dependencies are intentionally unsupported: one project must own the observable
Acceptance Check.

Given this repository:

```text
acme/
├── apps/web/
├── services/api/
└── packages/shared/
```

set it up once from the Git root:

```sh
cd acme
/harness:setup Add customer account management
```

Setup identifies `apps/web` and `services/api` as runnable projects, records them
in `.harness/projects.json`, and asks which ones to initialize. `packages/shared`
remains shared code unless it is independently runnable or deployable. Review the
generated files before coding:

```text
acme/
├── .harness/projects.json
├── apps/web/project_specs.xml
├── apps/web/feature_list.json
├── services/api/project_specs.xml
└── services/api/feature_list.json
```

Run work from the project that owns the user-visible outcome:

```sh
cd apps/web
/harness:generator

cd ../../services/api
/harness:generator
```

The worker may edit shared packages or sibling services when its specification
requires that change. For a feature spanning frontend and backend, put the
end-to-end Acceptance Check in one owning project—normally the user-facing
frontend—and describe the required API behavior there. Give the backend a separate
specification only when it has an independently releasable goal. To operate a
project through the long-running control host, pass that project directory:

```sh
CONTROL=~/.config/opencode/skills/harness-control-host/scripts/harness-control.mjs
node "$CONTROL" start --repo /work/acme/services/api --host opencode
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
   checks against the combined product. Only actual unmerged paths invoke the
   conflict resolver; other merge failures remain operational errors.
7. **Review the goal:** after every Work Item integrates, an independent Goal
   Review exercises the whole specification. Completion requires a complete Goal
   Review Run State and a persisted `run_completed` control event.

The orchestrator persists successful structured coding, QA, and integrated-QA
results into `feature_list.json`; workers do not need to duplicate those flag
writes for the workflow to advance.

For a nested registered project, Goal Review requires that project path to be
clean but ignores unrelated monorepo changes outside it.

Multiple generator sessions may process different ready contexts concurrently.
If a session closes, running the generator again resumes durable state instead of
starting the project over.

### Optional Omnigent routing and mobile control

Omnigent is an optional control screen and worker router. Without it, Claude
Code, Codex, and OpenCode still run the same workflow directly.

Use this small role file when OpenCode should write code and Codex should do the
independent checks:

```json
{
  "coding": [{"harness": "opencode"}],
  "validation": [{"harness": "codex"}],
  "repairPlanning": [{"harness": "codex"}],
  "goalReview": [{"harness": "codex"}]
}
```

Save it as `.harness/roles.json` in the project. You may instead copy and edit
the larger installed example:

```sh
mkdir -p .harness
cp ~/.omnigent/agents/harness-engineering/roles.example.json .harness/roles.json
```

Start Omnigent from the Git root. For a monorepo, name the registered project
directory in the request:

```sh
cd /path/to/git-root
omni run ~/.omnigent/agents/harness-engineering --harness codex
```

Then send one plain request:

```text
Act as the Control Host for /absolute/path/to/project.
Start or resume the harness. Use the project role file.
Continue until input is needed or a persisted run_completed event exists.
```

Omnigent starts the repository's detached supervisor; it does not replace the
scheduler. The controller and Codex wrapper must be able to launch local tools
and write Git worktree metadata, so their outer Omnigent OS sandbox is disabled.
The normal host permissions still apply.

Check the run with the installed OpenCode control script:

```sh
CONTROL=~/.config/opencode/skills/harness-control-host/scripts/harness-control.mjs
PROJECT=/absolute/path/to/project
node "$CONTROL" status --repo "$PROJECT"
node "$CONTROL" events --repo "$PROJECT" --consumer manual-check
jq 'all(.[]; .implementation and .qa and .integration)' "$PROJECT/feature_list.json"
```

Success is simple:

- `status` is `complete` and `supervisorPid` is `null`.
- Every item has `implementation`, `qa`, and `integration` set to `true`.
- The Goal Review Run State has `status: complete` and `phase: complete`.
- The event list contains `kind: run_completed`.

Do not use an empty queue or an agent's message as proof of completion.

For private phone access, run Omnigent locally and expose only to your tailnet:

```sh
OMNIGENT_WS_ALLOWED_ORIGINS=https://YOUR-MACHINE.ts.net \
OMNIGENT_ACCOUNTS_BASE_URL=https://YOUR-MACHINE.ts.net \
  omni server start
tailscale serve https / http://localhost:8000
omni host
```

Open `https://YOUR-MACHINE.ts.net` on a phone signed into the same tailnet.
Tailscale remains user-managed, and the machine must stay awake. Use a hosted
Omnigent server only when the control surface must survive the local machine.

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
| `.harness/roles.json` | Optional Omnigent role/model candidates; absent means direct host execution. |
| `.harness-technology-inventory.json` | Setup evidence for material technologies and documentation/code contradictions. |
| `feature_list.json` | Dependency-aware execution queue. |
| `harness-progress/` | Human-readable workflow journals. |
| `.git/harness-runs/` | Project-namespaced worker state, attempts, and evidence. |
| `.git/harness-control/` | Project-namespaced supervisor state and notification events. |

Stopping a worker terminates its complete host-adapter process group so native
and Omnigent harness servers are not left running after interruption.

## Learning loop

`/harness:learning-loop` reviews a completed session and suggests durable skills,
rules, agents, or memory only when a useful pattern is likely to recur.

## Documentation

| Guide | Contents |
| --- | --- |
| [End-to-end setup](https://vinicius91carvalho.github.io/harness-engineering/) | Omnigent, private mobile access, role routing, generated files, and verification. |
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
