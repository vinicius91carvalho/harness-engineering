# Installer testing

## Automated

```sh
bash tests/install_test.sh
bash tests/orchestrator_test.sh
bash tests/claim_test.sh
node tests/spec_review_test.mjs
node tests/spec_review_browser_test.mjs  # requires chromium/chrome
sh -n install.sh
bash -n skills/generator/claim.sh scripts/*.sh
jq empty .claude-plugin/*.json .codex-plugin/*.json \
  .agents/plugins/marketplace.json opencode.json config/*.json
```

The fake-CLI tests cover non-TTY host selection, OpenCode detection before its
user install directory reaches `PATH`, Claude-only scope, selected-host command
isolation, zero-write dry runs, catalog policy, retry behavior,
`feature_list.json` verification, and the blocking localhost spec-review submit
flow. CI installs Chromium for the browser E2E on Ubuntu, runs shell tests on
Ubuntu and macOS, and runs PowerShell parsing/tests on Windows.

## Authenticated smoke tests

Run these only on disposable user profiles after authenticating each real CLI:

1. Install with `--cli <host> --no`; confirm harness is visible and a second run
   changes no unrelated configuration.
2. Run planner, generator, evaluator, learning-loop, and update-project. Confirm
   the configured model is preserved and generator uses an isolated worktree.
3. Run `--yes --dry-run`; compare the profile tree and config hashes before/after.
4. Install Playwright for each host and verify it appears in its MCP list.
5. Copy `config/roles.example.json` to `.harness/roles.json` in a disposable repo
   and run the orchestrator with role routing; confirm route history records the
   selected harness/model pairs.
6. For the full check, use a disposable Git repository with one Acceptance
   Check. Route coding to OpenCode and validation, repair planning, and Goal
   Review to Codex via `.harness/roles.json`. Start the supervisor with
   `harness-control.mjs`. The check passes only when all three queue flags are
   `true`, Goal Review is complete, and the control event stream contains
   `run_completed`. The exact commands are in the
   [README guide](../../README.md#optional-role-routing).
