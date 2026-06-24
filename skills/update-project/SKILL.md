---
name: update-project
description: Refresh the harness repo's committed config backup from the live ~/.claude config, and reconcile README/scripts/docs. Use when the user says "update the harness project", "refresh my config backup", "sync my Claude config into the repo", or "/harness:update-project".
---

# update-project

Keep the harness repo in sync with the user's live Claude Code config.

1. Regenerate the committed config backup from live settings:
   ```sh
   bash ${CLAUDE_PLUGIN_ROOT}/scripts/sync-config.sh > config/settings.json
   ```
   This writes only the shareable subset (drops `statusLine`, `enabledPlugins`,
   `extraKnownMarketplaces`, and any absent key).
2. Reconcile `README.md`, `CLAUDE.md`, and any bundled scripts with what changed
   (the repo's "keep scripts and README in sync" rule). If new shareable keys
   appeared, add them to the filter in `scripts/sync-config.sh`, the README
   "Shared config" row, and the "Enabling by hand" example.
3. Report the change as a `git diff --stat` summary. Make no commit unless asked.
