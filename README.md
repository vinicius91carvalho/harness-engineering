<p align="center">
  <img src="assets/banner.svg" alt="harness-engineering" width="660">
</p>

<p align="center">
  <a href="https://github.com/vinicius91carvalho/harness-engineering/releases/latest"><img alt="Version" src="https://img.shields.io/github/v/release/vinicius91carvalho/harness-engineering?sort=semver&label=version&color=2496ED"></a>
  <a href="https://github.com/vinicius91carvalho/harness-engineering"><img alt="AI Harness Engineering System" src="https://img.shields.io/badge/AI%20Harness%20Engineering-System-8A2BE2"></a>
  <a href="https://github.com/vinicius91carvalho/harness-engineering/releases"><img alt="Last update" src="https://img.shields.io/github/release-date/vinicius91carvalho/harness-engineering?label=last%20update&color=2EA44F"></a>
</p>

<p align="center">
  <b>A curated developer workflow for any AI harness.</b>
</p>

> *"YOU SHOULD NOT PASS!"* — on the bad plugins, the boilerplate, and the 3am pages.
>
> *"A wizard is never late, nor is he early — he installs precisely the plugins he means to."*
>
> *"All we have to decide is what to do with the config that is given us."*

## About

> *"Not all those who wander are lost."*

`harness-engineering` is a portable workflow and plugin catalog for **Claude Code**, **OpenCode**, and **Codex**. It combines a spec→build→QA pipeline with compatible integrations such as Ponytail and optional local codebase memory.

It's opinionated but not precious: **feedback, tips, and plugin suggestions are very welcome** — open an [issue](https://github.com/vinicius91carvalho/harness-engineering/issues) or a PR.

# Why does this project exists?

1) Long-running work loses coherence as context fills.
2) Host and model choices should remain user-controlled rather than pinned by the plugin.
3) From "Harness design for long-running application development" by Prithvi Rajasekaran on Anthropic Labs [1]
> "First is that models tend to lose coherence on lengthy tasks as the context window fills."
> "When asked to evaluate work they've produced, agents tend to respond by confidently praising the work—even when, to a human observer, the quality is obviously mediocre."
> "agents still sometimes exhibit poor judgment that impedes their performance while completing the task."

## Setup

> *"When in doubt, always follow your nose."*

On a new machine with any of the supported CLIs installed ([Claude Code](https://claude.com/claude-code), [Opencode](https://opencode.ai), or [Codex](https://github.com/openai/codex)), run:

**macOS / Linux / Windows (Git Bash or WSL)**

```sh
curl -sSL https://raw.githubusercontent.com/vinicius91carvalho/harness-engineering/main/install.sh | sh
```

The installer detects available CLIs. With more than one host, choose with numbers,
arrow keys, or Enter; non-interactive runs must pass `--cli`. Then pick what to
install from a single Space-to-toggle checklist (`a` selects or clears all, Enter
confirms) instead of one prompt per plugin. `--yes` and `--no` control checklist
contents, while `--cli` controls target hosts. Integrations are offered only on
documented hosts, and repeated runs are idempotent. OpenCode is also detected in
its official `~/.opencode/bin` install location before a shell restart updates
`PATH`. MCP secret prompts mask typed and pasted API keys.

For **native Windows**, run [`install.ps1`](install.ps1). It stages the repository
when invoked through a pipe, so it does not depend on `$PSScriptRoot`.

See [Installer behavior](docs/installer/README.md) for `--cli`, `--yes`, `--no`,
strict dry-run behavior, and Claude-only scope flags.

## Framework

> *"It's the job that's never started as takes longest to finish."*

The `harness` plugin bundles a **Spec → Build → QA pipeline**: an autonomous, multi-session workflow that turns a 1–4 sentence idea into a complete spec, scaffolds the project, then implements and independently QA's every feature — looping until each one is both built *and* verified. Build sessions can run **in parallel**, each isolated in its own git worktree. Inspired by Anthropic's [Harness design for long-running application development](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).

### Components

| Invoke | Type | Role |
| --- | --- | --- |
| `/harness:planner` | skill | Guided Q&A that expands an idea into a complete `project_specs.xml` (plan mode). Two modes: **New Project** and **Feature**. |
| `/harness:generator` | skill | The orchestrator. Claims a feature area, builds it in an isolated worktree (coding→QA loop), merges back to `main`. Run it in several sessions at once. |
| `/harness:evaluator` | skill | Independent QA-only sweep over already-implemented features. |
| `initializer` | agent | Scaffolds the project once: `feature_list.json`, `init.sh`, structure, first commit. Idempotent. |
| `coding-agent` | agent | Implements **one** feature in a given worktree/port, verifies it through the real UI, writes spec-style tests. |
| `qa-agent` | agent | Independently QA's **one** feature as a black-box specification. |

### Flow

```
/harness:planner ─► project_specs.xml ─► (human review)
        │
        ▼
/harness:generator   (new session, ×N in parallel)
  ├─ first run: initializer scaffolds main (feature_list.json, init.sh, git)
  ├─ claim a context ─► own worktree + branch + port
  │     └─ per feature:  coding-agent → implement + UI-verify
  │                      qa-agent     → black-box QA
  │                      (verify feature_list.json; stop & ask after retry 3)
  └─ merge gen/<context> ─► main  (serialized)
        │
        ▼
/harness:evaluator   (optional) ─► independent QA sweep across everything
```

`feature_list.json` is the single source of truth: every entry carries `implementation` and `qa` flags, and the pipeline's job is to flip them all to `true`. It's **append-only** — features are never edited or removed, only marked passing, so nothing gets silently dropped.

**Why it holds together:** portable atomic-directory locks coordinate parallel
sessions in the shared git directory. Each claim gets a worktree, branch, and
unique port; merges are serialized. One state machine adapts to `claude -p`,
`codex exec`, or `opencode run`, preserves the configured model, and verifies both
coding and QA from `feature_list.json` rather than trusting agent prose.

## Learning loop

> *"Little by little, one travels far."*

`/harness:learning-loop` is a [hermes-agent](https://github.com/NousResearch/hermes-agent)–style self-improvement loop: **experience → reflect → create artifact → persist → curate**. It uses each host's native question surface and proposes portable automation without forcing a model or hidden memory directory.

| You did this in the session… | …it suggests |
| --- | --- |
| Re-derived a multi-step procedure (esp. more than once) | a **skill** (via `/skill-creator`) |
| Corrected the same behavior repeatedly ("always/never do X") | a **hook** (via `/hookify`) |
| A delegatable, context-heavy investigation | a **subagent** |
| A durable fact about you or the project | a **memory entry** (written to your memory dir) |
| A convention it got wrong | a **CLAUDE.md** addition |

It's an **orchestrator** — the reflection and routing are its job; the actual creation is delegated to the tools above, so it stays small and improves as they do. A built-in **recurrence bar** (act on things that happened ≥2–3× or are clearly going to recur) keeps it from nagging. Durable learnings persist to your existing per-project memory directory + `MEMORY.md`, so the assistant grows across sessions instead of starting cold. Bundled `evals/` (sample session transcripts with planted patterns) verify it via the skill-creator eval harness.

Invocation is manual by default. For hermes-style autonomy, opt in with a `Stop` hook in `~/.claude/settings.json` that nudges you at session end:

```jsonc
"Stop": [{ "hooks": [{ "type": "command",
  "command": "echo 'Run /harness:learning-loop to capture what you learned this session.'" }]}]
```

## Docs

| Doc | What's in it |
| --- | --- |
| [Plugins](docs/plugins.md) | Full list of available plugins with CLI support, namespaces, and descriptions. |
| [Extras](docs/extras.md) | Status line, shared config, MCP servers — what they do and how to enable by hand. |
| [Installer](docs/installer/README.md) | Host selection, checklist flags, dry-run guarantees, and scope. |
| [Installer contracts](docs/installer/contracts.md) | Native host contracts and maintained integration decisions. |
| [Installer testing](docs/installer/testing.md) | Automated and authenticated smoke tests. |
| [Keeping the backup in sync](docs/backup-sync.md) | How `/harness:update-project` backs up your live setup into this repo. |

## Releases

> *"The Road goes ever on and on — and so do the version tags."*

Versions are cut automatically from [Conventional Commits](https://www.conventionalcommits.org) on every push to `main`. Releases synchronize both Claude and Codex manifest versions.

The three most recent versions:

[![latest](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fapi.github.com%2Frepos%2Fvinicius91carvalho%2Fharness-engineering%2Freleases&query=%24%5B0%5D.tag_name&label=latest&color=2496ED)](https://github.com/vinicius91carvalho/harness-engineering/releases)
[![previous](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fapi.github.com%2Frepos%2Fvinicius91carvalho%2Fharness-engineering%2Freleases&query=%24%5B1%5D.tag_name&label=previous&color=8A8A8A)](https://github.com/vinicius91carvalho/harness-engineering/releases)
[![2 ago](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fapi.github.com%2Frepos%2Fvinicius91carvalho%2Fharness-engineering%2Freleases&query=%24%5B2%5D.tag_name&label=2%20ago&color=8A8A8A)](https://github.com/vinicius91carvalho/harness-engineering/releases)

Full notes for every version are on the [Releases page](https://github.com/vinicius91carvalho/harness-engineering/releases).

## References

1 - [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps) by Prithvi Rajasekaran on Anthropic Labs
