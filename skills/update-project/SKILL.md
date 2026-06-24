---
name: update-project
description: Back up the user's live Claude Code setup into the harness repo — settings, the full plugin roster, and any loose user content — and reconcile README/scripts/docs. Use when the user says "update the harness project", "refresh my config backup", "back up my Claude setup", "sync my Claude config into the repo", or "/harness:update-project".
---

# update-project

Make the harness repo a complete, restorable backup of the user's live Claude
Code setup. Skills, agents, and hooks ship *inside* plugins, so backing up the
plugin roster covers them; the only separately-authored content is loose files
the user added under `~/.claude` directly. Each run:

1. **Settings subset.** Regenerate the committed config backup from live settings:
   ```sh
   bash ${CLAUDE_PLUGIN_ROOT}/scripts/sync-config.sh > config/settings.json
   ```
   This writes only the shareable subset (drops `statusLine`, `enabledPlugins`,
   `extraKnownMarketplaces`, and any absent key). If new shareable keys appeared,
   add them to the filter in `scripts/sync-config.sh`, the README "Shared config"
   row, and the "Enabling by hand" example.

2. **Plugin roster.** Read `enabledPlugins` and `extraKnownMarketplaces` from
   `~/.claude/settings.json`. For every enabled plugin, confirm it is reachable
   from this repo: an entry in `.claude-plugin/marketplace.json` (re-exposing the
   upstream repo from `extraKnownMarketplaces`), a name in `install.sh`
   `REQUIRED`/`OPTIONAL` **and** `install.ps1` `$Required`/`$Optional`, and a row
   in the README Plugins table. For every plugin you add, **ask the user whether
   it's required or optional** before writing it — required plugins install
   unconditionally, optional ones are prompted for. Don't guess; their answer
   decides which `REQUIRED`/`OPTIONAL` (and `$Required`/`$Optional`) list and the
   README "Required?" column value it gets. Flag any enabled plugin you can't map
   to a marketplace source. Don't silently drop plugins the user removed — point
   them out and let them decide.

3. **Loose user content.** Mirror separately-authored content into `config/home/`
   (the installer's `restore_home`/`Restore-Home` copies it back into `~/.claude`
   on a fresh machine), preserving relative paths:
   ```sh
   for p in skills commands agents hooks keybindings.json CLAUDE.md; do
     [ -e "$HOME/.claude/$p" ] && { mkdir -p config/home; cp -R "$HOME/.claude/$p" config/home/; }
   done
   ```
   Skip if none exist (the user may have zero — that's normal; don't create an
   empty `config/home/`). Never copy secrets, history, sessions, or caches
   (`.credentials.json`, `history.jsonl`, `sessions/`, `projects/`, `cache/`).
   Hookify rules under `~/.claude/plugins/data/hookify-*/` can be copied to
   `config/home/hookify-rules/` for safekeeping, but note in your report that
   restoring them is manual — the live path is marketplace/version-specific, so
   `restore_home` does not place them.

4. **Reconcile docs.** Bring `README.md`, `CLAUDE.md`, and any bundled scripts in
   line with what changed (the repo's "keep scripts and README in sync" rule).

5. **Run the tests locally.** Mirror `.github/workflows/ci.yml` so you catch
   failures before pushing:
   ```sh
   jq empty .claude-plugin/marketplace.json .claude-plugin/plugin.json config/settings.json
   sh -n install.sh && bash -n scripts/statusline.sh scripts/sync-config.sh
   bash scripts/statusline.sh --selftest && bash scripts/sync-config.sh --selftest
   grep -q '^name:' skills/update-project/SKILL.md && grep -q '^description:' skills/update-project/SKILL.md
   ```
   Report pass/fail; fix anything that fails before finishing.

6. Report the change as a `git diff --stat` summary. Make no commit unless asked.
