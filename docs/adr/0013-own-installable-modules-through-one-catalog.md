# Own installable modules through one catalog

Installable module identity, source root, host support, optionality, scopes, and acquisition policy live in one repository catalog.
Host marketplaces, installer menus, and documentation project from that catalog.
`node scripts/install-reconcile.mjs generate-marketplaces` is the sole write path for the marketplace triad.
Optional bundles such as skill-creator and Crawl4AI have explicit package roots and are never implied by a harness-only install.
Exact projection installs only declared files and removes stale owned files.

External `acquisition.skills` modules (for example hallmark) are not marketplace plugins.
Installers resolve them through `install-reconcile.mjs skills-add-args <id>` and then run `npx skills add`.
Reconcile does not execute network installs itself; it projects the argv contract from the catalog so catalog edits drive installer behavior.
