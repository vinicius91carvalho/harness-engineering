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

The fake-CLI tests cover non-TTY host selection, Claude-only scope, selected-host
command isolation, zero-write dry runs, catalog policy, retry behavior, and
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
5. For Claude, install `remember`, restart, and confirm existing `.remember/`
   content remains intact.
