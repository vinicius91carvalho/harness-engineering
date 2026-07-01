<p align="center">
  <img src="assets/banner.svg" alt="harness-engineering" width="660">
</p>

<p align="center">
  <a href="https://github.com/vinicius91carvalho/harness-engineering/releases/latest"><img alt="Version" src="https://img.shields.io/github/v/release/vinicius91carvalho/harness-engineering?sort=semver&label=version&color=2496ED"></a>
  <a href="https://github.com/vinicius91carvalho/harness-engineering"><img alt="AI Harness Engineering System" src="https://img.shields.io/badge/AI%20Harness%20Engineering-System-8A2BE2"></a>
  <a href="https://github.com/vinicius91carvalho/harness-engineering/releases"><img alt="Last update" src="https://img.shields.io/github/release-date/vinicius91carvalho/harness-engineering?label=last%20update&color=2EA44F"></a>
</p>

<p align="center"><b>A durable spec → build → QA workflow for AI coding tools.</b></p>

## About

`harness-engineering` is a plugin marketplace and a complete software-delivery
workflow. It turns a project goal into stable Acceptance Checks, bounded work,
independent QA, integrated verification, and a final Goal Review. Its state lives
in repository and Git files, so work can survive retries, parallel workers, tool
changes, and lost conversations.

[Claude Code](https://code.claude.com/docs/en/overview),
[Codex](https://developers.openai.com/codex/), and
[OpenCode](https://opencode.ai/) are tools that can run the harness.
[Omnigent](https://omnigent.ai/) is another optional tool: it provides a control
surface and routes work between those coding tools. None of them replaces the
harness workflow.

### Why use it?

- **The specification decides completion.** Agent confidence and an empty task
  list are not proof.
- **Coding and QA are separate.** The implementation tool does not approve its
  own work when another tool is available.
- **Integration is verified.** Checks run in the worker branch and again after
  merging into current `main`.
- **Failures are actionable.** Evidence and a Repair Plan are recorded before a
  bounded retry.
- **State is durable.** Claims, attempts, evidence, and pending input survive
  sessions and context resets.
- **Parallel work is governed.** Dependencies, leases, resource limits, and
  serialized merges prevent workers from colliding.
- **Tools are replaceable.** The same workflow runs through Claude Code, Codex,
  OpenCode, or optional Omnigent routing.

## Framework

The harness exposes workflow and support commands:

| Command | Purpose |
| --- | --- |
| `/harness:setup` | Map an existing codebase and create its harness files. Takes no arguments. |
| `/harness:planner` | Turn a new product idea into `project_specs.xml`. |
| `/harness:generator` | Reconcile, build, independently test, integrate, retry, and resume work. |
| `/harness:evaluator` | Run an independent Goal Review against integrated `main`. |
| `/harness:control-host` | Run and operate the detached supervisor. |
| `/harness:learning-loop` | Convert useful session lessons into reusable harness improvements. |
| `/harness:update-project` | Back up sanitized host configuration into this repository. |

Planner uses the bundled grilling skill internally; it is not a separate harness
workflow command. A user can still activate an installed grilling skill directly
by asking “grill me.”

```text
idea or existing repository
          ↓
project_specs.xml → feature_list.json → coding → QA → integration → Goal Review
                              ↑          │
                              └── repair ┘
```

## How the workflow runs

1. **Specify:** planner or setup writes one Project Goal and observable,
   dependency-aware Acceptance Checks in `project_specs.xml`.
2. **Reconcile:** generator maps every check to an append-only Work Item in
   `feature_list.json`. Missing mappings block execution.
3. **Claim:** each ready context receives an atomic lease, branch, worktree,
   port, and durable Run State.
4. **Build and inspect:** a coding tool implements the Work Item; independent QA
   exercises the result through a browser or real HTTP boundary.
5. **Repair:** a defect records expected and observed behavior, evidence, and a
   Repair Plan. Three failed coding → QA → integration attempts require input.
6. **Integrate:** passing work merges into current `main`, then the same checks
   run against the combined product.
7. **Review the goal:** after all Work Items integrate, an independent Goal
   Review runs the whole specification. Only its completed Run State and a
   persisted `run_completed` event prove completion.

Multiple generator sessions may claim independent contexts concurrently. A new
session resumes durable state rather than restarting the project.

## Prerequisites

Run the harness on the machine containing the Git repository. It requires:

- [Git](https://git-scm.com/) and [Bash](https://www.gnu.org/software/bash/)
  (Git Bash or WSL on Windows);
- **[Node.js 18 or newer](https://nodejs.org/)**, used by reconciliation, orchestration, setup
  inventory, and the control host;
- one installed and authenticated tool: [Claude Code](https://code.claude.com/docs/en/overview),
  [Codex](https://developers.openai.com/codex/), or [OpenCode](https://opencode.ai/).

```sh
git --version
bash --version
node --version
claude --version  # or: codex --version / opencode --version
```

The installer adds `jq` when it is missing. Omnigent, Tailscale, and additional
plugins are optional.

## Install

macOS, Linux, Git Bash, or WSL:

```sh
curl -sSL https://raw.githubusercontent.com/vinicius91carvalho/harness-engineering/main/install.sh | sh
```

The installer detects available tools and shows one checklist. Keep `harness`
selected; optionally select Omnigent, plugins, MCP servers, shared configuration,
or the status line. Re-running the installer safely refreshes installed content.

Native Windows users can run [`install.ps1`](install.ps1). See the
[installer reference](docs/installer/README.md) for flags, scopes, and dry runs.

### Command names by tool

Claude Code and Codex use plugin names with a colon. OpenCode installs the same
skills as namespaced commands with a hyphen.

| Task | Claude Code / Codex | OpenCode |
| --- | --- | --- |
| Set up existing code | `/harness:setup` | `/harness-setup` |
| Plan new work | `/harness:planner` | `/harness-planner` |
| Build or resume | `/harness:generator` | `/harness-generator` |
| Review the goal | `/harness:evaluator` | `/harness-evaluator` |
| Operate supervisor | `/harness:control-host` | `/harness-control-host` |
| Capture lessons | `/harness:learning-loop` | `/harness-learning-loop` |
| Back up configuration | `/harness:update-project` | `/harness-update-project` |

The examples below use the colon form. Substitute the OpenCode form when needed.

## Start a project

Choose one path after installation.

### New project or new product goal

Run the planner with the behavior you want to deliver:

```text
/harness:planner Build a notes app where a user can publish a note and find it after reloading.
```

Review `project_specs.xml`. Every Acceptance Check should describe an action and
an observable result. Then run:

```text
/harness:generator
```

### Existing codebase

From the Git root, run setup **without a goal, feature, scope, or other text**:

```text
/harness:setup
```

Setup derives scope from the repository. It reads product and architecture docs,
manifests, dependencies, runtime configuration, infrastructure, routes, and
integration adapters. It records material technologies, reports code/docs
contradictions, creates the specification and queue, preserves application files,
and stops before claiming or implementing work.

Review the generated `project_specs.xml`. Setup is complete at this point; it does
not validate every mapped feature and does not require a generator run.

If you want an audit, run generator and select one task, a set, or all:

```text
/harness:generator
```

That opt-in audit uses verify-first mode: coding first exercises the selected
Acceptance Checks against the current product, records already-passing work
without rewriting it, and fixes only failed checks. Independent QA and integrated
verification rerun only the selected work. To add a feature instead, describe it
to planner and then run generator for the new context.

## Files delivered

| Path | Meaning |
| --- | --- |
| `project_specs.xml` | Project Goal, technical direction, and stable Acceptance Checks. |
| `.harness-technology-inventory.json` | Setup evidence for material technologies and documentation contradictions. |
| `feature_list.json` | Dependency-aware execution queue and three proof flags per Work Item. |
| `harness-progress/` | Human-readable journals by work context. |
| `.git/harness-runs/` | Project-namespaced attempts, Run State, and evidence. |
| `.git/harness-control/` | Supervisor state, pending input, and ordered events. |
| `.harness/roles.json` | Optional Omnigent tool/model routing. |
| `.harness/projects.json` | Optional Git-root registry for independently runnable monorepo projects. |

The queue flags are separate proofs:

* `implementation` means coding completed.
* `qa` means isolated QA passed.
* `integration` means the behavior passed after merging.

Dependencies require `integration:true`; the project still requires Goal Review
afterward.

## Monorepos

Run `/harness:setup` once from the Git root. Setup automatically detects
independently runnable or deployable projects, writes `.harness/projects.json`,
asks which projects to initialize, and gives each selected project its own
specification, queue, journals, and Run State. Run later commands from the chosen
project directory. Git locking and integration remain repository-wide.

Advanced users may create or maintain the registry manually before running setup:

```json
{
  "projects": [
    {"id": "web", "path": "apps/web", "description": "Customer application"},
    {"id": "api", "path": "services/api", "description": "HTTP API"}
  ]
}
```

Shared packages do not need registry entries unless they run or deploy
independently.

## Optional Omnigent control and routing

[Omnigent](https://omnigent.ai/) is not required to plan, generate, validate,
integrate, or review work. Without it, the selected Claude Code, Codex, or
OpenCode tool runs the harness directly with its configured model.

When installed, Omnigent can:

- provide a local web/mobile control surface;
- start and observe the harness's detached supervisor;
- **route coding, validation, repair planning, and Goal Review to ordered
  tool/model candidates;**
- relay durable status and Input Requests without creating a second scheduler.

The project-local `.harness/roles.json` enables routing. Although its existing
schema calls the selector `harness`, each value selects a Claude Code, Codex, or
OpenCode tool adapter. Removing the file returns to direct execution.

### Priority and fallback behavior

Each role array is ordered from highest to lowest priority. The next candidate is
tried only after a rate limit, authentication failure, unavailable model, launch
failure, or timeout. A successful QA response that finds a product defect does
not fall through; it enters the Defect Report and Repair Plan loop.

Validation, integrated QA, and Goal Review first prefer a tool different from the
one that actually performed coding. Within the independent and same-tool groups,
the configured order remains stable. Run State and evidence record every selected
route and fallback reason.

The complete example is maintained at:
https://github.com/vinicius91carvalho/harness-engineering/blob/main/omnigent/harness-engineering/roles.example.json

```json
{
  "coding": [
    { "harness": "opencode", "model": "llama.cpp/qwen3.6-35b-a3b" },
    { "harness": "opencode", "model": "openrouter/z-ai/glm-5.2" },
    { "harness": "opencode", "model": "opencode-go/kimi-k2.7-code" },
    { "harness": "claude", "model": "claude-sonnet-5" }
  ],
  "validation": [
    { "harness": "claude", "model": "claude-opus-4-8" },
    { "harness": "codex", "model": "gpt-5.5" },
    { "harness": "opencode", "model": "openrouter/z-ai/glm-5.2" },
    { "harness": "opencode", "model": "llama.cpp/qwen3.6-35b-a3b" }
  ],
  "repairPlanning": [
    { "harness": "codex", "model": "gpt-5.5" },
    { "harness": "claude", "model": "claude-opus-4-8" },
    { "harness": "opencode", "model": "openrouter/z-ai/glm-5.2" },
    { "harness": "opencode", "model": "llama.cpp/qwen3.6-35b-a3b" }
  ],
  "goalReview": [
    { "harness": "claude", "model": "claude-opus-4-8" },
    { "harness": "codex", "model": "gpt-5.5" },
    { "harness": "opencode", "model": "openrouter/z-ai/glm-5.2" },
    { "harness": "opencode", "model": "llama.cpp/qwen3.6-35b-a3b" }
  ]
}
```

Copy it into a project only when using Omnigent routing:

```sh
mkdir -p .harness
cp ~/.omnigent/agents/harness-engineering/roles.example.json .harness/roles.json
```

The example requires the listed providers and models to be available to their
tools. Change or remove candidates that are not configured locally.

### Configure local Qwen through llama-server

Start the requested GGUF with
[llama.cpp](https://github.com/ggml-org/llama.cpp)'s OpenAI-compatible server:

```sh
llama-server \
  -m /path/to/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf \
  --port 8080
```

Merge this provider into the applicable OpenCode configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "llama.cpp": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "llama-server (local)",
      "options": {"baseURL": "http://127.0.0.1:8080/v1"},
      "models": {
        "qwen3.6-35b-a3b": {
          "name": "Qwen3.6 35B A3B Q4_K_XL (local)"
        }
      }
    }
  }
}
```

OpenCode addresses configured models as `provider/model`, which produces the
role ID `llama.cpp/qwen3.6-35b-a3b`. Keep `llama-server` running while the route
is in use. Configure [OpenRouter](https://openrouter.ai/),
[OpenCode Go](https://opencode.ai/docs/go/), and
[Claude Code](https://code.claude.com/docs/en/overview) credentials before
relying on later fallbacks.

### Start or resume through Omnigent

Start Omnigent from the Git root and name the exact project directory:

```sh
cd /path/to/git-root
omni run ~/.omnigent/agents/harness-engineering --harness codex
```

```text
Act as the Control Host for /absolute/path/to/project.
Start or resume the harness. Use the project role file.
Continue until input is needed or a persisted run_completed event exists.
```

Omnigent starts the repository's supervisor; the harness still owns claims,
retries, merges, integrated verification, Goal Review, and completion state.

### Optional private phone access

Install [Tailscale](https://tailscale.com/) on the project machine and phone,
sign both into the same tailnet, then expose only the local Omnigent service:

```sh
OMNIGENT_WS_ALLOWED_ORIGINS=https://YOUR-MACHINE.ts.net \
OMNIGENT_ACCOUNTS_BASE_URL=https://YOUR-MACHINE.ts.net \
  omni server start
tailscale serve https / http://localhost:8000
omni host
```

Open `https://YOUR-MACHINE.ts.net` from the phone. Use `tailscale serve`, not
Funnel, for tailnet-only access. The project machine must remain awake.

## Operate and verify

The installed control script exposes durable status and lifecycle operations:

```sh
CONTROL=~/.config/opencode/skills/harness-control-host/scripts/harness-control.mjs
PROJECT=/absolute/path/to/project

node "$CONTROL" status   --repo "$PROJECT"
node "$CONTROL" capacity --repo "$PROJECT" --host opencode
node "$CONTROL" pause    --repo "$PROJECT"
node "$CONTROL" resume   --repo "$PROJECT"
node "$CONTROL" stop     --repo "$PROJECT"
node "$CONTROL" events   --repo "$PROJECT" --consumer manual-check
```

If a worker blocks, answer its exact Input Request through Omnigent or the
control host's explicit response/resume path. The harness retains the branch,
worktree, evidence, and Repair Plan while waiting.

Completion requires all of the following:

- supervisor `status` is `complete` and `supervisorPid` is `null`;
- every Work Item has `implementation`, `qa`, and `integration` set to `true`;
- Goal Review Run State has `status: complete` and `phase: complete`;
- control events contain `kind: run_completed`.

Useful checks:

```sh
node ~/.config/opencode/skills/harness-generator/reconcile.mjs "$PROJECT" --check
jq 'all(.[]; .implementation and .qa and .integration)' "$PROJECT/feature_list.json"
node "$CONTROL" events --repo "$PROJECT" --consumer manual-check
```

## Maintenance

- **Update:** rerun the installer. It refreshes installed plugins and the optional
  Omnigent bundle idempotently.
- **Inspect:** use control-host `status` and `events`; inspect
  `harness-progress/`, `.git/harness-runs/`, and `.git/harness-control/` when work
  blocks or completion evidence is unclear.
- **Pause or stop safely:** use the control-host commands so child tool processes
  and supervisor state are handled together.
- **Back up host configuration:** run `/harness:update-project`; secrets and
  session data are excluded or replaced with placeholders.
- **Capture repeatable improvements:** run `/harness:learning-loop` after a
  substantial session, not after every small change.

## Documentation

| Guide | Contents |
| --- | --- |
| [Complete setup and operations](https://vinicius91carvalho.github.io/harness-engineering/) | The same end-to-end workflow in a navigable site. |
| [Plugins](docs/plugins.md) | Available integrations and tool compatibility. |
| [Extras](docs/extras.md) | Status line, shared config, and MCP servers. |
| [Installer](docs/installer/README.md) | Tool selection, flags, scopes, and dry runs. |
| [Backup](docs/backup-sync.md) | Portable configuration backup and restore. |
| [Architecture decisions](docs/adr/) | Durable goals, independent QA, and governed workers. |

## Releases

Releases are generated from Conventional Commit subjects pushed to `main`.
See the [release history](https://github.com/vinicius91carvalho/harness-engineering/releases).

Feedback and contributions are welcome through
[issues](https://github.com/vinicius91carvalho/harness-engineering/issues) and pull requests.
