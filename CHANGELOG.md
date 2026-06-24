# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Versions are tagged automatically from [Conventional Commits](https://www.conventionalcommits.org)
on push to `main` (see `.github/workflows/release.yml`); each tag also gets a
[GitHub Release](https://github.com/vinicius91carvalho/harness-engineering/releases).

## [Unreleased]

## [0.2.0] - 2026-06-24

### Added
- `codex` plugin (optional) re-exposed from [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc),
  wired into the marketplace, both installers, and the README. Used for
  adversarial reviews; configure with `/codex:setup` (requires an OpenAI account).

### Changed
- `/harness:update-project` now asks whether each newly added plugin is required
  or optional instead of guessing, and runs the CI checks locally before finishing.

## [0.1.0] - 2026-06-24

Initial release.

### Added
- Plugin marketplace (`vinicius91carvalho`) plus the in-repo `harness` plugin.
- One-command installers (`install.sh`, `install.ps1`) with required/optional
  plugin prompts, `--yes`/`--no` flags, and `jq` auto-install.
- Bundled `scripts/statusline.sh` (two-line status line) and `scripts/sync-config.sh`
  (shareable config subset extractor), both with `--selftest`.
- Shareable config backup (`config/settings.json`) and loose-content backup
  (`config/home/`) restored by the installer.
- `/harness:update-project` skill — full backup of the live Claude Code setup.
- CI (`ci.yml`) for JSON/shell/selftest/frontmatter validation and semantic
  release (`release.yml`) with version + last-update badges.

[Unreleased]: https://github.com/vinicius91carvalho/harness-engineering/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/vinicius91carvalho/harness-engineering/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/vinicius91carvalho/harness-engineering/releases/tag/v0.1.0
