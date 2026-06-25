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

2. **Plugin roster — two-way diff.** Build both sets and reconcile in *both*
   directions; a one-way "is every enabled plugin in the repo?" check misses
   uninstalls.
   - **Live set:** names with `true` in `enabledPlugins` (`~/.claude/settings.json`),
     `@marketplace` suffix stripped. `enabledPlugins` lists only *enabled*
     plugins and optional ones are legitimately absent — so to confirm a real
     uninstall, also check it's gone from `~/.claude/plugins/installed_plugins.json`.
   - **Repo set:** the union of names across `.claude-plugin/marketplace.json`,
     `install.sh` `REQUIRED`/`OPTIONAL`, `install.ps1` `$Required`/`$Optional`,
     and the README Plugins table.

   **Live ∖ Repo (installs to add):** for each, confirm a `marketplace.json`
   entry (re-exposing the upstream repo from `extraKnownMarketplaces`), add the
   name to both installers and a README row. **Ask the user required or optional**
   before writing — their answer picks the `REQUIRED`/`OPTIONAL`
   (`$Required`/`$Optional`) list and the README "Required?" value. Flag any you
   can't map to a marketplace source.

   **Repo ∖ Live (uninstalls to reconcile):** these are plugins removed from the
   live setup. Point each out and **ask whether to remove it from all four sync
   points or keep offering it** — the repo doubles as a marketplace others
   install from, so "I don't use it" ≠ "don't offer it". Never drop one silently;
   never keep one silently.

3. **MCP servers.** Claude Code stores MCP servers in three places — enumerate all:
   - **user scope:** `mcpServers` in `~/.claude.json` (cross-project, part of "my setup").
   - **local scope:** `.projects["<path>"].mcpServers` in `~/.claude.json` (private to one project on this machine).
   - **project scope:** a checked-in `.mcp.json` in a repo (already version-controlled there; nothing to back up).

   Back up the user-scoped servers — plus any local-scoped ones the user wants
   kept — into `config/mcp.json` as a sanitized inventory. **Redact every secret**
   (tokens, API keys, passwords embedded in URLs, `args`, or `env`) to a
   `${PLACEHOLDER}`; the same trust-boundary rule as step 4 — never commit a live
   credential. The installer's "MCP servers" row reads this file and prompts for
   each `${PLACEHOLDER}` at install time (ENTER skips a server), so the
   placeholder names double as the prompt labels — keep them meaningful
   (`${BRIGHTDATA_TOKEN}`, not `${X}`). Skip the file entirely if no MCP servers
   exist. If you add a new server *shape* (stdio with `env`, HTTP headers), sanity
   check `install_mcps`/`Install-Mcps` still resolve its placeholders.

4. **Loose user content.** Mirror separately-authored content into `config/home/`
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

5. **Reconcile docs.** Bring `README.md`, `CLAUDE.md`, and any bundled scripts in
   line with what changed (the repo's "keep scripts and README in sync" rule).

6. **Run the tests locally.** Mirror `.github/workflows/ci.yml` so you catch
   failures before pushing:
   ```sh
   jq empty .claude-plugin/marketplace.json .claude-plugin/plugin.json config/*.json
   sh -n install.sh && bash -n scripts/statusline.sh scripts/sync-config.sh
   bash scripts/statusline.sh --selftest && bash scripts/sync-config.sh --selftest
   grep -q '^name:' skills/update-project/SKILL.md && grep -q '^description:' skills/update-project/SKILL.md
   ```
   Report pass/fail; fix anything that fails before finishing.

7. Report the change as a `git diff --stat` summary. Make no commit unless asked.
