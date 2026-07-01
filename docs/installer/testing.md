# Installer testing

## Automated

```sh
bash tests/install_test.sh
bash tests/orchestrator_test.sh
bash tests/claim_test.sh
sh -n install.sh
bash -n skills/generator/claim.sh scripts/*.sh
jq empty .claude-plugin/*.json .codex-plugin/*.json \
  .agents/plugins/marketplace.json opencode.json config/*.json
```

The fake-CLI tests cover non-TTY host selection, OpenCode detection before its
user install directory reaches `PATH`, Claude-only scope, selected-host command
isolation, zero-write dry runs, catalog policy, retry behavior, and
`feature_list.json` verification. CI runs shell tests on Ubuntu and macOS and
PowerShell parsing/tests on Windows.

## Authenticated smoke tests

Run these only on disposable user profiles after authenticating each real CLI:

1. Install with `--cli <host> --no`; confirm harness is visible and a second run
   changes no unrelated configuration.
2. Run planner, generator, evaluator, learning-loop, and update-project. Confirm
   the configured model is preserved and generator uses an isolated worktree.
3. Select `codebase-memory-mcp`; verify the binary exists, only the selected host
   has an MCP entry, and “Index this project” exposes its tools.
4. Run `--yes --dry-run`; compare the profile tree and config hashes before/after.
5. Install Context7 and Playwright for each host and verify both appear in its MCP list.
6. Install Omnigent and run the bundled agent through an authenticated host; this
   validates the upstream directory-agent parser in addition to local structural
   checks:

   ```sh
   omni run ~/.omnigent/agents/harness-engineering --harness codex --no-session \
     -p "Reply exactly READY without editing files."
   ```

   Confirm the command exits successfully and prints `READY`.

7. For the full check, use a disposable Git repository with one Acceptance
   Check. Route coding to OpenCode and validation, repair planning, and Goal
   Review to Codex. Start Omnigent as the Control Host. The check passes only
   when all three queue flags are `true`, Goal Review is complete, and the
   control event stream contains `run_completed`. The exact commands are in the
   [README recipe](../../README.md#optional-omnigent-routing-and-mobile-control).
